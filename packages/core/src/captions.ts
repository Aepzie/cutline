import { clipSpeed, isFreeze, isReversed, sourceSpan } from './clipmath';
import type { Cue } from './operations/schemas';
import type { Project, Word } from './schema';
import { roundTime } from './time';

export interface CueOptions {
  /** Max characters per cue. Default 42 (a common subtitle guideline). */
  maxChars?: number;
  /** Max cue duration in seconds. Default 6. */
  maxDuration?: number;
  /** Start a new cue after a pause longer than this. Default 0.7 s. */
  maxGap?: number;
}

/** Groups timed words into caption cues (word timings stay absolute). */
export function wordsToCues(words: readonly Word[], options: CueOptions = {}): Cue[] {
  const maxChars = options.maxChars ?? 42;
  const maxDuration = options.maxDuration ?? 6;
  const maxGap = options.maxGap ?? 0.7;
  const cues: Cue[] = [];
  let current: Word[] = [];

  const flush = () => {
    if (current.length === 0) return;
    cues.push({
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      text: current.map((w) => w.text).join(' '),
      words: current,
    });
    current = [];
  };

  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    const w = { text, start: word.start, end: Math.max(word.end, word.start + 0.01) };
    const prev = current[current.length - 1];
    if (prev) {
      const length = current.reduce((n, x) => n + x.text.length + 1, 0) + text.length;
      const sentenceEnd = /[.!?]$/.test(prev.text) && current.length >= 3;
      if (
        length > maxChars ||
        w.end - current[0]!.start > maxDuration ||
        w.start - prev.end > maxGap ||
        sentenceEnd
      ) {
        flush();
      }
    }
    current.push(w);
  }
  flush();
  return cues;
}

/**
 * Maps per-asset transcripts (source time) onto the timeline through the
 * audible clips that use each asset. Words cut out of the edit disappear.
 */
export function mapWordsToTimeline(
  project: Project,
  wordsByAsset: ReadonlyMap<string, readonly Word[]>,
): Word[] {
  const out: Word[] = [];
  for (const track of project.tracks) {
    if (track.muted || track.kind === 'caption') continue;
    for (const clip of track.clips) {
      if (clip.type !== 'video' && clip.type !== 'audio') continue;
      // Freeze frames are silent; reversed speech is not intelligible.
      if (clip.muted || isFreeze(clip) || isReversed(clip)) continue;
      const words = wordsByAsset.get(clip.assetId);
      if (!words) continue;
      const speed = clipSpeed(clip);
      const srcEnd = clip.sourceStart + sourceSpan(clip);
      for (const w of words) {
        const mid = (w.start + w.end) / 2;
        if (mid < clip.sourceStart || mid >= srcEnd) continue;
        const start = Math.max(w.start, clip.sourceStart);
        const end = Math.min(w.end, srcEnd);
        out.push({
          text: w.text,
          start: roundTime(clip.start + (start - clip.sourceStart) / speed),
          end: roundTime(clip.start + (end - clip.sourceStart) / speed),
        });
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  // The same asset may be audible on two tracks (e.g. video + its audio); drop duplicates.
  return out.filter(
    (w, i) =>
      i === 0 || !(out[i - 1]!.text === w.text && Math.abs(out[i - 1]!.start - w.start) < 0.05),
  );
}
