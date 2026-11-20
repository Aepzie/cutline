import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  CutlineError,
  findAsset,
  isCutlineError,
  summarizeProject,
  wordsToCues,
  type Origin,
} from '@cutline/core';
import {
  describeLoudness,
  planDucking,
  planLoudness,
  type DuckOptions,
  type LoudnessOptions,
} from '../media/mixing';
import {
  planFillerCut,
  timelineTranscriptSources,
  transcribeTimeline,
} from '../media/timeline-transcript';
import { createMcpServer } from '../mcp/server';
import { log } from '../log';
import type { Services } from '../services';
import { VERSION } from '../version';
import { securityMiddleware } from './security';

const USER: Origin = { kind: 'user', name: 'Editor' };

function sendError(res: Response, err: unknown) {
  if (isCutlineError(err)) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'INVARIANT' ? 500 : 400;
    res.status(status).json({ error: err.toJSON() });
    return;
  }
  log.error('request failed', err);
  res.status(500).json({
    error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
  });
}

type Handler = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((err) => (res.headersSent ? next(err) : sendError(res, err)));
};

const param = (req: Request, name: string): string => String(req.params[name] ?? '');

export interface AppHandle {
  app: express.Express;
  /** Closes all MCP sessions. */
  close(): Promise<void>;
}

export function createApp(services: Services): AppHandle {
  const { config, docs, assets, blobs, exports, ffmpeg, transcriber } = services;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(securityMiddleware(config));

  // ---------------------------------------------------------------- REST API
  const api = express.Router();
  const json = express.json({ limit: '20mb' });

  api.get(
    '/health',
    route(async (_req, res) => {
      const ff = await ffmpeg.detect();
      res.json({
        ok: true,
        name: 'cutline',
        version: VERSION,
        ffmpeg: ff.available ? ff.version : null,
        transcriber: transcriber.id,
        auth: Boolean(config.token),
      });
    }),
  );

  api.get(
    '/projects',
    route(async (_req, res) => {
      res.json({ projects: await docs.list() });
    }),
  );

  api.post(
    '/projects',
    json,
    route(async (req, res) => {
      const body = (req.body ?? {}) as { name?: string; settings?: Record<string, unknown> };
      if (!body.name || typeof body.name !== 'string') {
        throw new CutlineError('INVALID_ARGUMENT', 'A project name is required.');
      }
      const project = await docs.create({ name: body.name.slice(0, 200), settings: body.settings });
      res.status(201).json({ project });
    }),
  );

  api.get(
    '/projects/:id',
    route(async (req, res) => {
      const loaded = await docs.get(param(req, 'id'));
      res.json(
        req.query.summary ? { ...loaded, project: summarizeProject(loaded.project) } : loaded,
      );
    }),
  );

  api.post(
    '/projects/:id/ops',
    json,
    route(async (req, res) => {
      const body = (req.body ?? {}) as { operations?: unknown[]; label?: string };
      if (!Array.isArray(body.operations)) {
        throw new CutlineError('INVALID_ARGUMENT', 'Body must be { operations: Operation[] }.');
      }
      const result = await docs.apply(param(req, 'id'), body.operations, USER, body.label);
      res.json({
        version: result.version,
        summary: result.summary,
        affectedIds: result.affectedIds,
        createdIds: result.createdIds,
        removedIds: result.removedIds,
      });
    }),
  );

  for (const action of ['undo', 'redo'] as const) {
    api.post(
      `/projects/:id/${action}`,
      route(async (req, res) => {
        const r = await docs[action](param(req, 'id'), USER);
        res.json({ version: r.version, summary: r.summary, history: r.history });
      }),
    );
  }

  // Same pipeline as the MCP add_captions tool with fromTranscript=true.
  api.post(
    '/projects/:id/captions/auto',
    json,
    route(async (req, res) => {
      const id = param(req, 'id');
      const body = (req.body ?? {}) as { language?: string; maxChars?: number };
      const activityId = randomUUID();
      const report = (status: 'started' | 'progress' | 'finished' | 'failed', message: string) =>
        docs.activity({
          projectId: id,
          id: activityId,
          origin: USER,
          tool: 'add_captions',
          status,
          message,
          at: new Date().toISOString(),
        });
      report('started', 'Transcribing the timeline audio…');
      let words;
      try {
        words = await transcribeTimeline(services, id, {
          language: body.language,
          progress: { update: (_f, message) => report('progress', message) },
        });
      } catch (err) {
        report('failed', 'Transcription failed.');
        throw err;
      }
      if (words.length === 0) {
        report('failed', 'No speech found.');
        throw new CutlineError('INVALID_OPERATION', 'No speech found in the timeline audio.');
      }
      const cues = wordsToCues(words, { maxChars: body.maxChars });
      const result = await docs.apply(
        id,
        [{ type: 'add_captions', cues }],
        USER,
        `Add ${cues.length} captions`,
      );
      report('finished', result.summary);
      res.json({ summary: result.summary, cueCount: cues.length, version: result.version });
    }),
  );

  // Same pipelines as the MCP duck_music / normalize_loudness tools.
  api.post(
    '/projects/:id/audio/duck',
    json,
    route(async (req, res) => {
      const id = param(req, 'id');
      const body = (req.body ?? {}) as DuckOptions;
      const plan = await planDucking(services, id, {
        musicTrackId: typeof body.musicTrackId === 'string' ? body.musicTrackId : undefined,
        voiceTrackId: typeof body.voiceTrackId === 'string' ? body.voiceTrackId : undefined,
        amountDb: typeof body.amountDb === 'number' ? body.amountDb : undefined,
      });
      const result = await docs.apply(id, [plan.operation], USER, 'Duck music under speech');
      res.json({ summary: result.summary, version: result.version, source: plan.source });
    }),
  );

  api.post(
    '/projects/:id/audio/normalize',
    json,
    route(async (req, res) => {
      const id = param(req, 'id');
      const body = (req.body ?? {}) as LoudnessOptions;
      const plan = await planLoudness(services, id, {
        clipIds: Array.isArray(body.clipIds) ? body.clipIds.map(String) : undefined,
        trackId: typeof body.trackId === 'string' ? body.trackId : undefined,
        target: typeof body.target === 'number' ? body.target : undefined,
      });
      const summary = describeLoudness(plan);
      if (plan.operations.length === 0) {
        throw new CutlineError('INVALID_OPERATION', 'The selected audio is silent.');
      }
      const result = await docs.apply(id, plan.operations, USER, 'Normalize loudness');
      res.json({ summary, version: result.version, clips: plan.clips });
    }),
  );

  // Same pipeline as the MCP remove_filler_words tool.
  api.post(
    '/projects/:id/fillers/remove',
    json,
    route(async (req, res) => {
      const id = param(req, 'id');
      const body = (req.body ?? {}) as { language?: string; repeats?: boolean; dryRun?: boolean };
      const activityId = randomUUID();
      const report = (status: 'started' | 'progress' | 'finished' | 'failed', message: string) =>
        docs.activity({
          projectId: id,
          id: activityId,
          origin: USER,
          tool: 'remove_filler_words',
          status,
          message,
          at: new Date().toISOString(),
        });
      report('started', 'Transcribing the timeline audio…');
      let words;
      try {
        words = await transcribeTimeline(services, id, {
          language: typeof body.language === 'string' ? body.language : undefined,
          progress: { update: (_f, message) => report('progress', message) },
        });
      } catch (err) {
        report('failed', 'Transcription failed.');
        throw err;
      }
      const plan = planFillerCut(words, { repeats: body.repeats === true });
      const payload = { found: plan.found, ranges: plan.ranges, removedDuration: plan.removed };
      if (plan.ranges.length === 0 || body.dryRun === true) {
        const summary = plan.ranges.length
          ? `Would remove ${plan.found.length} filler word(s) (${plan.removed}s).`
          : 'No filler words found.';
        report('finished', summary);
        res.json({ summary, ...payload });
        return;
      }
      const result = await docs.apply(
        id,
        [{ type: 'delete_range', ranges: plan.ranges }],
        USER,
        `Remove ${plan.found.length} filler word(s)`,
      );
      const summary = `Removed ${plan.found.length} filler word(s) (${plan.removed}s).`;
      report('finished', summary);
      res.json({ summary, ...payload, version: result.version });
    }),
  );

  // ------------------------------------------------- chat with Claude (in-editor)
  // Same security middleware as every other route. The Anthropic key stays on the server.
  api.get(
    '/projects/:id/chat',
    route(async (req, res) => {
      const id = param(req, 'id');
      await docs.get(id);
      res.json({
        ...services.chat.status(),
        running: services.chat.isRunning(id),
        events: services.chat.events(id),
      });
    }),
  );

  // Streams the reply as server-sent events: one JSON ChatEvent per `data:` line.
  api.post(
    '/projects/:id/chat',
    json,
    route(async (req, res) => {
      const id = param(req, 'id');
      await docs.get(id);
      const texts = services.chat.prepare(id, req.body);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.flushHeaders();
      // Closing the stream (navigating away, fetch aborted) stops the reply.
      res.on('close', () => {
        if (!res.writableEnded) services.chat.cancel(id);
      });
      await services.chat.send(id, texts, (event) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      res.end();
    }),
  );

  api.post(
    '/projects/:id/chat/cancel',
    route(async (req, res) => {
      res.json({ cancelled: services.chat.cancel(param(req, 'id')) });
    }),
  );

  // "New chat"
  api.delete(
    '/projects/:id/chat',
    route(async (req, res) => {
      await services.chat.reset(param(req, 'id'));
      res.json({ ok: true });
    }),
  );

  // The editor's transcript panel: per-asset words (re-mapped client-side after every edit).
  // transcribe=false only returns cached transcripts; true runs Whisper for the missing ones.
  api.post(
    '/projects/:id/transcript',
    json,
    route(async (req, res) => {
      const id = param(req, 'id');
      const body = (req.body ?? {}) as { transcribe?: boolean };
      if (body.transcribe !== true) {
        res.json(await timelineTranscriptSources(services, id));
        return;
      }
      const activityId = randomUUID();
      const report = (status: 'started' | 'progress' | 'finished' | 'failed', message: string) =>
        docs.activity({
          projectId: id,
          id: activityId,
          origin: USER,
          tool: 'get_transcript',
          status,
          message,
          at: new Date().toISOString(),
        });
      report('started', 'Transcribing the timeline audio…');
      try {
        const sources = await timelineTranscriptSources(services, id, {
          transcribe: true,
          progress: { update: (_f, message) => report('progress', message) },
        });
        report('finished', `Transcription finished (${sources.words.length} words).`);
        res.json(sources);
      } catch (err) {
        report('failed', 'Transcription failed.');
        throw err;
      }
    }),
  );

  // Raw upload: body is the file; name via ?name= or X-File-Name.
  api.post(
    '/projects/:id/assets',
    route(async (req, res) => {
      const name =
        (typeof req.query.name === 'string' && req.query.name) ||
        decodeURIComponent(String(req.headers['x-file-name'] ?? '')) ||
        'upload';
      const asset = await assets.importFromStream(param(req, 'id'), req, name, USER);
      res.status(201).json({ asset });
    }),
  );

  api.get(
    '/projects/:id/assets/:assetId/file',
    route(async (req, res) => {
      const { project } = await docs.get(param(req, 'id'));
      const asset = project.assets.find((a) => a.id === param(req, 'assetId'));
      if (!asset) throw new CutlineError('NOT_FOUND', 'Asset not found.');
      const path = await blobs.localPath(asset.src);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.type(asset.mimeType);
      // sendFile implements HTTP Range requests (needed for seeking in the browser).
      res.sendFile(resolve(path), { acceptRanges: true, dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) sendError(res, err);
      });
    }),
  );

  // Beat grid of an asset in source time: GET returns an earlier result (or null), POST analyses.
  const beatAsset = async (req: Request) =>
    findAsset((await docs.get(param(req, 'id'))).project, param(req, 'assetId'));
  api.get(
    '/projects/:id/assets/:assetId/beats',
    route(async (req, res) => {
      res.json({ beats: await services.analysis.cachedBeats(await beatAsset(req)) });
    }),
  );
  api.post(
    '/projects/:id/assets/:assetId/beats',
    route(async (req, res) => {
      res.json({ beats: await services.analysis.beats(await beatAsset(req)) });
    }),
  );

  // Source-time RMS/peak envelope; computed lazily and cached by AnalysisService.
  api.get(
    '/projects/:id/assets/:assetId/envelope',
    route(async (req, res) => {
      const asset = findAsset((await docs.get(param(req, 'id'))).project, param(req, 'assetId'));
      const full = await services.analysis.envelope(asset);
      // Only peak is needed for waveform rendering; omitting rms halves payload size.
      const envelope = { windowSec: full.windowSec, peak: full.peak };
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.json({ envelope });
    }),
  );

  api.get(
    '/projects/:id/exports',
    route(async (req, res) => {
      res.json({ exports: await exports.list(param(req, 'id')) });
    }),
  );

  api.post(
    '/projects/:id/exports',
    json,
    route(async (req, res) => {
      const body = (req.body ?? {}) as { quality?: 'draft' | 'standard' | 'high'; width?: number };
      const { job } = await exports.begin(
        param(req, 'id'),
        { quality: body.quality, width: body.width },
        USER,
      );
      res.status(202).json({ job });
    }),
  );

  api.get(
    '/jobs/:jobId',
    route(async (req, res) => {
      const job = exports.get(param(req, 'jobId'));
      if (!job) throw new CutlineError('NOT_FOUND', 'Job not found.');
      res.json({ job });
    }),
  );

  api.get(
    '/projects/:id/exports/:file',
    route(async (req, res) => {
      const file = param(req, 'file');
      if (!/^[\w.-]+\.mp4$/.test(file))
        throw new CutlineError('INVALID_ARGUMENT', 'Invalid file name.');
      const key = `exports/${param(req, 'id')}/${file}`;
      if (!(await blobs.stat(key))) throw new CutlineError('NOT_FOUND', 'Export not found.');
      const download = req.query.download !== undefined;
      res.type('video/mp4');
      if (download) res.attachment(file);
      res.sendFile(await blobs.localPath(key), { acceptRanges: true, dotfiles: 'allow' });
    }),
  );

  app.use('/api', api);

  // ------------------------------------------------------------- MCP (HTTP)
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const lastSeen = new Map<string, number>();
  const mcpJson = express.json({ limit: '50mb' });
  // Many clients never send DELETE /mcp; close sessions that have been idle for a while.
  const IDLE_MS = 30 * 60 * 1000;
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, seen] of lastSeen) {
      if (seen < cutoff) {
        lastSeen.delete(id);
        void sessions.get(id)?.close();
      }
    }
  }, 60_000);
  sweeper.unref();
  const touch = (sid: unknown) => typeof sid === 'string' && lastSeen.set(sid, Date.now());

  app.post(
    '/mcp',
    mcpJson,
    route(async (req, res) => {
      const sid = req.headers['mcp-session-id'];
      let transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
      if (!transport) {
        if (sid) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unknown MCP session; reinitialize.' },
            id: null,
          });
          return;
        }
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad request: send initialize first.' },
            id: null,
          });
          return;
        }
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, created);
            touch(id);
          },
        });
        created.onclose = () => {
          if (created.sessionId) {
            sessions.delete(created.sessionId);
            lastSeen.delete(created.sessionId);
            services.presence.leave(created.sessionId);
          }
        };
        const server = createMcpServer(services, {
          get id() {
            return created.sessionId ?? 'pending';
          },
        });
        await server.connect(created);
        transport = created;
      }
      touch(sid);
      await transport.handleRequest(req, res, req.body);
    }),
  );

  const sessionRequest = route(async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    const transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (!transport) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unknown MCP session.' },
        id: null,
      });
      return;
    }
    touch(sid);
    await transport.handleRequest(req, res);
  });
  app.get('/mcp', sessionRequest);
  app.delete('/mcp', sessionRequest);

  // ---------------------------------------------------------- static web app
  const dist = config.webDistDir ? resolve(config.webDistDir) : null;
  if (dist && existsSync(join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    // SPA fallback for client routes (not for API paths or missing files like /assets/x.js).
    app.get(/^(?!\/(api|mcp|ws)(\/|$))(?!.*\.\w+$).*/, (_req, res) => {
      res.sendFile(join(dist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .type('text/plain')
        .send(
          `Cutline server ${VERSION}\n\nEditor (dev): ${config.publicUrl}\nMCP endpoint: http://${config.host}:${config.port}/mcp\n`,
        );
    });
  }

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    sendError(res, err);
  });

  return {
    app,
    async close() {
      clearInterval(sweeper);
      await services.chat.close();
      await Promise.all([...sessions.values()].map((t) => t.close().catch(() => undefined)));
      sessions.clear();
    },
  };
}
