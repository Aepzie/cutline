import { useRef, useState, type DragEvent } from 'react';
import { FileAudio, FileVideo, Image as ImageIcon, Plus, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { Asset } from '@cutline/core';
import { probeMedia } from '@cutline/engine';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { convertWithFfmpegWasm } from '@/lib/ffmpeg-fallback';
import { useEditor } from '@/lib/store';
import { cn, formatBytes, formatTimecode } from '@/lib/utils';
import { ASSET_DRAG_TYPE } from './timeline/Timeline';

const ICON = { video: FileVideo, audio: FileAudio, image: ImageIcon };
const IMAGE = /^image\//;
let uploadSeq = 0;

interface Upload {
  id: number;
  name: string;
  progress: number;
  phase: 'checking' | 'converting' | 'uploading';
}

/** Probes in the browser; offers ffmpeg.wasm conversion for formats WebCodecs can't decode. */
async function prepare(file: File, setPhase: (u: Partial<Upload>) => void): Promise<File> {
  if (IMAGE.test(file.type)) return file;
  setPhase({ phase: 'checking' });
  const probe = await probeMedia(file).catch(() => null);
  const undecodable =
    !probe ||
    (probe.hasVideo && !probe.canDecodeVideo) ||
    (probe.hasAudio && !probe.canDecodeAudio);
  if (!undecodable) return file;
  const convert = window.confirm(
    `"${file.name}" uses a format this browser cannot preview${probe?.videoCodec ? ` (${probe.videoCodec})` : ''}.\n\n` +
      'Convert it to H.264/AAC MP4 in your browser with ffmpeg.wasm? This downloads ~30 MB (once) from jsDelivr and runs locally.\n\n' +
      'Cancel uploads the original file (the server can still render it, but the preview will not show it).',
  );
  if (!convert) return file;
  setPhase({ phase: 'converting', progress: 0 });
  return convertWithFfmpegWasm(file, (progress) => setPhase({ progress }));
}

export function AssetBin() {
  const project = useEditor((s) => s.project);
  const projectId = useEditor((s) => s.projectId);
  const dispatch = useEditor((s) => s.dispatch);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | File[]) => {
    if (!projectId) return;
    for (const original of Array.from(files)) {
      const id = ++uploadSeq;
      const patch = (u: Partial<Upload>) =>
        setUploads((list) => list.map((x) => (x.id === id ? { ...x, ...u } : x)));
      setUploads((list) => [...list, { id, name: original.name, progress: 0, phase: 'checking' }]);
      try {
        const file = await prepare(original, patch);
        patch({ phase: 'uploading', progress: 0 });
        const { asset } = await api.upload(projectId, file, file.name, (progress) =>
          patch({ progress }),
        );
        toast.success(`Imported ${asset.name}`);
      } catch (err) {
        toast.error(`Could not import ${original.name}`, {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setUploads((list) => list.filter((x) => x.id !== id));
      }
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
  };

  const addToTimeline = (asset: Asset) => void dispatch([{ type: 'add_clip', assetId: asset.id }]);

  const removeFromProject = async (asset: Asset) => {
    if (!project) return;
    const clips = project.tracks.flatMap((track) =>
      track.clips.filter((clip) => 'assetId' in clip && clip.assetId === asset.id),
    );
    if (
      clips.length > 0 &&
      !window.confirm(
        `"${asset.name}" is used by ${clips.length} timeline clip${clips.length === 1 ? '' : 's'}.\n\nRemove the asset and all of its timeline clips? You can undo this action.`,
      )
    )
      return;

    if (
      await dispatch(
        [{ type: 'remove_asset', assetId: asset.id, removeClips: true }],
        'Remove asset',
      )
    )
      toast.success(`Removed ${asset.name} from the project`);
  };

  return (
    <section
      aria-label="Media"
      className={cn('flex h-full min-h-0 flex-col', dragOver && 'bg-primary/10')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Media</h2>
        <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>
          <Upload /> Import
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          accept="video/*,audio/*,image/*,.mkv,.mov"
          className="hidden"
          aria-label="Import media files"
          onChange={(e) => {
            if (e.target.files) void upload(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {uploads.map((u) => (
          <li key={u.id} className="rounded-md border border-border bg-surface-2/50 p-2 text-xs">
            <div className="truncate">{u.name}</div>
            <div className="mt-1 text-muted">
              {u.phase === 'checking'
                ? 'Checking…'
                : `${u.phase === 'converting' ? 'Converting' : 'Uploading'} ${Math.round(u.progress * 100)}%`}
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded bg-surface">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${u.progress * 100}%` }}
              />
            </div>
          </li>
        ))}
        {project?.assets.map((asset) => {
          const Icon = ICON[asset.kind];
          return (
            <li key={asset.id}>
              <div
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className="group flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 hover:border-border hover:bg-surface-2/60"
              >
                <Icon className="size-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm" title={asset.name}>
                    {asset.name}
                  </div>
                  <div className="text-[11px] text-muted">
                    {asset.duration !== null ? formatTimecode(asset.duration, 1) : 'image'}
                    {asset.width ? ` · ${asset.width}×${asset.height}` : ''}
                    {asset.sizeBytes ? ` · ${formatBytes(asset.sizeBytes)}` : ''}
                  </div>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Add ${asset.name} to the timeline`}
                  onClick={() => addToTimeline(asset)}
                >
                  <Plus />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${asset.name} from the project`}
                  title="Remove from project"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeFromProject(asset);
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          );
        })}
        {project && project.assets.length === 0 && uploads.length === 0 && (
          <li className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted">
            Drop video, audio or images here, or ask your AI agent to <code>add_asset</code>.
          </li>
        )}
      </ul>
    </section>
  );
}
