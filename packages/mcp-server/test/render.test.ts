import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyOperations,
  createProject,
  resolveFrame,
  sequentialContext,
  type Project,
} from '@cutline/core';
import { Ffmpeg } from '../src/media/ffmpeg';
import { probeFile } from '../src/media/probe';
import { fontGroup } from '../src/render/fonts';
import { atempoChain, buildRenderGraph, wrapText } from '../src/render/graph';
import { add, isConstant, num, piecewise } from '../src/render/expr';
import { Renderer } from '../src/render/renderer';
import { LocalBlobStore } from '../src/storage/local';
import { FFMPEG, FFPROBE, ffprobe, fixture, hasFfmpeg, hasFixtures, tempDir } from './helpers';

const ffmpeg = new Ffmpeg(FFMPEG, FFPROBE);

async function fixtureProject(): Promise<{ project: Project; blobs: LocalBlobStore }> {
  const dir = await tempDir();
  const blobs = new LocalBlobStore(dir);
  const ctx = sequentialContext();
  let project = createProject({ name: 'Render', settings: { width: 640, height: 360 } }, ctx);
  const ops: unknown[] = [];
  for (const [id, file] of [
    ['test', 'testsrc-5s.mp4'],
    ['beeps', 'beeps-12s.mp4'],
    ['still', 'still.png'],
  ] as const) {
    const key = `assets/${id}/${file}`;
    await blobs.putFile(key, fixture(file));
    const p = await probeFile(fixture(file), ffmpeg);
    ops.push({ type: 'add_asset', asset: { id, name: file, src: key, ...p } });
  }
  project = applyOperations(
    project,
    [
      ...ops,
      { type: 'add_clip', assetId: 'test', start: 0, duration: 3, id: 'a' },
      { type: 'add_clip', assetId: 'beeps', start: 3, duration: 3, sourceStart: 1, id: 'b' },
      { type: 'set_transition', clipId: 'b', transition: { type: 'crossfade', duration: 1 } },
      {
        type: 'add_clip',
        assetId: 'still',
        start: 1,
        duration: 4,
        props: {
          transform: { x: 200, y: -100, scale: 0.3, rotation: 10 },
          effects: { saturation: -1, blur: 2 },
          fadeIn: 0.5,
          animationIn: { preset: 'zoom', duration: 1 },
          keyframes: {
            x: [
              { time: 0, value: 200 },
              { time: 4, value: 100, easing: 'easeInOut' },
            ],
          },
        },
      },
      {
        type: 'add_text',
        text: 'Hello Cutline',
        start: 0.5,
        duration: 4,
        style: { backgroundColor: '#00000099' },
        id: 'title',
      },
      {
        type: 'set_animation',
        clipId: 'title',
        in: { preset: 'slide-up', duration: 1 },
        out: { preset: 'pop', duration: 0.5 },
      },
      { type: 'add_captions', cues: [{ start: 0, end: 3, text: 'Server rendered captions' }] },
      { type: 'set_volume', clipId: 'a', volume: 0.5, fadeOut: 0.5 },
      {
        type: 'add_shape',
        start: 0,
        duration: 4,
        width: 360,
        height: 70,
        cornerRadius: 24,
        fill: '#2563ebcc',
        strokeWidth: 4,
        strokeColor: '#ffffff',
        transform: { y: 120 },
      },
      {
        type: 'add_shape',
        shape: 'ellipse',
        start: 0,
        duration: 6,
        width: 80,
        height: 80,
        fill: null,
        strokeWidth: 6,
        strokeColor: '#facc15',
        transform: { x: -220, y: -100 },
      },
    ],
    ctx,
  ).project;
  return { project, blobs };
}

describe('expressions', () => {
  it('formats numbers and piecewise functions', () => {
    expect(num(1.5)).toBe('1.5');
    expect(num(-0.0000001)).toBe('0');
    expect(num(Infinity)).toBe('0');
    expect(piecewise([])).toBe('1');
    expect(piecewise([{ t: 1, v: 2 }])).toBe('if(lt(t,1),2,2)');
    expect(
      piecewise([
        { t: 0, v: 0 },
        { t: 2, v: 1 },
      ]),
    ).toBe('if(lt(t,0),0,if(lt(t,2),(0+(1)*(t-0)/2),1))');
  });

  it('maps CSS font families to font groups', () => {
    expect(fontGroup('sans-serif')).toBe('sans');
    expect(fontGroup('Inter, system-ui, sans-serif')).toBe('sans');
    expect(fontGroup('serif')).toBe('serif');
    expect(fontGroup('Georgia, serif')).toBe('serif');
    expect(fontGroup('monospace')).toBe('mono');
    expect(fontGroup('"Courier New"')).toBe('mono');
  });

  it('wraps long text', () => {
    expect(wrapText('one two three four five six', 20, 160)).toBe('one two three\nfour five six');
  });

  it('adds piecewise functions and detects constants', () => {
    const ramp = [
      { t: 0, v: 0 },
      { t: 2, v: 10 },
    ];
    expect(add([], ramp)).toEqual(ramp);
    expect(add(ramp, [])).toEqual(ramp);
    expect(add(ramp, [{ t: 1, v: 1 }])).toEqual([
      { t: 0, v: 1 },
      { t: 1, v: 6 },
      { t: 2, v: 11 },
    ]);
    expect(isConstant([])).toBe(true);
    expect(isConstant([{ t: 0, v: 1 }])).toBe(true);
    expect(isConstant(ramp)).toBe(false);
  });
});

/** A red square on black that slides in from the right and zooms out. */
function animatedSquare(): Project {
  const ctx = sequentialContext();
  const project = createProject({ name: 'Anim', settings: { width: 640, height: 360 } }, ctx);
  return applyOperations(
    project,
    [
      {
        type: 'add_shape',
        start: 0,
        duration: 3,
        width: 80,
        height: 80,
        fill: '#ff0000',
        id: 'sq',
      },
      {
        type: 'set_animation',
        clipId: 'sq',
        in: { preset: 'slide-left', duration: 1 },
        out: { preset: 'zoom', duration: 1 },
      },
      { type: 'add_text', text: 'Animated', start: 0, duration: 3, transform: { y: 120 }, id: 't' },
      { type: 'set_animation', clipId: 't', in: { preset: 'pop', duration: 1 } },
    ],
    ctx,
  ).project;
}

describe('animation presets in the filtergraph', () => {
  it('turns presets into per-frame position, scale, size and alpha expressions', () => {
    const graph = buildRenderGraph(animatedSquare(), new Map(), {
      start: 0,
      end: 3,
      width: 640,
      height: 360,
      fps: 30,
      includeAudio: false,
      textFile: () => 'x.txt',
    });
    // Shape: animated overlay x, per-frame scale (zoom out) and alpha.
    expect(graph.filter).toMatch(/overlay=x='\(320\+1\*\(if\(lt\(t,0\)/);
    expect(graph.filter).toContain(':eval=frame');
    expect(graph.filter).toContain("a='alpha(X,Y)*(");
    // Text: pop scales the font size per frame.
    expect(graph.filter).toMatch(/fontsize='max\(1,72\*\(if\(lt\(t,0\),0\.3/);
  });
});

describe.runIf(hasFfmpeg && hasFixtures)('server renderer (ffmpeg)', () => {
  it('probes fixtures', async () => {
    const v = await probeFile(fixture('testsrc-5s.mp4'), ffmpeg);
    expect(v).toMatchObject({
      kind: 'video',
      width: 640,
      height: 360,
      hasAudio: true,
      hasVideo: true,
    });
    expect(v.duration).toBeCloseTo(5, 1);
    expect(v.fps).toBeCloseTo(30, 0);
    const a = await probeFile(fixture('tone-3s.wav'), ffmpeg);
    expect(a).toMatchObject({ kind: 'audio', hasVideo: false, hasAudio: true });
    const i = await probeFile(fixture('still.png'), ffmpeg);
    expect(i).toMatchObject({ kind: 'image', width: 640, height: 360, duration: null });
  });

  it('builds a graph and renders an MP4 with audio', async () => {
    const { project, blobs } = await fixtureProject();
    const graph = buildRenderGraph(project, new Map(), {
      start: 0,
      end: 6,
      width: 640,
      height: 360,
      fps: 30,
      includeAudio: true,
      textFile: () => 'x.txt',
    });
    expect(graph.warnings).toContain('missing media for clip a');

    const out = join(await tempDir(), 'out.mp4');
    const progress: number[] = [];
    const result = await new Renderer(ffmpeg, blobs).render(project, out, {
      quality: 'preview',
      onProgress: (p) => progress.push(p),
    });
    expect(result).toMatchObject({ width: 640, height: 360, fps: 30 });
    expect(result.duration).toBeCloseTo(6);
    const info = ffprobe(out);
    expect(info.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);
    expect(Number(info.format.duration)).toBeCloseTo(6, 0);
    expect(progress.length).toBeGreaterThan(0);
  }, 120_000);

  it('renders timeline frames as JPEG', async () => {
    const { project, blobs } = await fixtureProject();
    const frames = await new Renderer(ffmpeg, blobs).frames(project, [0.2, 3.2], 320);
    expect(frames).toHaveLength(2);
    if (process.env.CUTLINE_TEST_ARTIFACTS) {
      frames.forEach((f, i) =>
        writeFileSync(join(process.env.CUTLINE_TEST_ARTIFACTS!, `frame-${i}.jpg`), f),
      );
    }
    for (const f of frames) {
      expect(f[0]).toBe(0xff);
      expect(f[1]).toBe(0xd8);
      expect(f.length).toBeGreaterThan(2000);
    }
  }, 60_000);

  it('renders animation presets where the resolver puts them', async () => {
    const project = animatedSquare();
    const blobs = new LocalBlobStore(await tempDir());
    // Mid-entrance (slide + fade), at rest, mid-exit (zoom).
    const times = [0.5, 1.5, 2.5];
    const frames = await new Renderer(ffmpeg, blobs).frames(project, times, 640);
    frames.forEach((jpeg, i) => {
      if (process.env.CUTLINE_TEST_ARTIFACTS) {
        writeFileSync(join(process.env.CUTLINE_TEST_ARTIFACTS, `anim-${times[i]}.jpg`), jpeg);
      }
      const layer = resolveFrame(project, times[i]!).layers.find((l) => l.clipId === 'sq')!;
      const red = redBox(jpeg, 640, 360);
      // Same motion as the browser engine, within JPEG/anti-aliasing tolerance.
      expect(Math.abs(red.cx - (320 + layer.transform.x))).toBeLessThan(3);
      expect(Math.abs(red.width - 80 * layer.transform.scale)).toBeLessThan(4);
    });
  }, 60_000);
});

/** testsrc clips: 'fast' (2×, 0–2 s, source 0–4), 'rev' (reversed, 2–5 s, source 0–3) + a hold. */
function speedProject(): Project {
  const ctx = sequentialContext();
  const project = createProject({ name: 'Speed', settings: { width: 640, height: 360 } }, ctx);
  return applyOperations(
    project,
    [
      {
        type: 'add_asset',
        asset: {
          id: 'test',
          name: 'testsrc-5s.mp4',
          kind: 'video',
          src: 'assets/test/testsrc-5s.mp4',
          mimeType: 'video/mp4',
          duration: 5,
          width: 640,
          height: 360,
          fps: 30,
          hasVideo: true,
          hasAudio: true,
        },
      },
      { type: 'add_clip', assetId: 'test', start: 0, duration: 4, id: 'fast' },
      { type: 'set_speed', clipId: 'fast', speed: 2 },
      { type: 'add_clip', assetId: 'test', start: 2, duration: 3, id: 'rev' },
      { type: 'set_speed', clipId: 'rev', reverse: true },
      { type: 'freeze_frame', clipId: 'rev', time: 4, duration: 1, newClipId: 'hold' },
    ],
    ctx,
  ).project;
}

const graphOpts = (start: number, end: number, includeAudio = false) => ({
  start,
  end,
  width: 640,
  height: 360,
  fps: 30,
  includeAudio,
  textFile: () => 'x.txt',
});

describe('speed, reverse and freeze frames in the filtergraph', () => {
  it('chains atempo factors inside 0.5–2', () => {
    expect(atempoChain(4)).toEqual([2, 2]);
    expect(atempoChain(0.25)).toEqual([0.5, 0.5]);
    expect(atempoChain(1.5)).toEqual([1.5]);
    expect(atempoChain(16)).toEqual([2, 2, 2, 2]);
    expect(atempoChain(0.1)).toEqual([0.5, 0.5, 0.5, 0.8]);
    expect(atempoChain(1)).toEqual([1]);
  });

  it('retimes, reverses and holds video and audio', () => {
    const paths = new Map([['test', '/media/testsrc.mp4']]);
    const graph = buildRenderGraph(speedProject(), paths, graphOpts(0, 6, true));
    // 2×: reads 4 s of source and halves the timestamps.
    expect(graph.inputs[0]).toEqual(['-ss', '0', '-t', '4', '-i', '/media/testsrc.mp4']);
    expect(graph.filter).toContain('[0:v]setpts=PTS-STARTPTS,setpts=PTS/2,fps=30');
    // Reversed (source 1–3 s after the freeze split): exactly frames 30..89, then reversed.
    expect(graph.inputs[1]).toEqual(['-ss', '0.983333', '-t', '2', '-i', '/media/testsrc.mp4']);
    expect(graph.filter).toContain('[1:v]setpts=PTS-STARTPTS,reverse,setpts=PTS-STARTPTS,fps=30');
    // Freeze frame: one frame, cloned.
    expect(graph.filter).toMatch(
      /\[2:v\]trim=end_frame=1,setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone/,
    );
    // Audio: 2× → atempo=2; reversed → areverse; nothing for the silent hold.
    expect(graph.filter).toMatch(/aformat=[^,]+,atempo=2,adelay=0/);
    expect(graph.filter).toMatch(/aformat=[^,]+,areverse,adelay=2000/);
    expect(graph.filter.match(/adelay=/g)).toHaveLength(3); // fast, rev (left), rev (right)
  });
});

describe.runIf(hasFfmpeg && hasFixtures)('speed and reverse in rendered frames (ffmpeg)', () => {
  it('shows the source frames the resolver picks', async () => {
    const project = speedProject();
    const blobs = new LocalBlobStore(await tempDir());
    await blobs.putFile('assets/test/testsrc-5s.mp4', fixture('testsrc-5s.mp4'));
    const renderer = new Renderer(ffmpeg, blobs);
    // 2× fast, reversed, reversed after the hold, and the hold itself.
    const times = [0.5, 1.5, 2.5, 3.5, 5.5, 4.5];
    const frames = await renderer.frames(project, times, 640);
    frames.forEach((jpeg, i) => {
      const t = times[i]!;
      if (process.env.CUTLINE_TEST_ARTIFACTS) {
        writeFileSync(join(process.env.CUTLINE_TEST_ARTIFACTS, `speed-${t}.jpg`), jpeg);
      }
      const layer = resolveFrame(project, t).layers[0]!;
      const expected = Math.floor(layer.sourceTime! * 30 + 1e-6);
      const got = gray(jpeg);
      const candidates = [-2, -1, 0, 1, 2].map((d) => expected + d).filter((n) => n >= 0);
      const diffs = candidates.map((n) => meanDiff(got, sourceFrame(n)));
      const best = candidates[diffs.indexOf(Math.min(...diffs))];
      expect({ t, frame: best }).toEqual({ t, frame: expected });
    });
  }, 120_000);
});

function gray(jpeg: Buffer): Buffer {
  return spawnSync(
    FFMPEG,
    ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { input: jpeg, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  ).stdout;
}

const frameCache = new Map<number, Buffer>();
/** Frame `n` of the testsrc fixture, as 640×360 gray pixels. */
function sourceFrame(n: number): Buffer {
  let f = frameCache.get(n);
  if (!f) {
    f = spawnSync(
      FFMPEG,
      [
        '-v',
        'error',
        '-i',
        fixture('testsrc-5s.mp4'),
        '-vf',
        `select=eq(n\\,${n})`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        'pipe:1',
      ],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    ).stdout;
    frameCache.set(n, f);
  }
  return f;
}

function meanDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return n ? sum / n : Infinity;
}

/** Bounding box of saturated red pixels in a decoded frame. */
function redBox(jpeg: Buffer, w: number, h: number): { cx: number; width: number } {
  const raw = spawnSync(
    FFMPEG,
    ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { input: jpeg, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  ).stdout;
  let minX = w;
  let maxX = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (raw[i]! > 110 && raw[i + 1]! < 70 && raw[i + 2]! < 70) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
  }
  return { cx: (minX + maxX + 1) / 2, width: maxX - minX + 1 };
}
