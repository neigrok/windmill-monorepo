// The single compositor for everything Windmill exports (X2 share identity). Given a
// resolved ShareFrame recipe + the tree's RenderModel it paints the whole postcard —
// mat, kind rule, tree portrait, identity strip — onto one Canvas2D. The Share dialog
// shows this exact canvas and downloads this exact canvas, so preview and export can
// never drift. Pure paint: the recipe (geometry, hues, type sizes) comes from the
// frame; the tree drawing comes from treePortraitSvg; this file only lays them down.

import { treePortraitSvg } from './TreePortrait.js';

export async function renderShareCanvas(frame, model, { scale = 1 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = frame.w * scale;
  canvas.height = frame.h * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  await document.fonts.ready; // Baloo 2 / Nunito / JetBrains Mono ready before fillText
  const fonts = resolveFonts();

  ctx.fillStyle = frame.palette.mat;
  ctx.fillRect(0, 0, frame.w, frame.h);

  if (frame.variant === 'intro') {
    paintIntroCard(ctx, frame, fonts);
    return canvas;
  }

  ctx.fillStyle = frame.hue.c;
  ctx.fillRect(0, 0, frame.w, frame.rule);

  paintPanel(ctx, frame);
  await paintPortrait(ctx, frame, model);
  paintIdentityStrip(ctx, frame, fonts);
  return canvas;
}

export function canvasToPngBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export function canvasToDataUrl(canvas) {
  return canvas.toDataURL('image/png');
}

// Canvas2D parses `ctx.font` as a raw CSS font shorthand — it can't resolve `var()`,
// so we read the design-system font stacks off the document root once per render and
// build real font strings from them.
function resolveFonts() {
  const style = getComputedStyle(document.documentElement);
  const read = (name) => style.getPropertyValue(name).trim() || 'sans-serif';
  return { display: read('--font-display'), body: read('--font-body'), mono: read('--font-mono') };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function paintPanel(ctx, frame) {
  const p = frame.panelRect();
  const border = frame.panelBorder();
  roundRectPath(ctx, p.x, p.y, p.w, p.h, frame.panelRadius());
  ctx.fillStyle = frame.palette.panel;
  ctx.fill();
  ctx.lineWidth = border.width;
  ctx.strokeStyle = border.color;
  ctx.stroke();
}

// Rasterize the standalone tree SVG and draw it clipped inside the rounded panel.
async function paintPortrait(ctx, frame, model) {
  if (!model) return;
  const p = frame.panelRect();
  const svg = treePortraitSvg(model, frame.palette, { w: p.w, h: p.h });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
    ctx.save();
    roundRectPath(ctx, p.x, p.y, p.w, p.h, frame.panelRadius());
    ctx.clip();
    ctx.drawImage(img, p.x, p.y, p.w, p.h);
    ctx.restore();
  } catch {
    // portrait failed to rasterize — leave the panel as the empty cream canvas
  } finally {
    URL.revokeObjectURL(url);
  }
}

// The GIF title card (variant 'intro'): a centered kind dot, the wordmark, the title.
// No tree — this is the frame the animation opens on before the postcard resolves.
function paintIntroCard(ctx, frame, fonts) {
  const l = frame.introLayout();
  const k = frame.k;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const blockH = l.dot + l.gap + l.wordmark + l.gap + l.title;
  let y = l.cy - blockH / 2;

  ctx.save();
  ctx.shadowColor = `rgba(${frame.hue.rgb},.55)`;
  ctx.shadowBlur = 22 * k;
  ctx.fillStyle = frame.hue.c;
  ctx.beginPath();
  ctx.arc(l.cx, y + l.dot / 2, l.dot / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  y += l.dot + l.gap;

  ctx.fillStyle = frame.palette.text;
  ctx.font = `800 ${l.wordmark}px ${fonts.display}`;
  ctx.fillText('Windmill', l.cx, y + l.wordmark / 2);
  y += l.wordmark + l.gap;

  ctx.fillStyle = frame.palette.sub;
  ctx.font = `${l.title}px ${fonts.body}`;
  ctx.fillText(frame.title || '', l.cx, y + l.title / 2);
}

// The bottom band: on the left the titled kind dot over a done/total progress meter;
// on the right the "Made with Windmill →" watermark (always brand terracotta).
function paintIdentityStrip(ctx, frame, fonts) {
  const k = frame.k;
  const type = frame.type();
  const stats = frame.stats;
  const left = frame.pad;
  const right = frame.w - frame.pad;
  const gap = 10 * k;

  // Two stacked rows (title, meter) vertically centered in the strip.
  const meterH = Math.max(type.count, type.barH, type.label);
  const blockH = type.title + gap + meterH;
  const blockTop = frame.h - frame.strip + (frame.strip - blockH) / 2;
  const titleMid = blockTop + type.title / 2;
  const meterMid = blockTop + type.title + gap + meterH / 2;

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  // LEFT top row — kind dot + title.
  const dotR = type.dot / 2;
  ctx.save();
  ctx.shadowColor = `rgba(${frame.hue.rgb},.55)`;
  ctx.shadowBlur = 8 * k;
  ctx.fillStyle = frame.hue.c;
  ctx.beginPath();
  ctx.arc(left + dotR, titleMid, dotR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = frame.palette.text;
  ctx.font = `700 ${type.title}px ${fonts.display}`;
  ctx.fillText(frame.title || '', left + type.dot + gap, titleMid);

  // LEFT bottom row — count, progress track + gradient fill, label.
  const countText = `${stats.done}/${stats.total}`;
  ctx.fillStyle = frame.palette.text;
  ctx.font = `600 ${type.count}px ${fonts.mono}`;
  ctx.fillText(countText, left, meterMid);
  const countW = ctx.measureText(countText).width;

  const trackX = left + countW + gap;
  const trackY = meterMid - type.barH / 2;
  roundRectPath(ctx, trackX, trackY, type.barW, type.barH, type.barH / 2);
  ctx.fillStyle = frame.palette.track;
  ctx.fill();

  if (stats.fraction > 0) {
    ctx.save();
    roundRectPath(ctx, trackX, trackY, type.barW, type.barH, type.barH / 2);
    ctx.clip();
    const grad = ctx.createLinearGradient(trackX, 0, trackX + type.barW, 0);
    grad.addColorStop(0, frame.palette.gradA);
    grad.addColorStop(1, frame.palette.gradB);
    ctx.fillStyle = grad;
    ctx.fillRect(trackX, trackY, type.barW * stats.fraction, type.barH);
    ctx.restore();
  }

  ctx.fillStyle = frame.palette.sub;
  ctx.font = `600 ${type.label}px ${fonts.body}`;
  ctx.fillText('steps done', trackX + type.barW + gap, meterMid);

  // RIGHT — "Made with Windmill →" right-aligned to the pad edge, on the title row.
  const madeWithFont = `600 ${type.madeWith * 0.75}px ${fonts.body}`;
  const wordmarkFont = `800 ${type.wordmark}px ${fonts.display}`;
  const arrowFont = `800 ${type.wordmark * 0.9}px ${fonts.display}`;
  const wmGap = 8 * k;

  ctx.font = madeWithFont;
  const madeW = ctx.measureText('Made with').width;
  ctx.font = wordmarkFont;
  const markW = ctx.measureText('Windmill').width;
  ctx.font = arrowFont;
  const arrowW = ctx.measureText('→').width;

  let x = right - (madeW + wmGap + markW + wmGap + arrowW);
  ctx.fillStyle = frame.palette.sub;
  ctx.font = madeWithFont;
  ctx.fillText('Made with', x, titleMid);
  x += madeW + wmGap;
  ctx.fillStyle = frame.palette.brand;
  ctx.font = wordmarkFont;
  ctx.fillText('Windmill', x, titleMid);
  x += markW + wmGap;
  ctx.font = arrowFont;
  ctx.fillText('→', x, titleMid);
}
