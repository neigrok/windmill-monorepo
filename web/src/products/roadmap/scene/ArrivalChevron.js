// Off-screen births announce themselves here (burst-camera): a bark pill hugging
// the viewport edge along the bearing to the newest arrivals, its glyph rotated
// toward them and a count that accumulates across a burst. It informs — it never
// moves the camera; clicking it asks the scene to glide there. It fades after a
// few quiet seconds, retargets + re-arms on every fresh burst, and dissolves on
// its own the moment the target scrolls into view. A scene overlay repositioned
// from the render loop, styled inline so it owns no CSS, like HoverLabel.

const EDGE_INSET = 20; // screen px between the viewport edge and the pill's center
const LINGER_MS = 4200; // quiet time before an unclicked chevron fades away

export class ArrivalChevron {
  constructor(canvas, { onReveal }) {
    this.pill = document.createElement('div');
    this.pill.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'z-index:12',
      'display:flex', 'align-items:center', 'gap:5px',
      'padding:5px 10px', 'border-radius:999px',
      'background:#2A231A', 'color:#F4EFE6',
      'border:1px solid rgba(240,180,41,0.55)',
      'box-shadow:0 0 14px rgba(240,180,41,0.35)',
      'font-size:11px', 'font-weight:600', 'line-height:1', 'white-space:nowrap',
      'cursor:pointer', 'user-select:none',
      'opacity:0', 'pointer-events:none',
      'transition:opacity 220ms ease', 'will-change:transform,opacity',
    ].join(';');
    this.count = document.createElement('span');
    this.arrow = document.createElement('span');
    this.arrow.textContent = '➤';
    this.arrow.style.cssText = 'display:inline-block;color:#F0B429;font-size:10px;will-change:transform';
    this.pill.append(this.count, this.arrow);
    this.pill.addEventListener('click', () => {
      const target = this.target;
      this.clear();
      if (target) onReveal(target.x, target.y);
    });
    canvas.parentElement.appendChild(this.pill);
    this.target = null; // { x, y, count } — world-space centroid of the latest burst
    this.fadeTimer = null;
  }

  announce(nodes) {
    let x = 0;
    let y = 0;
    for (const node of nodes) { x += node.x; y += node.y; }
    const count = (this.target?.count ?? 0) + nodes.length;
    this.target = { x: x / nodes.length, y: y / nodes.length, count };
    this.count.textContent = count === 1 ? 'new step' : `${count} new steps`;
    this.pill.style.opacity = '1';
    this.pill.style.pointerEvents = 'auto';
    clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => this.clear(), LINGER_MS);
  }

  clear() {
    this.target = null;
    this.pill.style.opacity = '0';
    this.pill.style.pointerEvents = 'none';
    clearTimeout(this.fadeTimer);
  }

  update(camera) {
    if (!this.target) return;
    const sx = (this.target.x - camera.x) * camera.zoom + camera.viewportWidth / 2;
    const sy = (this.target.y - camera.y) * camera.zoom + camera.viewportHeight / 2;
    const w = camera.viewportWidth;
    const h = camera.viewportHeight;
    if (sx >= 0 && sx <= w && sy >= 0 && sy <= h) { this.clear(); return; } // seen — dissolve
    const dx = sx - w / 2;
    const dy = sy - h / 2;
    const tx = dx !== 0 ? (dx > 0 ? w - EDGE_INSET - w / 2 : EDGE_INSET - w / 2) / dx : Infinity;
    const ty = dy !== 0 ? (dy > 0 ? h - EDGE_INSET - h / 2 : EDGE_INSET - h / 2) / dy : Infinity;
    const t = Math.min(tx, ty);
    this.pill.style.transform = `translate(${w / 2 + dx * t}px, ${h / 2 + dy * t}px) translate(-50%, -50%)`;
    this.arrow.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
  }

  dispose() {
    clearTimeout(this.fadeTimer);
    this.pill.remove();
  }
}
