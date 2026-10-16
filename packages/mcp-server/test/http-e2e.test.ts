import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PatchMessage, ServerMessage } from '@cutline/core';
import { startServer, type RunningServer } from '../src/server';
import { StaticTranscriber } from '../src/media/transcribe';
import {
  FFMPEG,
  FFPROBE,
  FIXTURES,
  ffprobe,
  fixture,
  hasFfmpeg,
  hasFixtures,
  tempDir,
} from './helpers';

let server: RunningServer;
let client: Client;

async function tool(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
  return r.structuredContent as Record<string, unknown>;
}

function rawGet(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
    (resolve, reject) => {
      const req = request(`${server.url}${path}`, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      req.on('error', reject);
      req.end();
    },
  );
}

beforeAll(async () => {
  const dataDir = await tempDir();
  server = await startServer(
    { port: 0, dataDir, mediaRoots: [FIXTURES, dataDir], ffmpegPath: FFMPEG, ffprobePath: FFPROBE },
    {
      transcriber: new StaticTranscriber([
        { text: 'Hi', start: 0.1, end: 0.5 },
        { text: 'um…', start: 0.7, end: 0.9 },
      ]),
    },
  );
  client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
});

describe('HTTP server', () => {
  it('reports health and blocks foreign Host headers', async () => {
    const health = await rawGet('/api/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body.toString())).toMatchObject({ ok: true, name: 'cutline' });
    const evil = await rawGet('/api/projects', { host: 'evil.example.com' });
    expect(evil.status).toBe(403);
    const origin = await rawGet('/api/projects', { origin: 'https://evil.example.com' });
    expect(origin.status).toBe(403);
  });
});

describe.runIf(hasFfmpeg && hasFixtures)('MCP over Streamable HTTP + live sync', () => {
  it('builds a project while a browser watches, then exports an MP4', async () => {
    const { projectId } = (await tool('create_project', {
      name: 'E2E',
      width: 640,
      height: 360,
    })) as { projectId: string };

    // A "browser" subscribes over WebSocket.
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws`);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'subscribe', projectId, clientName: 'Test browser' }));
    await expect.poll(() => messages.some((m) => m.type === 'snapshot')).toBe(true);

    const asset = (await tool('add_asset', { path: fixture('testsrc-5s.mp4') })).asset as {
      id: string;
    };
    const image = (await tool('add_asset', { path: fixture('still.png') })).asset as { id: string };
    const music = (await tool('add_asset', { path: fixture('tone-3s.wav') })).asset as {
      id: string;
    };
    const clip = (await tool('add_clip', { assetId: asset.id })) as { clipId: string };
    await tool('add_clip', {
      assetId: image.id,
      start: 1,
      duration: 2,
      transform: { x: 200, y: -100, scale: 0.3 },
    });
    await tool('add_clip', { assetId: music.id, volume: 0.3 });
    await tool('split_clip', { clipId: clip.clipId, time: 2.5 });
    await tool('add_text_overlay', { text: 'Made by an agent', start: 0.5, duration: 3 });
    await tool('add_captions', { fromTranscript: true });

    await expect
      .poll(() => messages.filter((m) => m.type === 'patch').length)
      .toBeGreaterThanOrEqual(8);
    const patches = messages.filter((m): m is PatchMessage => m.type === 'patch');
    expect(patches.every((p) => p.origin.kind === 'agent' && p.origin.name === 'e2e-agent')).toBe(
      true,
    );
    expect(patches.at(-1)!.affectedIds.length).toBeGreaterThan(0);
    expect(
      messages.some((m) => m.type === 'presence' && m.participants.some((p) => p.kind === 'agent')),
    ).toBe(true);

    // The browser edits too: the agent sees the result.
    ws.send(
      JSON.stringify({
        type: 'ops',
        requestId: 'r1',
        projectId,
        operations: [{ type: 'update_project', name: 'Edited by human' }],
      }),
    );
    await expect
      .poll(() => messages.some((m) => m.type === 'ack' && m.requestId === 'r1' && m.ok))
      .toBe(true);
    const project = await tool('get_project');
    expect((project.project as { name: string }).name).toBe('Edited by human');

    // Assets are served with Range support for the browser engine.
    const range = await rawGet(`/api/projects/${projectId}/assets/${asset.id}/file`, {
      range: 'bytes=0-99',
    });
    expect(range.status).toBe(206);
    expect(range.body.length).toBe(100);

    // Beat grids: GET only returns earlier results, POST analyses and caches.
    const beatsUrl = `${server.url}/api/projects/${projectId}/assets/${music.id}/beats`;
    expect(await (await fetch(beatsUrl)).json()).toEqual({ beats: null });
    const analysed = (await (await fetch(beatsUrl, { method: 'POST' })).json()) as {
      beats: { duration: number };
    };
    expect(analysed.beats.duration).toBeCloseTo(3, 1);
    expect(await (await fetch(beatsUrl)).json()).toEqual(analysed);
    const imageBeats = await fetch(beatsUrl.replace(music.id, image.id));
    expect(await imageBeats.json()).toEqual({ beats: null });

    const envelopeUrl = `${server.url}/api/projects/${projectId}/assets/${music.id}/envelope`;
    const envelopeResponse = await fetch(envelopeUrl);
    expect(envelopeResponse.status).toBe(200);
    const analysedEnvelope = (await envelopeResponse.json()) as {
      envelope: { windowSec: number; peak: number[] };
    };
    expect(analysedEnvelope.envelope.windowSec).toBeCloseTo(0.01, 3);
    expect(analysedEnvelope.envelope.peak.length).toBeGreaterThan(0);
    expect(await (await fetch(envelopeUrl)).json()).toEqual(analysedEnvelope);

    const imageEnvelope = await fetch(envelopeUrl.replace(music.id, image.id));
    expect(await imageEnvelope.json()).toEqual({ envelope: { windowSec: 0.01, peak: [] } });
    const missingEnvelope = await fetch(envelopeUrl.replace(music.id, 'missing_asset'));
    expect(missingEnvelope.status).toBe(404);

    const exported = await tool('export_video', { quality: 'draft' });
    expect(exported.url).toMatch(/\/api\/projects\/.+\/exports\/.+\.mp4$/);
    expect(
      messages.some(
        (m) => m.type === 'activity' && m.tool === 'export_video' && m.status === 'finished',
      ),
    ).toBe(true);
    const info = ffprobe(String(exported.path));
    expect(info.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);
    expect(info.streams.find((s) => s.codec_type === 'video')).toMatchObject({
      width: 640,
      height: 360,
    });
    expect(Number(info.format.duration)).toBeCloseTo(5, 0);

    const download = await rawGet(new URL(String(exported.url)).pathname);
    expect(download.status).toBe(200);
    expect(download.body.length).toBe(exported.sizeBytes);

    // The editor's "Remove fillers" button: dry run, then one undoable cut.
    const removeFillers = async (body: Record<string, unknown>) => {
      const res = await fetch(`${server.url}/api/projects/${projectId}/fillers/remove`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { summary: string; removedDuration: number; version?: number };
    };
    const preview = await removeFillers({ dryRun: true });
    expect(preview.summary).toBe('Would remove 1 filler word(s) (0.3s).');
    expect(preview.version).toBeUndefined();
    const removed = await removeFillers({});
    expect(removed.summary).toBe('Removed 1 filler word(s) (0.3s).');
    expect(removed.version).toBeGreaterThan(0);
    expect((await removeFillers({})).summary).toBe('No filler words found.');
    expect(
      messages.some(
        (m) => m.type === 'activity' && m.tool === 'remove_filler_words' && m.status === 'finished',
      ),
    ).toBe(true);

    // The editor's transcript panel: per-asset words, cached-only unless transcribe=true.
    type Sources = {
      byAsset: Record<string, Array<{ text: string }>>;
      missing: string[];
      words: Array<{ text: string; start: number }>;
    };
    const transcript = async (body: Record<string, unknown>) => {
      const res = await fetch(`${server.url}/api/projects/${projectId}/transcript`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Sources;
    };
    const full = await transcript({ transcribe: true });
    expect(full.missing).toEqual([]);
    expect(full.words.length).toBeGreaterThan(0);
    expect(Object.keys(full.byAsset).length).toBeGreaterThan(0);
    expect(await transcript({})).toEqual(full);
    expect(
      messages.some(
        (m) => m.type === 'activity' && m.tool === 'get_transcript' && m.status === 'finished',
      ),
    ).toBe(true);
    ws.close();
  }, 120_000);
});
