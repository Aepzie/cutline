import { describe, expect, it } from 'vitest';
import { applyOperations, createProject, sequentialContext } from '@cutline/core';
import { buildRenderGraph } from '../src/render/graph';

function captionGraph(
  options: {
    words?: Array<{ text: string; start: number; end: number }> | null;
    start?: number;
    backgroundColor?: string | null;
    text?: string;
  } = {},
) {
  const ctx = sequentialContext();
  const base = createProject(
    { name: 'Caption highlight', settings: { width: 640, height: 360 } },
    ctx,
  );
  const defaultWords = [
    { text: 'Hello', start: 1.1, end: 1.4 },
    { text: 'there', start: 1.4, end: 1.8 },
    { text: 'friend', start: 1.8, end: 2.4 },
  ];
  const words = options.words === undefined ? defaultWords : (options.words ?? undefined);
  const project = applyOperations(
    base,
    [
      {
        type: 'add_captions',
        cues: [
          {
            start: 1,
            end: 4,
            text: options.text ?? 'Hello there friend',
            ...(words !== undefined && { words }),
          },
        ],
        style: {
          highlightColor: '#ffcc00',
          fontSize: 32,
          backgroundColor: options.backgroundColor !== undefined ? options.backgroundColor : null,
          position: 'top',
        },
      },
    ],
    ctx,
  ).project;
  const textFiles: string[] = [];
  const start = options.start ?? 0;
  const graph = buildRenderGraph(project, new Map(), {
    start,
    end: 4,
    width: 640,
    height: 360,
    fps: 30,
    includeAudio: false,
    textFile: (content) => {
      textFiles.push(content);
      return `text${textFiles.length}.txt`;
    },
  });
  return { graph, textFiles };
}

describe('server caption word highlighting', () => {
  it('adds timed highlight overlays with font alignment and keeps the approximate warning', () => {
    const { graph, textFiles } = captionGraph();
    expect(graph.warnings).toContain('caption word highlighting is approximate in server renders');
    expect(graph.warnings).not.toContain('caption word highlighting is preview-only');
    expect(textFiles).toEqual(['Hello there friend', 'Hello', 'there', 'friend']);
    expect(graph.filter.match(/drawtext=/g)).toHaveLength(4);
    expect(graph.filter).toContain('fontcolor=0xffcc00@1');
    expect(graph.filter).toContain('y_align=font');
    expect(graph.filter).toContain('expansion=none');
    expect(graph.filter).toContain('between(t,1.1,1.4)');
    expect(graph.filter).toContain('between(t,1.4,1.8)');
    expect(graph.filter).toContain('between(t,1.8,2.4)');
  });

  it('keeps plain captions when word timings are absent or do not match tokens', () => {
    const untimed = captionGraph({ words: null });
    expect(untimed.textFiles).toEqual(['Hello there friend']);
    expect(untimed.graph.filter.match(/drawtext=/g)).toHaveLength(1);

    const empty = captionGraph({ words: [] });
    expect(empty.textFiles).toEqual(['Hello there friend']);
    expect(empty.graph.filter.match(/drawtext=/g)).toHaveLength(1);

    const mismatched = captionGraph({
      words: [{ text: 'Hello', start: 1.1, end: 1.4 }],
    });
    expect(mismatched.textFiles).toEqual(['Hello there friend']);
    expect(mismatched.graph.filter.match(/drawtext=/g)).toHaveLength(1);
    expect(mismatched.graph.warnings).not.toContain('caption word highlighting is preview-only');
  });

  it('shifts word timing into the selected render range', () => {
    const { graph } = captionGraph({
      start: 1.25,
      words: [
        { text: 'Hello', start: 1.1, end: 1.4 },
        { text: 'there', start: 1.5, end: 1.8 },
        { text: 'friend', start: 1.8, end: 2.4 },
      ],
    });
    expect(graph.filter).toContain('between(t,0.25,0.55)');
  });

  it('resolves overlapping word timings using findIndex first-match rule', () => {
    const { graph } = captionGraph({
      words: [
        { text: 'Hello', start: 1.0, end: 2.0 },
        { text: 'there', start: 1.5, end: 2.5 },
        { text: 'friend', start: 2.5, end: 3.0 },
      ],
    });
    // Word 0 is active from 1.0 to 2.0
    expect(graph.filter).toContain('between(t,1,2)');
    // Word 1 was 1.5 to 2.5, but Word 0 takes 1.0 to 2.0, so Word 1 is active 2.0 to 2.5
    expect(graph.filter).toContain('between(t,2,2.5)');
    // Word 2 is active 2.5 to 3.0
    expect(graph.filter).toContain('between(t,2.5,3)');
  });

  it('draws a background box with drawbox when backgroundColor is set', () => {
    const { graph } = captionGraph({ backgroundColor: '#000000b3' });
    expect(graph.filter).toContain('drawbox=');
    expect(graph.filter).toContain('color=0x000000@0.7');
    expect(graph.filter).toContain(':t=fill:');
  });

  it('handles percent signs and backslashes cleanly with expansion=none', () => {
    const { graph, textFiles } = captionGraph({
      text: '100% done \\ path',
      words: [
        { text: '100%', start: 1.1, end: 1.5 },
        { text: 'done', start: 1.5, end: 1.8 },
        { text: '\\', start: 1.8, end: 2.0 },
        { text: 'path', start: 2.0, end: 2.5 },
      ],
    });
    expect(textFiles[0]).toBe('100% done \\ path');
    expect(graph.filter).toContain('expansion=none');
  });
});
