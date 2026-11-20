import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api module before importing the store.
vi.mock('@/lib/api', () => ({
  api: {
    getEnvelope: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { useEnvelopes } from '@/lib/envelopes';

const mockGetEnvelope = vi.mocked(api.getEnvelope);

const ENVELOPE = { windowSec: 0.01, peak: [0.1, 0.5, 0.9] };

function resetStore() {
  // Reset to initial state between tests.
  useEnvelopes.setState({ projectId: null, byAsset: {}, loaded: {}, failed: {} });
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

afterEach(() => {
  resetStore();
});

describe('useEnvelopes', () => {
  it('loads an envelope and stores it by assetId', async () => {
    mockGetEnvelope.mockResolvedValueOnce({ envelope: ENVELOPE });

    await useEnvelopes.getState().load('proj1', 'asset1');

    const state = useEnvelopes.getState();
    expect(state.byAsset['asset1']).toEqual(ENVELOPE);
    expect(state.loaded['asset1']).toBe(true);
    expect(state.failed['asset1']).toBe(false);
    expect(mockGetEnvelope).toHaveBeenCalledTimes(1);
    expect(mockGetEnvelope).toHaveBeenCalledWith('proj1', 'asset1');
  });

  it('deduplicates concurrent loads for the same asset', async () => {
    mockGetEnvelope.mockResolvedValueOnce({ envelope: ENVELOPE });

    // Fire two loads simultaneously — only one fetch should happen.
    await Promise.all([
      useEnvelopes.getState().load('proj1', 'asset1'),
      useEnvelopes.getState().load('proj1', 'asset1'),
    ]);

    expect(mockGetEnvelope).toHaveBeenCalledTimes(1);
  });

  it('skips a second load once the asset is successfully loaded', async () => {
    mockGetEnvelope.mockResolvedValue({ envelope: ENVELOPE });

    await useEnvelopes.getState().load('proj1', 'asset1');
    await useEnvelopes.getState().load('proj1', 'asset1');

    expect(mockGetEnvelope).toHaveBeenCalledTimes(1);
  });

  it('marks failed loads as retryable (does not set loaded=true on error)', async () => {
    mockGetEnvelope.mockRejectedValueOnce(new Error('network error'));

    await useEnvelopes.getState().load('proj1', 'asset1');

    const state = useEnvelopes.getState();
    expect(state.byAsset['asset1']).toBeNull();
    expect(state.failed['asset1']).toBe(true);
    // loaded must stay falsy so the next call can retry.
    expect(state.loaded['asset1']).toBeFalsy();
  });

  it('retries a previously failed load', async () => {
    mockGetEnvelope
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ envelope: ENVELOPE });

    await useEnvelopes.getState().load('proj1', 'asset1');
    // First attempt failed — now retry.
    await useEnvelopes.getState().load('proj1', 'asset1');

    expect(mockGetEnvelope).toHaveBeenCalledTimes(2);
    const state = useEnvelopes.getState();
    expect(state.byAsset['asset1']).toEqual(ENVELOPE);
    expect(state.failed['asset1']).toBe(false);
  });

  it('resets state when the project changes', async () => {
    mockGetEnvelope.mockResolvedValue({ envelope: ENVELOPE });

    await useEnvelopes.getState().load('proj1', 'asset1');
    expect(useEnvelopes.getState().byAsset['asset1']).toEqual(ENVELOPE);

    // Switch to a different project.
    mockGetEnvelope.mockResolvedValueOnce({ envelope: { windowSec: 0.01, peak: [0.2] } });
    await useEnvelopes.getState().load('proj2', 'asset2');

    const state = useEnvelopes.getState();
    expect(state.projectId).toBe('proj2');
    // Previous project's envelope must be gone.
    expect(state.byAsset['asset1']).toBeUndefined();
    expect(state.byAsset['asset2']).toEqual({ windowSec: 0.01, peak: [0.2] });
  });

  it('serialises concurrent loads via the concurrency queue', async () => {
    const order: string[] = [];
    mockGetEnvelope
      .mockImplementationOnce(async () => {
        order.push('asset1-start');
        await Promise.resolve();
        order.push('asset1-end');
        return { envelope: ENVELOPE };
      })
      .mockImplementationOnce(async () => {
        order.push('asset2-start');
        await Promise.resolve();
        order.push('asset2-end');
        return { envelope: ENVELOPE };
      });

    // Kick off both loads without awaiting — the queue allows only 1 at a time.
    const p1 = useEnvelopes.getState().load('proj1', 'asset1');
    const p2 = useEnvelopes.getState().load('proj1', 'asset2');
    await Promise.all([p1, p2]);

    // asset2 must start only after asset1 ends.
    expect(order.indexOf('asset1-end')).toBeLessThan(order.indexOf('asset2-start'));
  });
});
