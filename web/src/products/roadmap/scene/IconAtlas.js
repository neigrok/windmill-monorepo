import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from '../../../design-system/Icon.jsx';

// Rasterizes each distinct node icon into an alpha-mask atlas canvas that the
// node shader samples for its glyph. Reuses the app's Icon registry (one source
// of truth, only registered icons bundle). Rasterization is async (SVG -> Image
// decode); onReady fires once the canvas is filled so the scene can re-upload it.
const CELL = 192;
const CAPACITY = 64;
const GLYPH_INSET = 0.28;

export class IconAtlas {
  constructor(iconNames) {
    const names = [...new Set(iconNames)].slice(0, CAPACITY);
    this.cols = Math.max(1, Math.ceil(Math.sqrt(names.length)));
    this.rows = Math.max(1, Math.ceil(names.length / this.cols));
    this.cellByName = new Map();
    this.ready = false;
    this.readyCallbacks = [];

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.cols * CELL;
    this.canvas.height = this.rows * CELL;
    const ctx = this.canvas.getContext('2d');

    let pending = 0;
    const settle = () => {
      pending -= 1;
      if (pending > 0) return;
      this.ready = true;
      this.readyCallbacks.forEach((cb) => cb());
      this.readyCallbacks = [];
    };

    names.forEach((name, index) => {
      const markup = renderToStaticMarkup(createElement(Icon, { name, color: '#ffffff', size: CELL, strokeWidth: 2.25 }));
      if (!markup) return;
      this.cellByName.set(name, index);

      const inset = CELL * GLYPH_INSET;
      const size = CELL - inset * 2;
      const col = index % this.cols;
      const row = Math.floor(index / this.cols);
      const image = new Image();
      pending += 1;
      image.onload = () => { ctx.drawImage(image, col * CELL + inset, row * CELL + inset, size, size); settle(); };
      image.onerror = settle;
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    });

    if (pending === 0) this.ready = true;
  }

  onReady(cb) {
    if (this.ready) cb();
    else this.readyCallbacks.push(cb);
  }

  cellFor(name) {
    const cell = this.cellByName.get(name);
    return cell === undefined ? -1 : cell;
  }
}
