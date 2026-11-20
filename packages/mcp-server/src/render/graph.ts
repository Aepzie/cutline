import {
  CaptionStyleSchema,
  animationAt,
  animationSampleTimes,
  clipEnd,
  clipSpeed,
  isFreeze,
  isReversed,
  previousAdjacent,
  resolveAudioSegments,
  segmentSourceTime,
  sourceTimeAt,
  type AnimationContribution,
  type Asset,
  type FrameSize,
  type CaptionClip,
  type Project,
  type TextClip,
  type Track,
  type VideoClip,
  type VisualClip,
} from '@cutline/core';
import { add, isConstant, keyframePoints, multiply, num, piecewise, type Point } from './expr';
import { shapeSource } from './shape';

export interface GraphOptions {
  /** Timeline range to render; output time 0 = start. */
  start: number;
  end: number;
  width: number;
  height: number;
  fps: number;
  includeAudio: boolean;
  /** Writes text to a temp file and returns its path (drawtext textfile=). */
  textFile: (content: string) => string;
  /** Font file for drawtext per style; undefined falls back to fontconfig family names. */
  fontFile?: (family: string, bold: boolean, italic: boolean) => string | undefined;
}

export interface RenderGraph {
  /** ffmpeg input arguments, one array per input. */
  inputs: string[][];
  /** filter_complex script. */
  filter: string;
  video: string;
  audio: string | null;
  duration: number;
  /** Features the server renderer approximated or ignored. */
  warnings: string[];
}

const nextAdjacent = (track: Track, clip: VisualClip) =>
  track.clips.find((c) => c.id !== clip.id && Math.abs(c.start - clipEnd(clip)) <= 1e-3);

/**
 * Quotes a path for a filter option value. ffmpeg parses filter arguments twice:
 * the graph parser strips the quotes, then the option parser splits on ':',
 * so colons (e.g. Windows drive letters) must also be escaped inside the quotes.
 */
export function filterPath(path: string): string {
  return `'${path.replace(/\\/g, '/').replace(/'/g, '').replace(/:/g, '\\:')}'`;
}

function ffColor(hex: string, alpha = 1): string {
  const h = hex.replace('#', '');
  const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
  return `0x${h.slice(0, 6)}@${num(a * alpha)}`;
}

/** Visible span of a visual clip including transition extensions. */
function visualSpan(track: Track, clip: VisualClip): { from: number; to: number } {
  let from = clip.start;
  let to = clipEnd(clip);
  const tin = clip.transitionIn;
  if (tin?.type === 'crossfade' && previousAdjacent(track, clip)) from -= tin.duration / 2;
  const next = nextAdjacent(track, clip);
  const nin =
    next && next.type !== 'audio' && next.type !== 'caption' ? next.transitionIn : undefined;
  if (nin?.type === 'crossfade') to += nin.duration / 2;
  return { from, to };
}

/** Opacity multiplier from fades and transitions, in output time. */
function fadePoints(track: Track, clip: VisualClip, shift: number): Point[] {
  const s = clip.start - shift;
  const e = clipEnd(clip) - shift;
  let pts: Point[] = [];
  const ramp = (a: number, b: number, up: boolean): Point[] =>
    up
      ? [
          { t: a, v: 0 },
          { t: b, v: 1 },
        ]
      : [
          { t: a, v: 1 },
          { t: b, v: 0 },
        ];
  if (clip.fadeIn > 0) pts = multiply(pts, ramp(s, s + clip.fadeIn, true));
  if (clip.fadeOut > 0) pts = multiply(pts, ramp(e - clip.fadeOut, e, false));
  const tin = clip.transitionIn;
  if (tin) {
    const d = tin.duration;
    const prev = previousAdjacent(track, clip);
    if (!prev) pts = multiply(pts, ramp(s, s + d, true));
    else if (tin.type === 'crossfade') pts = multiply(pts, ramp(s - d / 2, s + d / 2, true));
    else pts = multiply(pts, ramp(s, s + d / 2, true));
  }
  const next = nextAdjacent(track, clip);
  const nin =
    next && next.type !== 'audio' && next.type !== 'caption' ? next.transitionIn : undefined;
  if (nin?.type === 'dipToBlack') pts = multiply(pts, ramp(e - nin.duration / 2, e, false));
  return pts;
}

/** Keyframed (or static) transform property in output time; `shift` = clip start in output time. */
function propertyPoints(
  clip: VisualClip,
  prop: 'x' | 'y' | 'scale' | 'opacity',
  shift: number,
): Point[] {
  const kf = clip.keyframes?.[prop];
  return kf?.length ? keyframePoints(kf, shift) : [{ t: 0, v: clip.transform[prop] }];
}

/**
 * One channel of the clip's entrance/exit animation preset in output time,
 * sampled from the core helper (the same function the resolver uses). Empty
 * if the clip has no animation.
 */
function presetPoints(
  clip: VisualClip,
  shift: number,
  frame: FrameSize,
  pick: (a: AnimationContribution) => number,
): Point[] {
  return animationSampleTimes(clip).map((lt) => ({
    t: lt + shift,
    v: pick(animationAt(clip, lt, frame)),
  }));
}

/** Opacity: keyframes × animation preset × fades/transitions. */
function opacityPoints(track: Track, clip: VisualClip, start: number, frame: FrameSize): Point[] {
  const shift = clip.start - start;
  const base = multiply(
    propertyPoints(clip, 'opacity', shift),
    presetPoints(clip, shift, frame, (a) => a.opacity),
  );
  return multiply(base, fadePoints(track, clip, start));
}

/** Scale: keyframes × animation preset. */
function scalePoints(clip: VisualClip, shift: number, frame: FrameSize): Point[] {
  return multiply(
    propertyPoints(clip, 'scale', shift),
    presetPoints(clip, shift, frame, (a) => a.scale),
  );
}

/**
 * Layer center along one axis in output pixels: `half` + `s` × (keyframed
 * position + animation offset), as a constant or a per-frame expression.
 */
function centerExpr(
  clip: VisualClip,
  axis: 'x' | 'y',
  shift: number,
  frame: FrameSize,
  half: number,
  s: number,
): string {
  const pts = add(
    propertyPoints(clip, axis, shift),
    presetPoints(clip, shift, frame, (a) => (axis === 'x' ? a.dx : a.dy)),
  );
  return isConstant(pts)
    ? num(half + pts[0]!.v * s)
    : `(${num(half)}+${num(s)}*(${piecewise(pts)}))`;
}

/**
 * Seek position whose first decoded frame is the one containing source time
 * `t` (browser lookup semantics): half a frame before that frame's start.
 */
function frameSeek(t: number, fps: number | null): number {
  return fps ? Math.max(0, (Math.floor(t * fps + 1e-6) - 0.5) / fps) : t;
}

/**
 * atempo factors whose product is `speed`, each inside 0.5–2 (the range all
 * ffmpeg versions accept): 4 → [2, 2], 0.25 → [0.5, 0.5].
 */
export function atempoChain(speed: number): number[] {
  const out: number[] = [];
  let rest = speed;
  while (rest > 2 + 1e-9) {
    out.push(2);
    rest /= 2;
  }
  while (rest < 0.5 - 1e-9) {
    out.push(0.5);
    rest /= 0.5;
  }
  if (Math.abs(rest - 1) > 1e-9 || out.length === 0) out.push(rest);
  return out;
}

/**
 * Input + filters that turn a video clip's source into frames for the
 * timeline window [from, to): seek/trim the needed source range, reverse
 * (bounded by the trim) and retime by the clip speed, then pad with cloned
 * frames where transition handles reach outside the asset. Mirrors the
 * resolver's source-time mapping (`sourceTimeAt`).
 */
function videoSourceFilters(
  clip: VideoClip,
  asset: Asset,
  path: string,
  idx: number,
  from: number,
  to: number,
  fps: number,
  inputs: string[][],
): string[] {
  const speed = clipSpeed(clip);
  const reverse = isReversed(clip);
  const a = sourceTimeAt(clip, from - clip.start);
  const b = sourceTimeAt(clip, to - clip.start);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const seekLo = Math.max(0, lo);
  const seekHi = Math.max(seekLo, Math.min(asset.duration ?? Infinity, hi));
  // Timeline seconds of padding where the source window leaves the asset.
  const missingLo = (seekLo - lo) / speed;
  const missingHi = (hi - seekHi) / speed;
  const pre = reverse ? missingHi : missingLo;
  const post = reverse ? missingLo : missingHi;
  let inLo = seekLo;
  let inHi = seekHi;
  if (reverse && asset.fps) {
    // Reversed output starts with its last frame, so the window must hold
    // exactly the frames the resolver shows: first = floor(lo), last = the
    // frame before `hi`. Half-frame margins keep rounding off frame edges.
    const f = asset.fps;
    const first = Math.floor(seekLo * f + 1e-6);
    const last = Math.max(first, Math.ceil(seekHi * f - 1e-6) - 1);
    inLo = Math.max(0, (first - 0.5) / f);
    inHi = (last + 0.5) / f;
  }
  inputs.push(['-ss', num(inLo), '-t', num(Math.max(inHi - inLo, 1 / fps)), '-i', path]);
  const filters = [`[${idx}:v]setpts=PTS-STARTPTS`];
  // `reverse` buffers every decoded frame of the trimmed window in memory.
  if (reverse) filters.push('reverse', 'setpts=PTS-STARTPTS');
  if (speed !== 1) filters.push(`setpts=PTS/${num(speed)}`);
  filters.push(`fps=${num(fps)}`);
  if (pre > 0 || post > 0) {
    filters.push(
      `tpad=start_mode=clone:start_duration=${num(pre)}:stop_mode=clone:stop_duration=${num(post + 1 / fps)}`,
    );
  }
  return filters;
}

/** Greedy wrap by estimated glyph width (drawtext does not wrap). */
export function wrapText(text: string, fontSize: number, maxWidth: number, bold = true): string {
  const charW = fontSize * (bold ? 0.58 : 0.52);
  const maxChars = Math.max(4, Math.floor(maxWidth / charW));
  return text
    .split('\n')
    .map((para) => {
      const lines: string[] = [];
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        if (line && line.length + 1 + word.length > maxChars) {
          lines.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      if (line) lines.push(line);
      return lines.join('\n');
    })
    .join('\n');
}

function fontOption(
  family: string,
  bold: boolean,
  italic: boolean,
  fontFile?: GraphOptions['fontFile'],
): string {
  const file = fontFile?.(family, bold, italic);
  if (file) return `fontfile=${filterPath(file)}`;
  const generic: Record<string, string> = {
    'sans-serif': 'Sans',
    serif: 'Serif',
    monospace: 'Monospace',
  };
  const name = (generic[family.toLowerCase()] ?? family.split(',')[0]!.trim()).replace(
    /['":]/g,
    '',
  );
  const style = bold && italic ? 'Bold Italic' : bold ? 'Bold' : italic ? 'Italic' : '';
  // Escaped for the option parser (see filterPath).
  return `font='${name}${style ? `\\:style=${style}` : ''}'`;
}

/**
 * Builds a single ffmpeg filtergraph that renders `project` over
 * [start, end): video layers are overlaid on a background in track order,
 * text and captions are drawn with drawtext, audio segments are delayed,
 * gain-enveloped and mixed. Mirrors the core resolver used by the browser.
 */
export function buildRenderGraph(
  project: Project,
  assetPaths: ReadonlyMap<string, string>,
  opts: GraphOptions,
): RenderGraph {
  const { start, end, width: W, height: H, fps } = opts;
  const D = Math.max(1 / fps, end - start);
  const sx = W / project.settings.width;
  const sy = H / project.settings.height;
  const assets = new Map<string, Asset>(project.assets.map((a) => [a.id, a]));
  const inputs: string[][] = [];
  const chains: string[] = [];
  const warnings = new Set<string>();
  let base = 'base0';
  chains.push(
    `color=c=${ffColor(project.settings.backgroundColor)}:s=${W}x${H}:r=${num(fps)}:d=${num(D)},format=yuv420p[base0]`,
  );
  let n = 0;
  const nextBase = () => `base${++n}`;
  let layerSeq = 0;

  for (const track of project.tracks) {
    if (track.hidden || track.kind === 'audio') continue;
    for (const clip of track.clips) {
      if (clip.type === 'audio') continue;
      if (clip.type === 'caption') {
        const style = track.captionStyle ?? CaptionStyleSchema.parse({});
        const from = Math.max(clip.start, start);
        const to = Math.min(clipEnd(clip), end);
        if (to <= from) continue;
        if (style.highlightColor) warnings.add('caption word highlighting is preview-only');
        base = drawCaption(
          chains,
          base,
          nextBase(),
          clip,
          style,
          from - start,
          to - start,
          W,
          H,
          sx,
          opts,
        );
        continue;
      }
      const span = visualSpan(track, clip);
      const from = Math.max(span.from, start);
      const to = Math.min(span.to, end);
      if (to <= from) continue;
      if (clip.type === 'text') {
        base = drawText(
          chains,
          base,
          nextBase(),
          track,
          clip,
          from - start,
          to - start,
          W,
          H,
          sx,
          sy,
          opts,
          warnings,
          project.settings,
        );
        continue;
      }
      const len = to - from;
      const label = `v${layerSeq++}`;
      const filters: string[] = [];
      // Base size at scale 1, in output pixels.
      let bw: number;
      let bh: number;
      if (clip.type === 'shape') {
        const src = shapeSource(clip, sx, sy, fps, len);
        filters.push(src.filter);
        filters.push(`trim=duration=${num(len)}`);
        bw = src.width;
        bh = src.height;
      } else {
        const asset = assets.get(clip.assetId);
        const path = asset && assetPaths.get(asset.id);
        if (!asset || !path) {
          warnings.add(`missing media for clip ${clip.id}`);
          continue;
        }
        const idx = inputs.length;
        if (clip.type === 'video' && isFreeze(clip)) {
          // Freeze frame: decode one frame and hold it.
          const seek = frameSeek(clip.sourceStart, asset.fps);
          inputs.push(['-ss', num(seek), '-t', num(2 / fps), '-i', path]);
          filters.push(
            `[${idx}:v]trim=end_frame=1`,
            'setpts=PTS-STARTPTS',
            `fps=${num(fps)}`,
            `tpad=stop_mode=clone:stop_duration=${num(len + 1 / fps)}`,
          );
        } else if (clip.type === 'video') {
          filters.push(...videoSourceFilters(clip, asset, path, idx, from, to, fps, inputs));
        } else {
          inputs.push(['-loop', '1', '-framerate', num(fps), '-t', num(len), '-i', path]);
          filters.push(`[${idx}:v]setpts=PTS-STARTPTS`);
        }
        filters.push(`trim=duration=${num(len)}`);
        // Media fits inside the frame (contain) at scale 1.
        const mw = asset.width ?? project.settings.width;
        const mh = asset.height ?? project.settings.height;
        const fit = Math.min(project.settings.width / mw, project.settings.height / mh);
        bw = mw * fit * sx;
        bh = mh * fit * sy;
      }
      // Keyframed or preset-animated scale → per-frame expression.
      const shift = clip.start - start;
      const scale = scalePoints(clip, shift, project.settings);
      // Timestamps become output time before any time-dependent filter.
      filters.push(`setpts=PTS+${num(from - start)}/TB`);
      if (!isConstant(scale)) {
        const s = piecewise(scale);
        filters.push(`scale=w='max(2,${num(bw)}*(${s}))':h='max(2,${num(bh)}*(${s}))':eval=frame`);
      } else {
        const s = scale[0]!.v;
        filters.push(`scale=${Math.max(2, Math.round(bw * s))}:${Math.max(2, Math.round(bh * s))}`);
      }
      filters.push('format=rgba');
      const fx = clip.effects;
      if (fx.brightness || fx.contrast || fx.saturation) {
        filters.push(
          `eq=brightness=${num(fx.brightness ?? 0)}:contrast=${num(1 + (fx.contrast ?? 0))}:saturation=${num(1 + (fx.saturation ?? 0))}`,
        );
      }
      if (fx.blur) filters.push(`gblur=sigma=${num(Math.max(0.1, (fx.blur * sx) / 2))}`);
      const rotKf = clip.keyframes?.rotation;
      if (rotKf?.length) {
        const a = piecewise(keyframePoints(rotKf, shift, (deg) => (deg * Math.PI) / 180));
        filters.push(`rotate=a='${a}':c=none:ow='hypot(iw,ih)':oh='hypot(iw,ih)'`);
      } else if (clip.transform.rotation) {
        const a = num((clip.transform.rotation * Math.PI) / 180);
        filters.push(`rotate=a=${a}:c=none:ow='rotw(${a})':oh='roth(${a})'`);
      }
      const opacity = opacityPoints(track, clip, start, project.settings);
      if (isConstant(opacity)) {
        const o = opacity[0]?.v ?? 1;
        if (o < 1) filters.push(`colorchannelmixer=aa=${num(o)}`);
      } else {
        filters.push(
          `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${piecewise(opacity, 'T')})'`,
        );
      }
      chains.push(`${filters.join(',')}[${label}]`);

      const cx = centerExpr(clip, 'x', shift, project.settings, W / 2, sx);
      const cy = centerExpr(clip, 'y', shift, project.settings, H / 2, sy);
      const out = nextBase();
      chains.push(
        `[${base}][${label}]overlay=x='${cx}-w/2':y='${cy}-h/2':eof_action=pass:eval=frame:format=auto[${out}]`,
      );
      base = out;
    }
  }
  chains.push(`[${base}]format=yuv420p[vout]`);

  let audio: string | null = null;
  if (opts.includeAudio) {
    const labels: string[] = [];
    for (const seg of resolveAudioSegments(project)) {
      const from = Math.max(seg.timelineStart, start);
      const to = Math.min(seg.timelineEnd, end);
      if (to <= from) continue;
      const path = assetPaths.get(seg.assetId);
      if (!path) continue;
      const idx = inputs.length;
      const a = segmentSourceTime(seg, from);
      const b = segmentSourceTime(seg, to);
      const srcFrom = Math.min(a, b);
      inputs.push(['-ss', num(srcFrom), '-t', num(Math.abs(b - a)), '-i', path]);
      const gain = piecewise(seg.gain.map((p) => ({ t: p.time - start, v: p.gain })));
      const label = `a${idx}`;
      // Trimmed by -t first, so areverse only buffers this segment.
      const reverse = seg.reverse ? 'areverse,' : '';
      const tempo =
        seg.speed === 1
          ? ''
          : atempoChain(seg.speed)
              .map((f) => `atempo=${num(f)},`)
              .join('');
      chains.push(
        `[${idx}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `${reverse}${tempo}adelay=${Math.round((from - start) * 1000)}:all=1,volume='${gain}':eval=frame[${label}]`,
      );
      labels.push(`[${label}]`);
    }
    if (labels.length === 0) {
      chains.push(`anullsrc=r=48000:cl=stereo,atrim=0:${num(D)}[aout]`);
    } else if (labels.length === 1) {
      chains.push(`${labels[0]}apad=whole_dur=${num(D)},atrim=0:${num(D)}[aout]`);
    } else {
      chains.push(
        `${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,apad=whole_dur=${num(D)},atrim=0:${num(D)}[aout]`,
      );
    }
    audio = 'aout';
  }

  return {
    inputs,
    filter: chains.join(';\n'),
    video: 'vout',
    audio,
    duration: D,
    warnings: [...warnings],
  };
}

function drawText(
  chains: string[],
  base: string,
  out: string,
  track: Track,
  clip: TextClip,
  from: number,
  to: number,
  W: number,
  H: number,
  sx: number,
  sy: number,
  opts: GraphOptions,
  warnings: Set<string>,
  frame: FrameSize,
): string {
  const st = clip.style;
  const shift = clip.start - opts.start;
  // Lines wrap at the static size; keyframes and animation presets scale the glyphs.
  const size = st.fontSize * sx * clip.transform.scale;
  const text = wrapText(clip.text, size, st.maxWidth * W, st.bold);
  const scale = scalePoints(clip, shift, frame);
  const fontSize = isConstant(scale)
    ? num(st.fontSize * sx * scale[0]!.v)
    : `'max(1,${num(st.fontSize * sx)}*(${piecewise(scale)}))'`;
  if (clip.transform.rotation || clip.keyframes?.rotation?.length)
    warnings.add('text rotation is preview-only');
  if (
    clip.effects.blur ||
    clip.effects.brightness ||
    clip.effects.contrast ||
    clip.effects.saturation
  ) {
    warnings.add('effects on text are preview-only');
  }
  const cx = centerExpr(clip, 'x', shift, frame, W / 2, sx);
  const cy = centerExpr(clip, 'y', shift, frame, H / 2, sy);
  const alpha = piecewise(opacityPoints(track, clip, opts.start, frame));
  const parts = [
    `textfile=${filterPath(opts.textFile(text))}`,
    fontOption(st.fontFamily, st.bold, st.italic, opts.fontFile),
    `fontsize=${fontSize}`,
    `fontcolor=${ffColor(st.color)}`,
    `text_align=${st.align === 'left' ? 'L' : st.align === 'right' ? 'R' : 'C'}`,
    `x='${cx}-text_w/2'`,
    `y='${cy}-text_h/2'`,
    `alpha='${alpha}'`,
    `enable='between(t,${num(from)},${num(to)})'`,
  ];
  if (st.backgroundColor) {
    parts.push(
      'box=1',
      `boxcolor=${ffColor(st.backgroundColor)}`,
      `boxborderw=${Math.round(size * 0.35)}`,
    );
  }
  if (st.strokeWidth > 0) {
    parts.push(`borderw=${num(st.strokeWidth * sx)}`, `bordercolor=${ffColor(st.strokeColor)}`);
  }
  chains.push(`[${base}]drawtext=${parts.join(':')}[${out}]`);
  return out;
}

function drawCaption(
  chains: string[],
  base: string,
  out: string,
  clip: CaptionClip,
  style: ReturnType<typeof CaptionStyleSchema.parse>,
  from: number,
  to: number,
  W: number,
  H: number,
  sx: number,
  opts: GraphOptions,
): string {
  const size = style.fontSize * sx;
  const pad = Math.round(size * 0.35);
  const text = wrapText(clip.text, size, style.maxWidth * W, true);
  const margin = style.margin * H;
  const y =
    style.position === 'top'
      ? `${num(margin + pad)}`
      : style.position === 'middle'
        ? `(h-text_h)/2`
        : `h-text_h-${num(margin + pad)}`;
  const parts = [
    `textfile=${filterPath(opts.textFile(text))}`,
    fontOption(style.fontFamily, true, false, opts.fontFile),
    `fontsize=${num(size)}`,
    `fontcolor=${ffColor(style.color)}`,
    'text_align=C',
    `x='(w-text_w)/2'`,
    `y='${y}'`,
    `enable='between(t,${num(from)},${num(to)})'`,
  ];
  if (style.backgroundColor) {
    parts.push('box=1', `boxcolor=${ffColor(style.backgroundColor)}`, `boxborderw=${pad}`);
  }
  chains.push(`[${base}]drawtext=${parts.join(':')}[${out}]`);
  return out;
}
