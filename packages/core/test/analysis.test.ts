import { describe, expect, it } from 'vitest';
import {
  assetUsage,
  computeEnvelope,
  detectSilences,
  envelopeDuration,
  mapSourceRangeToTimeline,
  mapWordsToTimeline,
  summarizeProject,
  summarizeWaveform,
  timelineEnvelope,
  toDb,
  unionRanges,
  wordsToCues,
  type Envelope,
  type Project,
} from '../src';
import { baseProject, run } from './helpers';

/** 1 kHz "audio": loud for [0,2), silent [2,3), loud [3,5). */
function beepSamples(rate = 1000): Float32Array {
  const out = new Float32Array(rate * 5);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    out[i] = t >= 2 && t < 3 ? 0 : 0.5 * Math.sin(i);
  }
  return out;
}

describe('envelopes and silence', () => {
  it('computes RMS/peak envelopes', () => {
    const env = computeEnvelope(beepSamples(), 1000, 0.1);
    expect(env.rms).toHaveLength(50);
    expect(envelopeDuration(env)).toBeCloseTo(5);
    expect(env.rms[25]).toBe(0);
    expect(env.peak[5]).toBeGreaterThan(0.4);
    expect(toDb(1)).toBe(0);
    expect(toDb(0)).toBe(-100);
    expect(computeEnvelope([], 1000).rms).toEqual([]);
  });

  it('detects silences with padding and min duration', () => {
    const env = computeEnvelope(beepSamples(), 1000, 0.01);
    expect(detectSilences(env)).toEqual([{ start: 2.1, end: 2.9 }]);
    expect(detectSilences(env, { padding: 0, minDuration: 2 })).toEqual([]);
    const lead: Envelope = { windowSec: 0.5, rms: [0, 0, 1, 1, 0, 0], peak: [] };
    expect(detectSilences(lead, { padding: 0.2, minDuration: 0.5 })).toEqual([
      { start: 0, end: 0.8 },
      { start: 2.2, end: 3 },
    ]);
    const tiny: Envelope = { windowSec: 0.5, rms: [1, 0, 1], peak: [] };
    expect(detectSilences(tiny, { padding: 0.25, minDuration: 0.5 })).toEqual([]);
  });

  it('summarizes waveforms', () => {
    const env = computeEnvelope(beepSamples(), 1000, 0.01);
    const s = summarizeWaveform(env, 5);
    expect(s.buckets).toHaveLength(5);
    expect(s.duration).toBe(5);
    expect(s.quietest[0]!.start).toBe(2);
    expect(s.peakDb).toBeLessThan(0);
    expect(summarizeWaveform({ windowSec: 0.1, rms: [], peak: [] })).toMatchObject({
      buckets: [],
      loudest: [],
    });
  });

  it('mixes a timeline envelope through clips', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 2, sourceStart: 3 },
        { type: 'add_clip', assetId: 'asset_a', start: 1, duration: 1 },
      ],
      ctx,
    ).project;
    const env = computeEnvelope(beepSamples(), 1000, 0.01);
    const tl = timelineEnvelope(p, new Map([['asset_v', env]]), 0.1);
    expect(tl.rms).toHaveLength(20);
    expect(tl.rms[5]).toBeGreaterThan(0.3);
    expect(timelineEnvelope(p, new Map([['asset_v', env]]), 0.1, 1).rms).toHaveLength(10);
    // Source beyond the envelope reads as silence.
    const late = run(
      project,
      [{ type: 'add_clip', assetId: 'asset_v', start: 0, duration: 2, sourceStart: 10 }],
      ctx,
    ).project;
    expect(Math.max(...timelineEnvelope(late, new Map([['asset_v', env]]), 0.1).rms)).toBe(0);
  });
});

describe('timeline mapping', () => {
  it('maps source ranges and words to the timeline', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 10, duration: 4, sourceStart: 2 },
        {
          type: 'add_clip',
          assetId: 'asset_v',
          start: 0,
          duration: 2,
          sourceStart: 8,
          clipType: 'audio',
        },
        { type: 'add_clip', assetId: 'asset_i', start: 0 },
        { type: 'add_clip', assetId: 'asset_a', start: 2 },
      ],
      ctx,
    ).project;
    expect(mapSourceRangeToTimeline(p, 'asset_v', { start: 3, end: 9 })).toEqual([
      { clipId: 'clip_2', start: 0, end: 1 },
      { clipId: 'clip_1', start: 11, end: 14 },
    ]);
    expect(assetUsage(p, 'asset_v')).toEqual([
      { start: 0, end: 2 },
      { start: 10, end: 14 },
    ]);
    expect(
      unionRanges([
        { start: 0, end: 1 },
        { start: 0.5, end: 2 },
      ]),
    ).toEqual([{ start: 0, end: 2 }]);

    const words = [
      { text: 'cut', start: 0, end: 1 },
      { text: 'hello', start: 2.1, end: 2.6 },
      { text: 'world', start: 8.2, end: 8.5 },
      { text: 'edge', start: 5.7, end: 6.2 },
    ];
    expect(mapWordsToTimeline(p, new Map([['asset_v', words]]))).toEqual([
      { text: 'world', start: 0.2, end: 0.5 },
      { text: 'hello', start: 10.1, end: 10.6 },
      { text: 'edge', start: 13.7, end: 14 },
    ]);
  });

  it('drops muted material and duplicate words', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 4 },
        { type: 'add_clip', assetId: 'asset_v', start: 0, duration: 4, clipType: 'audio' },
        {
          type: 'add_clip',
          assetId: 'asset_v',
          start: 4,
          duration: 2,
          sourceStart: 4,
          props: { muted: true },
        },
        { type: 'add_captions', cues: [{ start: 0, end: 1, text: 'x' }] },
      ],
      ctx,
    ).project;
    const words = new Map([
      [
        'asset_v',
        [
          { text: 'a', start: 1, end: 2 },
          { text: 'b', start: 4.5, end: 5 },
        ],
      ],
    ]);
    expect(mapWordsToTimeline(p, words)).toEqual([{ text: 'a', start: 1, end: 2 }]);
    const mutedTrack = run(
      p,
      [{ type: 'update_track', trackId: 'track_1', muted: true }],
      ctx,
    ).project;
    expect(mapWordsToTimeline(mutedTrack, words)).toEqual([{ text: 'a', start: 1, end: 2 }]);
    expect(mapWordsToTimeline(p, new Map())).toEqual([]);
  });
});

describe('captions', () => {
  it('groups words into readable cues', () => {
    const w = (text: string, start: number, end = start + 0.3) => ({ text, start, end });
    const cues = wordsToCues([
      w('Hello', 0),
      w('there.', 0.4),
      w('This', 0.8),
      w('is', 1.1),
      w('fine.', 1.4),
      w('Next', 1.8),
      w(' ', 2),
      w('after', 3.5),
      w('a', 3.9),
      w('pause', 4.2, 4.2),
    ]);
    expect(cues.map((c) => c.text)).toEqual([
      'Hello there. This is fine.',
      'Next',
      'after a pause',
    ]);
    expect(cues[2]!.words!.at(-1)!.end).toBeCloseTo(4.21);
    const long = wordsToCues(
      Array.from({ length: 20 }, (_, i) => w('word', i * 0.3)),
      { maxChars: 20 },
    );
    expect(long.every((c) => c.text.length <= 20)).toBe(true);
    const slow = wordsToCues([w('a', 0), w('b', 0.5), w('c', 1)], { maxDuration: 0.6, maxGap: 5 });
    expect(slow).toHaveLength(3);
    expect(wordsToCues([])).toEqual([]);
  });
});

describe('summarizeProject', () => {
  it('produces a compact view', () => {
    const { project, ctx } = baseProject();
    const p = run(
      project,
      [
        {
          type: 'add_clip',
          assetId: 'asset_v',
          duration: 2,
          props: {
            volume: 0.5,
            muted: true,
            effects: { blur: 1 },
            keyframes: { x: [{ time: 0, value: 0 }] },
          },
        },
        {
          type: 'add_clip',
          assetId: 'asset_v',
          duration: 2,
          props: { transitionIn: { type: 'crossfade', duration: 1 } },
        },
        { type: 'add_text', text: 'Title', start: 0 },
        { type: 'add_clip', assetId: 'asset_i', start: 9 },
        { type: 'add_captions', cues: [{ start: 0, end: 1, text: 'cap' }] },
        {
          type: 'update_track',
          trackId: 'track_2',
          muted: true,
          hidden: true,
          locked: true,
          volume: 0.5,
        },
      ],
      ctx,
    ).project;
    const s = summarizeProject(p, { maxClipsPerTrack: 2 });
    expect(s.duration).toBe(14);
    expect(s.assets[0]).toMatchObject({ id: 'asset_v', size: '1920x1080' });
    expect(s.assets[1]).not.toHaveProperty('size');
    expect(s.assets[2]!.duration).toBeNull();
    expect(s.tracks[0]!.clips[0]).toMatchObject({
      volume: 0.5,
      muted: true,
      effects: ['blur'],
      animated: ['x'],
      source: [0, 2],
    });
    expect(s.tracks[0]!.clips[1]!.transitionIn).toBe('crossfade 1s');
    expect(s.tracks[0]).toMatchObject({ clipCount: 3, truncated: true });
    expect(s.tracks[1]).toMatchObject({ muted: true, hidden: true, locked: true, volume: 0.5 });
    expect(s.tracks.find((t) => t.kind === 'caption')!.clips[0]!.text).toBe('cap');
    const unknownAsset = { ...p, assets: [] } as Project;
    expect(summarizeProject(unknownAsset).tracks[0]!.clips[0]!.asset).toMatch(/\(\?\)/);
    expect(summarizeProject(p).tracks[0]).not.toHaveProperty('truncated');
  });
});
