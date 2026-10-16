import { existsSync, readFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { log } from '../log';

type Variant = 'regular' | 'bold' | 'italic' | 'boldItalic';
type Family = 'sans' | 'serif' | 'mono';

const CANDIDATES: Record<Family, Record<Variant, string[]>> = {
  sans: {
    regular: [
      'C:/Windows/Fonts/arial.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/TTF/DejaVuSans.ttf',
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/Library/Fonts/Arial.ttf',
    ],
    bold: [
      'C:/Windows/Fonts/arialbd.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
      '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
      '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
      '/Library/Fonts/Arial Bold.ttf',
    ],
    italic: [
      'C:/Windows/Fonts/ariali.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
      '/System/Library/Fonts/Supplemental/Arial Italic.ttf',
    ],
    boldItalic: [
      'C:/Windows/Fonts/arialbi.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf',
      '/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf',
    ],
  },
  serif: {
    regular: [
      'C:/Windows/Fonts/georgia.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
      '/System/Library/Fonts/Supplemental/Georgia.ttf',
    ],
    bold: [
      'C:/Windows/Fonts/georgiab.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
      '/System/Library/Fonts/Supplemental/Georgia Bold.ttf',
    ],
    italic: [
      'C:/Windows/Fonts/georgiai.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf',
      '/System/Library/Fonts/Supplemental/Georgia Italic.ttf',
    ],
    boldItalic: [
      'C:/Windows/Fonts/georgiaz.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSerif-BoldItalic.ttf',
      '/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf',
    ],
  },
  mono: {
    regular: [
      'C:/Windows/Fonts/consola.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
      '/System/Library/Fonts/Supplemental/Courier New.ttf',
    ],
    bold: [
      'C:/Windows/Fonts/consolab.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf',
      '/System/Library/Fonts/Supplemental/Courier New Bold.ttf',
    ],
    italic: [
      'C:/Windows/Fonts/consolai.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Oblique.ttf',
      '/System/Library/Fonts/Supplemental/Courier New Italic.ttf',
    ],
    boldItalic: [
      'C:/Windows/Fonts/consolaz.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-BoldOblique.ttf',
      '/System/Library/Fonts/Supplemental/Courier New Bold Italic.ttf',
    ],
  },
};

/** Maps a CSS font-family list to one of the generic families we ship file lists for. */
export function fontGroup(family: string): Family {
  const f = family.toLowerCase();
  if (/mono|courier|consol/.test(f)) return 'mono';
  if (/(^|[\s,'"])serif|georgia|times|garamond/.test(f) && !/sans-serif/.test(f)) return 'serif';
  return 'sans';
}

const cache = new Map<string, string | undefined>();

/**
 * A concrete font file for drawtext. Explicit files avoid depending on a
 * working fontconfig setup (which many Windows ffmpeg builds lack).
 * CUTLINE_FONT_FILE overrides everything.
 */
export function resolveFontFile(
  family: string,
  bold: boolean,
  italic: boolean,
): string | undefined {
  if (process.env.CUTLINE_FONT_FILE) return process.env.CUTLINE_FONT_FILE;
  const group = fontGroup(family);
  const variant: Variant =
    bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
  const key = `${group}/${variant}`;
  if (!cache.has(key)) {
    const found = CANDIDATES[group][variant].find((p) => existsSync(p));
    // Fall back to the regular weight of the family, then to sans.
    const fallback =
      variant !== 'regular'
        ? resolveFontFile(family, false, false)
        : group !== 'sans'
          ? resolveFontFile('sans-serif', false, false)
          : undefined;
    cache.set(key, found ?? fallback);
  }
  return cache.get(key);
}

const fontObjectCache = new Map<string, opentype.Font | null>();

/** Loads and parses a font file (cached in memory). */
export function loadFontFile(filePath: string): opentype.Font | null {
  if (fontObjectCache.has(filePath)) {
    return fontObjectCache.get(filePath) ?? null;
  }
  try {
    const buf = readFileSync(filePath);
    const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    fontObjectCache.set(filePath, font);
    return font;
  } catch {
    fontObjectCache.set(filePath, null);
    return null;
  }
}

/** The subset of an opentype.js font that text measurement relies on. */
export type MeasurableFont = Pick<opentype.Font, 'charToGlyph' | 'getKerningValue' | 'unitsPerEm'>;

/** Em-based width estimate used when no usable font metrics are available. */
export function estimateTextWidth(text: string, fontSize: number, bold = false): number {
  return text.length * fontSize * (bold ? 0.58 : 0.52);
}

/**
 * Sums glyph advances (plus pair kerning) without GSUB shaping.
 * `font.getAdvanceWidth` applies GSUB features such as ccmp, and opentype.js
 * 2.0.0 throws on lookup types it does not support (e.g. chained contextual
 * substitution format 2 in DejaVu on Linux), so we stay on the plain cmap/hmtx path.
 */
export function measureGlyphAdvances(font: MeasurableFont, text: string, fontSize: number): number {
  const scale = fontSize / font.unitsPerEm;
  let width = 0;
  let prev: opentype.Glyph | undefined;
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    width += glyph.advanceWidth ?? 0;
    if (prev) {
      try {
        width += font.getKerningValue(prev, glyph);
      } catch {
        // Kerning is cosmetic; ignore broken kern/GPOS tables.
      }
    }
    prev = glyph;
  }
  return width * scale;
}

const warnedFonts = new Set<string>();

/**
 * Wraps glyph-advance measurement of `font` so it can never throw: on any error
 * the em-based estimate is used and a warning is logged once per `fontKey`.
 */
export function measureWithFallback(
  font: MeasurableFont,
  fontKey: string,
  fontSize: number,
  bold = false,
): (text: string) => number {
  return (text: string) => {
    try {
      const width = measureGlyphAdvances(font, text, fontSize);
      if (Number.isFinite(width)) return width;
      throw new Error(`non-finite width ${width}`);
    } catch (err) {
      if (!warnedFonts.has(fontKey)) {
        warnedFonts.add(fontKey);
        log.warn(
          `could not measure text with font ${fontKey}; using estimated widths`,
          err instanceof Error ? err.message : err,
        );
      }
      return estimateTextWidth(text, fontSize, bold);
    }
  };
}

/**
 * Returns a text measuring function using the actual font metrics from
 * opentype.js when a font file is available, or an estimated glyph width fallback.
 */
export function createFontMeasure(
  fontFilePath: string | undefined,
  fontSize: number,
  bold = false,
): (text: string) => number {
  if (fontFilePath) {
    const font = loadFontFile(fontFilePath);
    if (font) return measureWithFallback(font, fontFilePath, fontSize, bold);
  }
  return (text: string) => estimateTextWidth(text, fontSize, bold);
}
