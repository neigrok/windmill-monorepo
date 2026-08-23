// The week offer's timing: armed during the load, fired WEEK_OFFER_GAP_MS behind the ceremony that
// closes the open, and caught by a cap when no ceremony speaks. On its tick the cap stands aside
// while a ceremony is still coming, bounded by CEREMONY_TAIL_MAX_DEFERRALS.

export const WEEK_OFFER_GAP_MS = 120;         // the offer follows the ceremony's last beat
export const CEREMONY_TAIL_CAP_MS = 2600;
export const CEREMONY_TAIL_MAX_DEFERRALS = 3; // ~8s of standing aside, then the net closes

export class WeekOfferGate {
  constructor(ceremonyBusy) {
    this.ceremonyBusy = ceremonyBusy; // () => boolean — is a ceremony live or pending right now
    this.armed = null;                // { run, timer, deferrals }; run is null once the ask is away
  }

  arm(run) {
    this.drop();
    this.armed = { run, deferrals: 0, timer: setTimeout(() => this.onCap(), CEREMONY_TAIL_CAP_MS) };
  }

  follow() { this.fire(WEEK_OFFER_GAP_MS); }

  drop() {
    if (this.armed) clearTimeout(this.armed.timer);
    this.armed = null;
  }

  onCap() {
    const armed = this.armed;
    if (!armed?.run) return;
    if (this.ceremonyBusy() && armed.deferrals < CEREMONY_TAIL_MAX_DEFERRALS) {
      armed.deferrals += 1;
      armed.timer = setTimeout(() => this.onCap(), CEREMONY_TAIL_CAP_MS);
      return;
    }
    this.fire(0);
  }

  // The ask goes out once: the first fire spends `run`.
  fire(delay) {
    const armed = this.armed;
    if (!armed?.run) return;
    clearTimeout(armed.timer);
    this.armed = { run: null, deferrals: armed.deferrals, timer: setTimeout(armed.run, delay) };
  }
}
