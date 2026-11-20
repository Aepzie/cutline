import type { Envelope } from '@cutline/core';

/** Samples a source-time slice into one peak value per output pixel. */
export function sampleWaveform(
  envelope: Pick<Envelope, 'windowSec' | 'peak'>,
  sourceStart: number,
  duration: number,
  pixelWidth: number,
  reverse = false,
): number[] {
  if (
    !Number.isFinite(sourceStart) ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(pixelWidth) ||
    pixelWidth < 1 ||
    !Number.isFinite(envelope.windowSec) ||
    envelope.windowSec <= 0 ||
    envelope.peak.length === 0
  ) {
    return [];
  }

  const width = Math.floor(pixelWidth);
  const samples = Array.from({ length: width }, (_, x) => {
    const start = Math.max(0, sourceStart + (duration * x) / width);
    const end = Math.max(start, sourceStart + (duration * (x + 1)) / width);
    const first = Math.max(0, Math.floor(start / envelope.windowSec));
    const last = Math.min(
      envelope.peak.length,
      Math.max(first + 1, Math.ceil(end / envelope.windowSec)),
    );
    let peak = 0;
    for (let i = first; i < last; i++) {
      const value = envelope.peak[i];
      if (value !== undefined && Number.isFinite(value)) {
        peak = Math.max(peak, Math.min(1, Math.max(0, value)));
      }
    }
    return peak;
  });
  return reverse ? samples.reverse() : samples;
}
