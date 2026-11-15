// What Talk holds for the tab, outliving the journal room: the take a refusal kept and the face that says why, a take
// × let go with its Undo, a send still with the server, a transcript that landed while the room was away, and the
// refusal only a date lifts. Leaving the page asks first while any of it holds a recording; an account change forgets it
// all, so a recording never crosses accounts. The room reads it through useSyncExternalStore and says it.

// How long a discarded take can still come back with Undo: the toast hold with an action (motion-language.md).
export const DISCARD_HOLD_MS = 6000;

const EMPTY = { sending: false, take: null, face: null, discarded: null, signInNeeded: false };

export class TalkStore {
  constructor({ target = globalThis.window, timers = globalThis } = {}) {
    this.target = target;
    this.timers = timers;
    this.state = EMPTY;
    this.listeners = new Set();
    // A send answers into the epoch it began in; an account change starts a new one, so a late answer lands nowhere.
    this.epoch = 0;
    this.remembered = null;
    this.unwritten = null;
    this.writer = null;
    this.undoTimer = null;
    this.guarding = false;
  }

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.state;

  // The room's way into today. A transcript that landed while no room was there is written as the room comes back.
  attach(writer) {
    this.writer = writer;
    if (this.unwritten) {
      const text = this.unwritten;
      this.unwritten = null;
      this.change({});
      writer(text);
    }
    return () => { if (this.writer === writer) this.writer = null; };
  }

  // A send is with the server; its answer settles into this epoch, or into none if the account changed meanwhile.
  begin() {
    this.change({ sending: true, face: null });
    return this.epoch;
  }

  // The take was transcribed: its words go into today and the take it was is let go. False when the answer came too
  // late to belong to anyone.
  written(ticket, text) {
    if (ticket !== this.epoch) return false;
    this.state.take?.release();
    if (text && this.writer) this.writer(text);
    else if (text) this.unwritten = text;
    this.change({ sending: false, take: null, face: null });
    return true;
  }

  // The take was refused: it stays, under the face that says why.
  kept(ticket, take, refusal) {
    if (ticket !== this.epoch) { take.release(); return; }
    if (refusal.until !== null) this.remembered = refusal;
    this.change({ sending: false, take, face: { refusal, moment: 'take', announced: false } });
  }

  // A refusal said without a take: before the microphone opened, or remembered from earlier in the tab.
  show(refusal, moment) {
    if (refusal.until !== null) this.remembered = refusal;
    this.change({ face: { refusal, moment, announced: false } });
  }

  // The remembered refusal, while its date has not come.
  blocking(now) {
    return this.remembered?.blocks(now) ? this.remembered : null;
  }

  // True once per face shown, so its event is sent once however often the sheet renders it.
  announce(face) {
    if (this.state.face !== face || face.announced) return false;
    this.change({ face: { ...face, announced: true } });
    return true;
  }

  // A face with nothing held goes with the sheet; one holding a take waits behind the mic's dot.
  dismiss() {
    if (this.state.discarded) this.letGo();
    if (!this.state.take) this.change({ face: null });
  }

  discard() {
    const gone = this.state.take;
    this.timers.clearTimeout(this.undoTimer);
    this.undoTimer = this.timers.setTimeout(() => this.letGo(), DISCARD_HOLD_MS);
    this.change({ take: null, discarded: gone });
  }

  undo() {
    this.timers.clearTimeout(this.undoTimer);
    this.change({ take: this.state.discarded, discarded: null });
  }

  letGo() {
    this.timers.clearTimeout(this.undoTimer);
    this.state.discarded?.release();
    this.change({ discarded: null });
  }

  needSignIn(needed) {
    this.change({ signInNeeded: needed });
  }

  // An account change: nothing this tab held for the last account survives it.
  forget() {
    this.epoch += 1;
    this.timers.clearTimeout(this.undoTimer);
    this.state.take?.release();
    this.state.discarded?.release();
    this.remembered = null;
    this.unwritten = null;
    this.state = EMPTY;
    this.change({});
  }

  change(next) {
    this.state = { ...this.state, ...next };
    const holding = Boolean(this.state.take || this.state.sending || this.unwritten);
    if (holding !== this.guarding && this.target) {
      this.target[holding ? 'addEventListener' : 'removeEventListener']('beforeunload', leaveAsks);
      this.guarding = holding;
    }
    this.listeners.forEach((listener) => listener());
  }
}

function leaveAsks(event) {
  event.preventDefault();
  event.returnValue = '';
}

export const talkStore = new TalkStore();
