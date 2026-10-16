import { memo, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Bot, Lock } from 'lucide-react';
import { clipEnd, clipSpeed, isFreeze, isReversed, type Clip, type Track } from '@cutline/core';
import type { BeatInfo } from '@/lib/api';
import { useBeats } from '@/lib/beats';
import { useEnvelopes } from '@/lib/envelopes';
import { HIGHLIGHT_MS, useEditor } from '@/lib/store';
import { cn } from '@/lib/utils';
import { TRACK_HEIGHT, beatTimes } from './geometry';
import { sampleWaveform } from './waveform';

export type DragKind = 'move' | 'trim-start' | 'trim-end';

// Note: not `bg-clip-*`, which collides with Tailwind's background-clip utilities.
const COLORS: Record<Clip['type'], string> = {
  video: 'bg-media-video',
  image: 'bg-media-image',
  audio: 'bg-media-audio',
  text: 'bg-media-text',
  caption: 'bg-media-caption',
  shape: 'bg-media-shape',
};

function useHighlight(clipId: string) {
  const highlight = useEditor((s) => s.highlights[clipId]);
  const [, force] = useState(0);
  const active = Boolean(highlight && highlight.until > Date.now());
  useEffect(() => {
    if (!highlight) return;
    const left = highlight.until - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => force((n) => n + 1), Math.min(left, HIGHLIGHT_MS) + 20);
    return () => clearTimeout(t);
  }, [highlight]);
  return active ? highlight : undefined;
}

function label(clip: Clip, assetName: string | undefined): string {
  if (clip.type === 'text' || clip.type === 'caption') return clip.text;
  if (clip.type === 'shape')
    return clip.name ?? (clip.shape === 'ellipse' ? 'Ellipse' : 'Rectangle');
  return clip.name ?? assetName ?? clip.type;
}

/** "2×", "◀ reverse", "0.5× ◀ reverse" or "❄ freeze" for retimed clips. */
export function speedBadge(clip: Clip): string | null {
  if (isFreeze(clip)) return '❄ freeze';
  const parts: string[] = [];
  const speed = clipSpeed(clip);
  if (speed !== 1) parts.push(`${Number(speed.toFixed(2))}×`);
  if (isReversed(clip)) parts.push('◀ reverse');
  return parts.length ? parts.join(' ') : null;
}

export const ClipView = memo(function ClipView({
  clip,
  track,
  zoom,
  dragging,
  onBeginDrag,
}: {
  clip: Clip;
  track: Track;
  zoom: number;
  dragging: boolean;
  onBeginDrag: (clip: Clip, kind: DragKind, e: PointerEvent) => void;
}) {
  const selected = useEditor((s) => s.selection.includes(clip.id));
  const assetName = useEditor((s) =>
    'assetId' in clip ? s.project?.assets.find((a) => a.id === clip.assetId)?.name : undefined,
  );
  const waveformAsset = useEditor((s) => {
    if (clip.type !== 'audio' && clip.type !== 'video') return undefined;
    return s.project?.assets.find((asset) => asset.id === clip.assetId && asset.hasAudio);
  });
  const projectId = useEditor((s) => s.projectId);
  const select = useEditor((s) => s.select);
  const grid = useBeats((s) => ('assetId' in clip ? s.byAsset[clip.assetId] : undefined));
  const highlight = useHighlight(clip.id);
  // Clips an agent proposal would change, while that proposal is previewed.
  const proposed = useEditor((s) => s.preview?.affectedIds.includes(clip.id) ?? false);
  const width = Math.max(2, clip.duration * zoom);
  const text = label(clip, assetName);
  const badge = speedBadge(clip);
  const height = TRACK_HEIGHT[track.kind] - 6;

  const start = (kind: DragKind) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onBeginDrag(clip, kind, e);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${clip.type} clip ${text}, ${clip.start.toFixed(2)} to ${clipEnd(clip).toFixed(2)} seconds${track.locked ? ', locked' : ''}`}
      data-clip-id={clip.id}
      data-proposed={proposed || undefined}
      className={cn(
        'group absolute top-[3px] isolate overflow-hidden rounded-md text-[11px] text-white/95 shadow-sm outline-offset-1 transition-[box-shadow,opacity]',
        COLORS[clip.type],
        selected && 'ring-2 ring-white',
        (highlight || proposed) && 'agent-highlight',
        dragging && 'opacity-40',
        track.locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing',
      )}
      style={{ left: clip.start * zoom, width, height }}
      onPointerDown={start('move')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select([clip.id], e.shiftKey);
        }
      }}
    >
      {'transitionIn' in clip && clip.transitionIn && (
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 bg-gradient-to-r from-black/45 to-transparent"
          style={{ width: Math.min(width, (clip.transitionIn.duration / 2) * zoom) }}
        />
      )}
      {grid && <BeatTicks clip={clip} grid={grid} zoom={zoom} />}
      {waveformAsset && projectId && 'sourceStart' in clip && (
        <ClipWaveform
          projectId={projectId}
          assetId={waveformAsset.id}
          sourceStart={clip.sourceStart}
          duration={clip.duration * clipSpeed(clip)}
          reversed={isReversed(clip)}
          zoom={zoom}
        />
      )}
      <div className="pointer-events-none flex h-full items-start gap-1 px-1.5 py-1">
        {track.locked && <Lock className="size-3 shrink-0 opacity-70" />}
        {highlight && (
          <Bot
            className="size-3 shrink-0"
            aria-label={`changed by ${highlight.origin.name ?? 'agent'}`}
          />
        )}
        <span className="truncate font-medium leading-tight">{text}</span>
      </div>
      {badge && (
        <span
          data-speed-badge
          className="pointer-events-none absolute bottom-0.5 left-1.5 rounded bg-black/40 px-1 text-[9px] font-semibold leading-tight"
        >
          {badge}
        </span>
      )}
      {'muted' in clip && clip.muted && (
        <span className="pointer-events-none absolute bottom-0.5 right-1 text-[9px] uppercase opacity-70">
          muted
        </span>
      )}
      {!track.locked && width > 14 && (
        <>
          <div
            aria-hidden
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/40"
            onPointerDown={start('trim-start')}
          />
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/40"
            onPointerDown={start('trim-end')}
          />
        </>
      )}
    </div>
  );
});

function ClipWaveform({
  projectId,
  assetId,
  sourceStart,
  duration,
  reversed,
  zoom,
}: {
  projectId: string;
  assetId: string;
  sourceStart: number;
  duration: number;
  reversed: boolean;
  zoom: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const envelope = useEnvelopes((s) =>
    s.projectId === projectId ? s.byAsset[assetId] : undefined,
  );

  useEffect(() => {
    void useEnvelopes.getState().load(projectId, assetId);
  }, [projectId, assetId]);

  useEffect(() => {
    const node = canvas.current;
    if (!node || !envelope || envelope.peak.length === 0) return;
    const rect = node.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (rect.width <= 0 || rect.height <= 0) return;

    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const sampleWidth = Math.min(width, 4096);
    node.width = Math.round(sampleWidth * ratio);
    node.height = Math.round(height * ratio);
    const context = node.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, sampleWidth, height);

    const peaks = sampleWaveform(envelope, sourceStart, duration, sampleWidth, reversed);
    const center = height / 2;
    const maxHalfHeight = height * 0.38;
    // dB scale: map linear 0..1 → dBFS → 0..1 over −48…0 dBFS range so
    // moderate-level audio (e.g. −18 dBFS) is clearly visible.
    const DB_FLOOR = -48;
    const toDbNorm = (linear: number) => {
      if (linear <= 0) return 0;
      const db = 20 * Math.log10(linear);
      return Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));
    };
    context.beginPath();
    context.strokeStyle = 'rgba(255, 255, 255, 0.62)';
    context.lineWidth = 1;
    for (let x = 0; x < peaks.length; x++) {
      const peak = peaks[x] ?? 0;
      if (peak <= 0) continue;
      const amplitude = Math.max(0.6, toDbNorm(peak) * maxHalfHeight);
      context.moveTo(x + 0.5, center - amplitude);
      context.lineTo(x + 0.5, center + amplitude);
    }
    context.stroke();
  }, [envelope, sourceStart, duration, zoom]);

  if (!envelope || envelope.peak.length === 0) return null;
  return (
    <canvas
      ref={canvas}
      aria-hidden
      data-waveform={assetId}
      className="pointer-events-none absolute inset-0 z-0 size-full opacity-75"
    />
  );
}

/** Beat markers along the bottom of a clip; bars are taller. Thinned out when zoomed far out. */
function BeatTicks({ clip, grid, zoom }: { clip: Clip; grid: BeatInfo; zoom: number }) {
  const spacing = grid.bpm > 0 ? (60 / grid.bpm) * zoom : 0;
  if (spacing < 4 && (!grid.downbeats || spacing * 4 < 4)) return null;
  const barsOnly = spacing < 4;
  const beats = beatTimes(clip, barsOnly ? grid.downbeats : grid.beats);
  const bars = new Set(beatTimes(clip, grid.downbeats));
  return (
    <div aria-hidden data-beats={beats.length} className="pointer-events-none absolute inset-0">
      {beats.map((t) => (
        <div
          key={t}
          className="absolute bottom-0 w-px bg-white/70"
          style={{ left: (t - clip.start) * zoom, height: bars.has(t) ? '45%' : '22%' }}
        />
      ))}
    </div>
  );
}
