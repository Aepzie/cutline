import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';
import {
  createFontMeasure,
  estimateTextWidth,
  loadFontFile,
  measureGlyphAdvances,
  measureWithFallback,
  resolveFontFile,
  type MeasurableFont,
} from '../src/render/fonts';

const shapingError = () => {
  throw new Error('substitutionType : 62 lookupType: 6 - substFormat: 2 is not yet supported');
};

/** A font whose GSUB-shaping paths throw like opentype.js 2.0.0 on DejaVu. */
function fakeFont(overrides: Partial<Record<string, unknown>> = {}): MeasurableFont {
  return {
    unitsPerEm: 1000,
    charToGlyph: (ch: string) => ({ advanceWidth: ch === ' ' ? 250 : 500 }),
    getKerningValue: () => 0,
    getAdvanceWidth: shapingError,
    forEachGlyph: shapingError,
    ...overrides,
  } as unknown as MeasurableFont;
}

describe('caption text measurement', () => {
  it('sums glyph advances without calling the shaping APIs', () => {
    const font = fakeFont();
    // 2 letters * 500 + 1 space * 250 = 1250 units at 1000 upem -> 25 px at 20 px.
    expect(measureGlyphAdvances(font, 'a b', 20)).toBeCloseTo(25);
    expect(measureWithFallback(font, 'fake.ttf', 20)('a b')).toBeCloseTo(25);
  });

  it('iterates by code point and applies pair kerning', () => {
    const font = fakeFont({ getKerningValue: () => -100 });
    // Astral emoji counts as one glyph: 2 glyphs * 500 - 100 kerning = 900 units.
    expect(measureGlyphAdvances(font, 'a\u{1F600}', 10)).toBeCloseTo(9);
  });

  it('ignores kerning errors', () => {
    const font = fakeFont({ getKerningValue: shapingError });
    expect(measureGlyphAdvances(font, 'ab', 10)).toBeCloseTo(10);
  });

  it('treats missing advances as zero', () => {
    const font = fakeFont({ charToGlyph: () => ({}) });
    expect(measureGlyphAdvances(font, 'ab', 10)).toBe(0);
  });

  it('falls back to the estimate and warns once when glyph lookup throws', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const measure = measureWithFallback(
        fakeFont({ charToGlyph: shapingError }),
        'broken.ttf',
        20,
        true,
      );
      expect(measure('hello')).toBe(estimateTextWidth('hello', 20, true));
      expect(measure('world!')).toBe(estimateTextWidth('world!', 20, true));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back when the font reports a nonsensical size', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const measure = measureWithFallback(fakeFont({ unitsPerEm: 0 }), 'zero-upem.ttf', 20);
      expect(measure('ab')).toBe(estimateTextWidth('ab', 20));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('estimates without a font file', () => {
    expect(createFontMeasure(undefined, 10)('abcd')).toBe(estimateTextWidth('abcd', 10));
    expect(createFontMeasure('/does/not/exist.ttf', 10, true)('ab')).toBe(
      estimateTextWidth('ab', 10, true),
    );
  });

  // Bahnschrift ships with Windows and has the same GSUB lookup (type 6, format 2)
  // that crashes opentype.js 2.0.0 on DejaVu Sans in Linux CI.
  const shapingCrashFont = 'C:/Windows/Fonts/bahnschrift.ttf';
  it.runIf(existsSync(shapingCrashFont))('measures fonts whose GSUB shaping crashes', () => {
    const font = loadFontFile(shapingCrashFont);
    expect(font).not.toBeNull();
    expect(() => font!.getAdvanceWidth('Hello world', 40)).toThrow(/lookupType: 6/);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const w = createFontMeasure(shapingCrashFont, 40)('Hello world');
      expect(w).toBeGreaterThan(0);
      expect(w).not.toBe(estimateTextWidth('Hello world', 40));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('measures with a real system font when one is available', () => {
    const file = resolveFontFile('sans-serif', false, false);
    if (!file) return;
    const measure = createFontMeasure(file, 40);
    const w = measure('Hello world');
    expect(w).toBeGreaterThan(0);
    expect(measure('Hello world, again')).toBeGreaterThan(w);
  });
});
