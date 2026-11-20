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
  return { tokens, timed: Boolean(words && words.length === tokens.length) };
}
