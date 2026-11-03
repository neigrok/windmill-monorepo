export const HOLD_MS = 500;
const HOLD_SLOP = 10;

export class HoldGesture {
  constructor({ x, y, at = 0, cancelAtLimit = true }) {
    this.x = x;
    this.y = y;
    this.at = at;
    this.cancelAtLimit = cancelAtLimit;
    this.fired = false;
    this.cancelled = false;
  }

  move(x, y) {
    const distance = Math.hypot(x - this.x, y - this.y);
    if (distance > HOLD_SLOP || (this.cancelAtLimit && distance === HOLD_SLOP)) this.cancel();
  }

  advance(at) {
    if (this.cancelled || this.fired || at < this.at + HOLD_MS) return false;
    this.fired = true;
    return true;
  }

  cancel() { this.cancelled = true; }

  release() {
    this.cancel();
    return this.fired;
  }
}
