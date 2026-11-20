import type { Asset, CutlineErrorJSON, Envelope, HistoryInfo, Project, Word } from '@cutline/core';

const TOKEN_KEY = 'cutline.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable (private mode): token lives for this page only
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: CutlineErrorJSON,
  ) {
    super(body.hint ? `${body.message} ${body.hint}` : body.message);
  }
}

/** Appends ?token= for URLs the browser loads directly (media, downloads, WebSocket). */
export function withToken(url: string): string {
  const token = getToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const body = (data as { error?: CutlineErrorJSON } | null)?.error ?? {
      code: 'INVARIANT',
      message: `HTTP ${res.status}`,
    };
    throw new ApiError(res.status, body as CutlineErrorJSON);
  }
  return data as T;
}

export interface ProjectListItem {
  id: string;
  name: string;
  updatedAt: string;
  duration: number;
  assetCount: number;
  clipCount: number;
}

export interface Health {
  ok: boolean;
  version: string;
  ffmpeg: string | null;
  transcriber: string;
  auth: boolean;
}

export interface ExportJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  progress: number;
  url?: string;
  fileName?: string;
  error?: string;
}

/** Tempo and beat times of an asset, in source seconds. */
export interface BeatInfo {
  bpm: number;
  confidence: number;
  beats: number[];
  downbeats?: number[];
  duration: number;
}

export const api = {
  health: () => request<Health>('/api/health'),
  listProjects: () => request<{ projects: ProjectListItem[] }>('/api/projects'),
  createProject: (name: string, settings?: Partial<Project['settings']>) =>
    request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, settings }),
    }),
  getProject: (id: string) =>
    request<{ project: Project; version: number; history: HistoryInfo }>(`/api/projects/${id}`),
  upload: async (projectId: string, file: Blob, name: string, onProgress?: (p: number) => void) => {
    // XHR for upload progress (fetch has no upload progress events).
    return new Promise<{ asset: Asset }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/projects/${projectId}/assets?name=${encodeURIComponent(name)}`);
      const token = getToken();
      if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        const data = JSON.parse(xhr.responseText || '{}') as {
          asset?: Asset;
          error?: CutlineErrorJSON;
        };
        if (xhr.status >= 200 && xhr.status < 300 && data.asset) resolve({ asset: data.asset });
        else
          reject(
            new ApiError(
              xhr.status,
              data.error ?? { code: 'INVARIANT', message: `HTTP ${xhr.status}` },
            ),
          );
      };
      xhr.onerror = () => reject(new Error('Upload failed (network error).'));
      xhr.send(file);
    });
  },
  startExport: (projectId: string, quality: 'draft' | 'standard' | 'high') =>
    request<{ job: ExportJob }>(`/api/projects/${projectId}/exports`, {
      method: 'POST',
      body: JSON.stringify({ quality }),
    }),
  job: (id: string) => request<{ job: ExportJob }>(`/api/jobs/${id}`),
  listExports: (projectId: string) =>
    request<{ exports: Array<{ fileName: string; url: string; sizeBytes: number }> }>(
      `/api/projects/${projectId}/exports`,
    ),
  /** Loudness envelope for an asset (peak only); computed once then served from the server cache. */
  getEnvelope: (projectId: string, assetId: string) =>
    request<{ envelope: Pick<Envelope, 'windowSec' | 'peak'> }>(
      `/api/projects/${projectId}/assets/${assetId}/envelope`,
    ),
  /** Beat grid computed earlier (null if never analysed). */
  getBeats: (projectId: string, assetId: string) =>
    request<{ beats: BeatInfo | null }>(`/api/projects/${projectId}/assets/${assetId}/beats`),
  detectBeats: (projectId: string, assetId: string) =>
    request<{ beats: BeatInfo }>(`/api/projects/${projectId}/assets/${assetId}/beats`, {
      method: 'POST',
    }),
  autoCaptions: (projectId: string, language?: string) =>
    request<{ summary: string; cueCount: number }>(`/api/projects/${projectId}/captions/auto`, {
      method: 'POST',
      body: JSON.stringify({ language }),
    }),
  removeFillers: (projectId: string, options: { dryRun?: boolean; repeats?: boolean } = {}) =>
    request<{
      summary: string;
      found: Array<{ text: string; start: number; end: number }>;
      removedDuration: number;
    }>(`/api/projects/${projectId}/fillers/remove`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  /** Per-asset transcripts (source time); transcribe=true runs Whisper for missing ones. */
  transcript: (projectId: string, transcribe = false) =>
    request<{
      byAsset: Record<string, Word[]>;
      missing: string[];
      words: Word[];
    }>(`/api/projects/${projectId}/transcript`, {
      method: 'POST',
      body: JSON.stringify({ transcribe }),
    }),
  duckMusic: (projectId: string, musicTrackId: string) =>
    request<{ summary: string }>(`/api/projects/${projectId}/audio/duck`, {
      method: 'POST',
      body: JSON.stringify({ musicTrackId }),
    }),
  normalizeLoudness: (projectId: string, clipIds: string[]) =>
    request<{ summary: string }>(`/api/projects/${projectId}/audio/normalize`, {
      method: 'POST',
      body: JSON.stringify({ clipIds }),
    }),
};

export function assetUrl(projectId: string, asset: Pick<Asset, 'id'>): string {
  return withToken(
    new URL(`/api/projects/${projectId}/assets/${asset.id}/file`, location.href).href,
  );
}
