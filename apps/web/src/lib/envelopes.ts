import type { Envelope } from '@cutline/core';
import { create } from 'zustand';
import { api } from './api';

type PeakEnvelope = Pick<Envelope, 'windowSec' | 'peak'>;

interface EnvelopesState {
  projectId: string | null;
  byAsset: Record<string, PeakEnvelope | null>;
  /** assetIds whose envelope was successfully loaded or permanently errored. */
  loaded: Record<string, boolean>;
  /** assetIds whose last fetch failed (eligible for retry). */
  failed: Record<string, boolean>;
  load(projectId: string, assetId: string): Promise<void>;
}

const pending = new Map<string, Promise<void>>();

/** Maximum number of envelope fetches running at the same time. */
const CONCURRENCY = 1;
let active = 0;
const queue: Array<() => void> = [];

function runNext() {
  if (active >= CONCURRENCY || queue.length === 0) return;
  active++;
  const next = queue.shift()!;
  next();
}

export const useEnvelopes = create<EnvelopesState>()((set, get) => ({
  projectId: null,
  byAsset: {},
  loaded: {},
  failed: {},

  load(projectId, assetId) {
    if (get().projectId !== projectId) {
      set({ projectId, byAsset: {}, loaded: {}, failed: {} });
    }
    // Already successfully loaded — skip.
    if (get().loaded[assetId] && !get().failed[assetId]) return Promise.resolve();

    const key = `${projectId}:${assetId}`;
    const existing = pending.get(key);
    if (existing) return existing;

    const task = new Promise<void>((resolve) => {
      queue.push(async () => {
        try {
          const { envelope } = await api.getEnvelope(projectId, assetId);
          if (get().projectId !== projectId) return;
          set((s) => ({
            byAsset: { ...s.byAsset, [assetId]: envelope },
            loaded: { ...s.loaded, [assetId]: true },
            failed: { ...s.failed, [assetId]: false },
          }));
        } catch {
          if (get().projectId !== projectId) return;
          // Mark failed but keep loaded=false so a future load() call can retry.
          set((s) => ({
            byAsset: { ...s.byAsset, [assetId]: null },
            failed: { ...s.failed, [assetId]: true },
          }));
        } finally {
          pending.delete(key);
          active--;
          runNext();
          resolve();
        }
      });
      runNext();
    });

    pending.set(key, task);
    return task;
  },
}));
