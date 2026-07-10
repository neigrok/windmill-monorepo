// The action bar that rises on node select (editing-spec §6.1): a small floating
// bar above the node with rename · kind · delete. The kind button fans the palette
// swatches around the node (§8.2); clicking one recolours. A scene overlay (plain
// DOM + callbacks, like AffordanceLayer) repositioned per frame so it tracks the
// camera. The bar chrome is neutral; only the kind swatches carry hue.
import { NODE_SIZE, NODE_COLORS, NODE_COLOR_NAMES } from '../theme.js';

const NODE_RADIUS = NODE_SIZE * 0.42;
const BAR_GAP = 20;   // screen px from the node's top rim to the bar
const FAN_GAP = 30;   // radius of the swatch fan around the node
const PENCIL = '<svg viewBox="0 0 24 24"><path d="M16 3l5 5L8 21H3v-5L16 3z"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-2 0v13H10V6M5 6v15h14V6"/></svg>';

export class SelectionBar {
  constructor(canvas, { onRename, onDelete, onSetKind } = {}) {
    this.onRename = onRename;
    this.onDelete = onDelete;
    this.onSetKind = onSetKind;

    this.container = document.createElement('div');
    this.container.className = 'st-actionbar-layer';
    canvas.parentElement.appendChild(this.container);

    this.bar = document.createElement('div');
    this.bar.className = 'st-actionbar';
    this.rename = this.button('st-actionbtn', PENCIL, () => this.onRename && this.onRename(this.selectedId));
    this.swatch = this.button('st-actionbtn st-actionbtn--swatch', '', () => { this.fanOpen = !this.fanOpen; this.render(); if (this.lastCamera) this.update(this.lastCamera); });
    this.trash = this.button('st-actionbtn st-actionbtn--danger', TRASH, () => this.onDelete && this.onDelete(this.selectedId));
    this.bar.append(this.rename, this.swatch, this.trash);
    this.container.appendChild(this.bar);

    this.fan = document.createElement('div');
    this.fan.className = 'st-kindfan';
    this.chips = NODE_COLOR_NAMES.map((kind) => {
      const chip = document.createElement('button');
      chip.className = 'st-kindchip';
      chip.style.background = NODE_COLORS[kind].base;
      chip.addEventListener('click', () => { if (this.onSetKind) this.onSetKind(this.selectedId, kind); this.fanOpen = false; this.render(); });
      this.fan.appendChild(chip);
      return { kind, el: chip };
    });
    this.container.appendChild(this.fan);

    this.nodesById = new Map();
    this.selectedId = null;
    this.fanOpen = false;
  }

  button(className, html, onClick) {
    const el = document.createElement('button');
    el.className = className;
    el.innerHTML = html;
    el.addEventListener('click', onClick);
    return el;
  }

  setModel(renderModel) {
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.setSelected(null);
  }

  setSelected(id) {
    this.selectedId = this.nodesById.has(id) ? id : null;
    this.fanOpen = false;
    this.render();
  }

  render() {
    this.container.classList.toggle('st-actionbar-layer--on', this.selectedId !== null);
    this.fan.classList.toggle('st-kindfan--on', this.fanOpen);
    const node = this.selectedId ? this.nodesById.get(this.selectedId) : null;
    if (node) this.swatch.style.background = NODE_COLORS[node.color]?.base ?? 'transparent';
  }

  update(camera) {
    this.lastCamera = camera;
    const node = this.selectedId ? this.nodesById.get(this.selectedId) : null;
    if (!node) return;
    const sx = (node.x - camera.x) * camera.zoom + camera.viewportWidth / 2;
    const sy = (node.y - camera.y) * camera.zoom + camera.viewportHeight / 2;
    const rim = NODE_RADIUS * camera.zoom;
    this.bar.style.transform = `translate(${sx}px, ${sy - rim - BAR_GAP}px) translate(-50%, -100%)`;
    if (this.fanOpen) {
      const radius = rim + FAN_GAP;
      this.chips.forEach(({ el }, i) => {
        const angle = -Math.PI / 2 + (i / this.chips.length) * Math.PI * 2;
        const x = sx + Math.cos(angle) * radius;
        const y = sy + Math.sin(angle) * radius;
        el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      });
    }
  }

  dispose() {
    this.container.remove();
  }
}
