export const SWIPE_REVEAL = 96;
const SLOP = 10;
const EDGE = 24;

export class SwipeGesture {
  constructor({ x, y, width, open = false }) {
    this.x = x;
    this.y = y;
    this.open = open;
    this.claimed = false;
    this.rejected = x <= EDGE || x >= width - EDGE;
    this.threshold = false;
    this.offset = open ? SWIPE_REVEAL : 0;
  }

  move(x, y) {
    if (this.rejected) return { claimed: false, offset: this.offset, tick: false };
    const dx = x - this.x;
    const dy = y - this.y;
    if (!this.claimed && Math.hypot(dx, dy) >= SLOP) {
      this.rejected = Math.abs(dy) > Math.abs(dx) * Math.tan(Math.PI / 6) || (!this.open && dx < 0);
      this.claimed = !this.rejected;
    }
    if (!this.claimed) return { claimed: false, offset: this.offset, tick: false };
    const distance = Math.max(0, dx + (this.open ? SWIPE_REVEAL : 0));
    const tick = distance >= SWIPE_REVEAL && !this.threshold;
    this.threshold ||= tick;
    this.offset = distance <= SWIPE_REVEAL ? distance : SWIPE_REVEAL + (distance - SWIPE_REVEAL) * 0.35;
    return { claimed: true, offset: this.offset, tick };
  }

  release() { return this.claimed ? this.offset >= SWIPE_REVEAL : this.open; }
}
