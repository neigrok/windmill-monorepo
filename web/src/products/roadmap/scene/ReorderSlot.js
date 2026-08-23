// Dashed insertion-slot ring for angular reorder: a screen-space DOM overlay, editor-only.

export class ReorderSlot {
  constructor(canvas) {
    this.container = document.createElement('div');
    this.container.className = 'st-reorder-layer';
    canvas.parentElement.appendChild(this.container);

    this.ring = document.createElement('div');
    this.ring.className = 'st-reorder-slot';
    this.container.appendChild(this.ring);
  }

  show() {
    this.container.classList.add('st-reorder-layer--on');
  }

  moveTo(x, y, diameter) {
    this.ring.style.width = `${diameter}px`;
    this.ring.style.height = `${diameter}px`;
    this.ring.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  }

  hide() {
    this.container.classList.remove('st-reorder-layer--on');
  }

  dispose() {
    this.container.remove();
  }
}
