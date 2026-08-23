// Rubber-band select rect (Shift-drag): a screen-space DOM overlay, editor-only; it never picks.

export class MarqueeOverlay {
  constructor(canvas) {
    this.container = document.createElement('div');
    this.container.className = 'st-marquee-layer';
    canvas.parentElement.appendChild(this.container);

    this.rect = document.createElement('div');
    this.rect.className = 'st-marquee';
    this.container.appendChild(this.rect);
  }

  show(x0, y0) {
    this.rect.style.transform = `translate(${x0}px, ${y0}px)`;
    this.rect.style.width = '0px';
    this.rect.style.height = '0px';
    this.container.classList.add('st-marquee-layer--on');
  }

  update(x0, y0, x1, y1) {
    this.rect.style.transform = `translate(${Math.min(x0, x1)}px, ${Math.min(y0, y1)}px)`;
    this.rect.style.width = `${Math.abs(x1 - x0)}px`;
    this.rect.style.height = `${Math.abs(y1 - y0)}px`;
  }

  hide() {
    this.container.classList.remove('st-marquee-layer--on');
  }

  dispose() {
    this.container.remove();
  }
}
