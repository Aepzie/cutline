import { describe, expect, it } from 'vitest';
import { sampleWaveform } from './waveform';

const envelope = {
  windowSec: 0.5,
  rms: [0.1, 0.3, 0.6, 0.15],
  peak: [0.1, 0.4, 0.7, 0.2],
};

describe('sampleWaveform', () => {
  it('samples only the clip source-time slice at the requested pixel width', () => {
    expect(sampleWaveform(envelope, 0.5, 1.5, 3)).toEqual([0.4, 0.7, 0.2]);
  });

  it('mirrors peak samples for reversed clips', () => {
    expect(sampleWaveform(envelope, 0, 2, 4, true)).toEqual([0.2, 0.7, 0.4, 0.1]);
  });

  it('keeps silence and source ranges past the envelope empty', () => {
    expect(sampleWaveform({ ...envelope, peak: [] }, 0, 2, 4)).toEqual([]);
    expect(sampleWaveform(envelope, 2, 1, 2)).toEqual([0, 0]);
  });

  it('returns no samples for invalid ranges or dimensions', () => {
    expect(sampleWaveform(envelope, 0, 0, 4)).toEqual([]);
    expect(sampleWaveform(envelope, 0, 1, 0)).toEqual([]);
    expect(sampleWaveform(envelope, Number.NaN, 1, 4)).toEqual([]);
  });

  it('down-samples by the maximum peak when a pixel spans multiple windows', () => {
    expect(sampleWaveform(envelope, 0, 2, 1)).toEqual([0.7]);
    expect(sampleWaveform(envelope, 0, 2, 2)).toEqual([0.4, 0.7]);
  });
});
