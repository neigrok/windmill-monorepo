// The week's offer's timing, as one policy over a clock and a probe. Armed during the load; fired
// 120ms behind the ceremony that closes the open (`follow`, from the scene's one toast sink); and
// caught by a cap when no ceremony speaks. The cap is a safety net, not a schedule: on its tick it
// asks the director whether a ceremony is still coming — live or waiting for the floor — and if
// one is, it stands aside for another tail rather than racing a toast that would replace the ask
// unread. Bounded, so a director that wedges (a settle poll on a frozen clock) can never strand the
// offer; after the last deferral it fires whatever the probe says.

export const WEEK_OFFER_GAP_MS = 120;         // the offer follows the ceremony's last beat, never races it (#20 C7)
export const CEREMONY_TAIL_CAP_MS = 2600;     // past the director's 2400ms structural budget: no ceremony coming, fire anyway
export const CEREMONY_TAIL_MAX_DEFERRALS = 3; // ~8s of standing aside for a ceremony that never speaks, then the net closes

export class WeekOfferGate {
  constructor(ceremonyBusy) {
    this.ceremonyBusy = ceremonyBusy; // () => boolean — is a ceremony live or pending right now
    this.armed = null;                // { run, timer, deferrals } — run is null once the ask is on its way
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

  // The ask goes out once: the first fire spends `run`, and every later follow or cap finds it gone.
  fire(delay) {
    const armed = this.armed;
    if (!armed?.run) return;
    clearTimeout(armed.timer);
    this.armed = { run: null, deferrals: armed.deferrals, timer: setTimeout(armed.run, delay) };
  }
}
