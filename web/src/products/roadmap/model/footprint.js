// The box a node reserves for its disc and caption, estimated from the label's length alone — never DOM-measured, so
// every device lays the tree out byte-identically. Widths and heights are the CSS px the working view shows, divided
// by WORKING_ZOOM into world units for the layout engines.

import { BODY_WU, ROOT_BODY_SCALE, WORKING_ZOOM, CAPTION } from '../theme.js';

export function footprintOf(label, { root = false } = {}) {
  const bodyPx = BODY_WU * (root ? ROOT_BODY_SCALE : 1) * WORKING_ZOOM;
  const textPx = CAPTION.charPx * [...(label ?? '')].length;
  const captionPx = Math.min(CAPTION.maxWidthPx, CAPTION.padPx * 2 + textPx);
  const lines = textPx <= CAPTION.maxWidthPx - CAPTION.padPx * 2 ? 1 : CAPTION.maxLines;
  const widthPx = Math.max(bodyPx, captionPx);
  const heightPx = bodyPx + CAPTION.gapPx + lines * CAPTION.linePx;
  return { widthWu: widthPx / WORKING_ZOOM, heightWu: heightPx / WORKING_ZOOM, lines };
}

// The reserved rectangle of a placed node: the disc centred at (x, y), the caption hanging below it.
export function footprintRect(x, y, footprint) {
  const bodyWu = footprint.heightWu - (footprint.lines * CAPTION.linePx + CAPTION.gapPx) / WORKING_ZOOM;
  return {
    minX: x - footprint.widthWu / 2,
    maxX: x + footprint.widthWu / 2,
    minY: y - bodyWu / 2,
    maxY: y - bodyWu / 2 + footprint.heightWu,
  };
}
