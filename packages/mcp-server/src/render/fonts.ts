import { existsSync } from 'node:fs';

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
