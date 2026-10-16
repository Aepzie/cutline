import { clipSpeed, isFreeze, isReversed, sourceSpan } from './clipmath';
import type { Cue } from './operations/schemas';
import type { CaptionStyle, Project, Word } from './schema';
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

export interface LaidOutWord {
  text: string;
  /** Index into the caption's word list (for highlighting). */
  index: number;
  x: number;
  width: number;
}

export interface LaidOutLine {
  words: LaidOutWord[];
  width: number;
}

/**
 * Greedy word wrap. `measure` returns the rendered width of a string; x
 * positions are relative to the line start. Lines are later centered.
 */
export function layoutWords(
  tokens: readonly string[],
  measure: (text: string) => number,
  maxWidth: number,
): LaidOutLine[] {
  const space = measure(' ');
  const lines: LaidOutLine[] = [];
  let line: LaidOutLine = { words: [], width: 0 };
  tokens.forEach((text, index) => {
    const width = measure(text);
    const x = line.words.length === 0 ? 0 : line.width + space;
    if (line.words.length > 0 && x + width > maxWidth) {
      lines.push(line);
      line = { words: [{ text, index, x: 0, width }], width };
    } else {
      line.words.push({ text, index, x, width });
      line.width = x + width;
    }
  });
  if (line.words.length > 0) lines.push(line);
  return lines;
}

/** Splits caption text into tokens; maps to word timings when counts match. */
export function captionTokens(
  text: string,
  words: ReadonlyArray<{ text: string }> | undefined,
): { tokens: string[]; timed: boolean } {
  const tokens = text.split(/\s+/).filter(Boolean);
  return {
    tokens,
    timed: Boolean(words && tokens.length > 0 && words.length === tokens.length),
  };
}

/** Vertical center of a caption box of `boxHeight` canvas pixels. */
export function captionCenterY(
  canvasHeight: number,
  style: Pick<CaptionStyle, 'position' | 'margin'>,
  boxHeight: number,
): number {
  const margin = style.margin * canvasHeight;
  switch (style.position) {
    case 'top':
      return margin + boxHeight / 2;
    case 'middle':
      return canvasHeight / 2;
    case 'bottom':
      return canvasHeight - margin - boxHeight / 2;
  }
}

export interface ActiveTimeInterval {
  start: number;
  end: number;
}

/**
 * Computes non-overlapping active time intervals for each word in `words`,
 * matching the first-match (`findIndex`) rule used in `resolveFrame`.
 */
export function resolveActiveWordIntervals(
  words: ReadonlyArray<{ start: number; end: number }>,
): Map<number, ActiveTimeInterval[]> {
  const result = new Map<number, ActiveTimeInterval[]>();
  if (words.length === 0) return result;

  const boundaries = new Set<number>();
  for (const w of words) {
    if (w.end > w.start) {
      boundaries.add(w.start);
      boundaries.add(w.end);
    }
  }
  const sorted = Array.from(boundaries).sort((a, b) => a - b);
  for (let i = 0; i < sorted.length - 1; i++) {
    const segStart = sorted[i]!;
    const segEnd = sorted[i + 1]!;
    const mid = (segStart + segEnd) / 2;
    const activeIndex = words.findIndex((w) => mid >= w.start && mid < w.end);
    if (activeIndex === -1) continue;

    let intervals = result.get(activeIndex);
    if (!intervals) {
      intervals = [];
      result.set(activeIndex, intervals);
    }
    const last = intervals[intervals.length - 1];
    if (last && Math.abs(last.end - segStart) <= 1e-6) {
      last.end = segEnd;
    } else {
      intervals.push({ start: segStart, end: segEnd });
    }
  }
  return result;
}
