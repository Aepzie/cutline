import type { Transform } from '@cutline/core';

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  /** Center of the layer in output pixels. */
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  /** Radians, clockwise. */
  rotation: number;
  alpha: number;
}

/**
 * Where a media layer goes on the canvas. Scale 1 fits the media inside the
 * project frame (contain); x/y are offsets from the center in project pixels.
 * `renderScale` maps project pixels to canvas pixels (preview < 1).
 */
export function placeMedia(
  project: Size,
  media: Size,
  transform: Transform,
  renderScale = 1,
): Placement {
  const fit = Math.min(project.width / media.width, project.height / media.height);
  const s = fit * transform.scale * renderScale;
  return {
    centerX: (project.width / 2 + transform.x) * renderScale,
    centerY: (project.height / 2 + transform.y) * renderScale,
    width: media.width * s,
    height: media.height * s,
    rotation: (transform.rotation * Math.PI) / 180,
    alpha: transform.opacity,
  };
}

/** Center position of a text layer (natural size; scale applied by the renderer). */
export function placeText(project: Size, transform: Transform, renderScale = 1) {
  return {
    centerX: (project.width / 2 + transform.x) * renderScale,
    centerY: (project.height / 2 + transform.y) * renderScale,
    scale: transform.scale,
    rotation: (transform.rotation * Math.PI) / 180,
    alpha: transform.opacity,
  };
}

export { captionCenterY } from '@cutline/core';

/** "#rrggbb" / "#rrggbbaa" → { color: 0xrrggbb, alpha: 0..1 } */
export function parseColor(hex: string): { color: number; alpha: number } {
  const h = hex.replace('#', '');
  const color = parseInt(h.slice(0, 6), 16);
  const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { color, alpha };
}
