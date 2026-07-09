import * as THREE from 'three';
import { FRUIT, NODE_STATES } from '../theme.js';

// Bakes the 4 fruit states once onto an offscreen canvas — a 2x2 grid of
// glossy circles — so NodeLayer can sample the right cell per instance instead
// of drawing gradients per node per frame. Glow and any leaf flourish are the
// shader's job: this atlas only owns the body + ring, matching DOM SkillNode's
// radial-gradient look.
const COLS = 2;
const ROWS = 2;
const CELL_SIZE = 256;

export class NodeAtlas {
  constructor() {
    this.cols = COLS;
    this.rows = ROWS;
    this.cellSize = CELL_SIZE;

    const canvas = document.createElement('canvas');
    canvas.width = COLS * CELL_SIZE;
    canvas.height = ROWS * CELL_SIZE;
    const ctx = canvas.getContext('2d');

    NODE_STATES.forEach((state, index) => {
      const col = index % COLS;
      const row = Math.floor(index / COLS);
      this.paintFruit(ctx, col * CELL_SIZE, row * CELL_SIZE, FRUIT[state]);
    });

    this.texture = new THREE.CanvasTexture(canvas);
    // Canvas is top-left origin and the fragment shader samples cells assuming the
    // same; three's default flipY would invert V and swap the atlas rows (locked↔active,
    // available↔complete) and flip each fruit's highlight. Keep the canvas orientation.
    this.texture.flipY = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
  }

  paintFruit(ctx, left, top, style) {
    const radius = CELL_SIZE * 0.42;
    const cx = left + CELL_SIZE / 2;
    const cy = top + CELL_SIZE / 2;
    const highlightX = cx - radius * 0.18;
    const highlightY = cy - radius * 0.18;

    const gradient = ctx.createRadialGradient(highlightX, highlightY, 0, cx, cy, radius);
    gradient.addColorStop(0, style.inner);
    gradient.addColorStop(0.75, style.outer);
    gradient.addColorStop(1, style.outer);

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.lineWidth = CELL_SIZE * 0.03;
    ctx.strokeStyle = style.ring;
    ctx.stroke();
  }

  cellForState(state) {
    const index = NODE_STATES.indexOf(state);
    return { col: index % this.cols, row: Math.floor(index / this.cols) };
  }

  dispose() {
    this.texture.dispose();
  }
}
