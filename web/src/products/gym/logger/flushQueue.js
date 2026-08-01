// THE LOCAL-FIRST WRITE — a set is the lifter's the instant they tap, and the network's problem
// afterwards. Every set carries a CLIENT-MINTED id, which IS the idempotency key: a replay of a
// set that already landed answers 200 with the stored row, even after the session closed, so this
// queue can send in any order, any number of times, and the log converges on one row per id.
//
// The four verdicts, and none of them is guesswork about English:
//   remint   409 set-id-taken   — that id names a row outside this session; mint a fresh one, resend
//   refused  400 / other 409s   — this body will never land; SURFACE it, never swallow it
//   retry    5xx and no-response — the store or the signal failed; keep it queued, keep the order
//   wait     401 / 404          — neither lost nor retryable; it waits for a sign-in or a session
//
// Three rules decide the shape of the walk, and each of them is a set somebody lifted:
//
//   · BY IDENTITY, NEVER BY POSITION. The lifter's thumb runs while a send is in the air — Undo
//     withdraws, the next set enqueues — so the head that comes back is not the head that went
//     out. Every entry is found again by its set id or not at all.
//   · ORDER IS PER SESSION AND MOVEMENT, because that is the only order the server keeps: it
//     numbers sets max+1 per (session, exercise). A set that cannot land holds up its own lane and
//     nothing else. A jam that stopped the whole queue stopped a whole workout, silently.
//   · THE HOLD IS THE UNDO WINDOW, and it is a promise the DEVICE keeps: the log is append-only,
//     so a set the lifter may still take back has not been sent yet. It costs nothing, because the
//     store is already holding the set. When the store REFUSED the write there is nothing being
//     held, the network is the only durability left, and the hold goes.
//
// And the rule the backend made non-negotiable: a set that never landed is REFUSED once the
// session is finished. So the queue flushes BEFORE finish, and finishing is only allowed to
// complete when this session's sets have all landed. An auto-close that fires over an unflushed
// queue is the one case the device cannot see coming — which is why a refusal is reported, never
// counted as delivered.

export const UNDO_WINDOW_MS = 9000;
const MAX_REMINTS = 3;

export function mintId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return prefix + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function verdictFor(error) {
  if (typeof error?.status !== 'number') return 'retry';
  if (error.setIdTaken) return 'remint';
  if (error.terminal) return 'refused';
  if (error.retryable) return 'retry';
  return 'wait';
}

export function refusalOf(error) {
  if (error?.sessionFinished) return 'the session closed before this set reached it';
  if (error?.unknownExercise) return 'that movement is not in the catalog';
  return error?.detail || 'the log refused this set';
}

// The lane is the key the server numbers sets under: set_number is max+1 per session and movement.
function laneOf(entry) {
  return `${entry.sessionId} ${entry.exerciseId}`;
}

// The store is a foreign input — another tab's write, or an older build's shape. A missing counter
// must never read as "no repairs left" or "held back forever".
function fromStore(entry) {
  return { attempts: 0, remints: 0, heldUntil: 0, ...entry };
}

export function localStore(key, storage) {
  return {
    read() {
      try {
        const stored = JSON.parse(storage.getItem(key));
        return Array.isArray(stored) ? stored : [];
      } catch {
        return [];
      }
    },
    // The answer is the queue's, not a courtesy: a full or blocked store must never break a log,
    // but a set it would not take is not "saved on this device" and nothing may say that it is.
    write(entries) {
      try {
        storage.setItem(key, JSON.stringify(entries));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export class FlushQueue {
  constructor({ api, store, mint = () => mintId('set_'), onReport = () => {}, now = () => Date.now(), holdMs = UNDO_WINDOW_MS }) {
    this.api = api;
    this.store = store;
    this.mint = mint;
    this.onReport = onReport;
    this.now = now;
    this.holdMs = holdMs;
    this.entries = store.read().map(fromStore);
    this.running = null;
    this.settled = new Set();
    this.durable = true;
  }

  get pending() {
    return this.entries;
  }

  enqueue(entry) {
    const held = { ...entry, attempts: 0, remints: 0, heldUntil: this.now() + this.holdMs };
    this.entries = [...this.entries, held];
    this.persist();
    return held;
  }

  withdraw(setId) {
    if (!this.entries.some((entry) => entry.setId === setId)) return false;
    this.settle(setId);
    this.persist();
    return true;
  }

  // Settled means this device is done with the id — delivered, refused, re-minted away or taken
  // back. It is what keeps the merge below from adopting an entry straight back off the disk.
  settle(setId) {
    this.settled.add(setId);
    this.entries = this.entries.filter((entry) => entry.setId !== setId);
  }

  // Every tab writes the whole key, so a tab that writes what it read at construction erases the
  // sets another tab has logged since. The union is by set id, in the order the sets were
  // performed, and a set another tab left behind is adopted rather than orphaned — a tab the phone
  // discards is otherwise the only thing that knew about it.
  mergeStore() {
    const mine = new Set(this.entries.map((entry) => entry.setId));
    const adopted = this.store.read()
      .filter((entry) => !mine.has(entry.setId) && !this.settled.has(entry.setId))
      .map(fromStore);
    if (adopted.length === 0) return false;
    this.entries = [...this.entries, ...adopted].sort((left, right) => left.completedAt - right.completedAt);
    return true;
  }

  persist() {
    this.mergeStore();
    this.durable = this.store.write(this.entries);
    return this.durable;
  }

  // A forced caller never inherits a sweep's non-forced walk — it runs after it. `running` is
  // cleared only by the walk that set it, so the forced run chained behind a sweep is never
  // orphaned into a second walk over the same entries.
  flush({ force = false } = {}) {
    if (this.running && !force) return this.running;
    const walk = (this.running ?? Promise.resolve()).then(() => this.deliver(force));
    const chained = walk.finally(() => { if (this.running === chained) this.running = null; });
    this.running = chained;
    return chained;
  }

  // Finishing is the client's statement that everything THIS session holds is already delivered.
  // A set stranded against another session — one that closed under it, one belonging to a sign-in
  // that has since ended — is not this session's business and can never stop it closing.
  async flushBeforeFinish(sessionId) {
    const report = await this.flush({ force: true });
    const stranded = this.entries.filter((entry) => entry.sessionId === sessionId);
    return { drained: stranded.length === 0, stranded, report };
  }

  readyToSend(entry, force) {
    if (force) return true;
    if (!this.durable) return true;
    return entry.heldUntil <= this.now();
  }

  async deliver(force) {
    const report = { delivered: [], reminted: [], refused: [], restored: [], pending: [] };
    const blocked = new Set();
    let moved = this.mergeStore();
    for (;;) {
      const entry = this.entries.find((each) => !blocked.has(laneOf(each)) && this.readyToSend(each, force));
      if (!entry) break;
      const outcome = await this.send(entry);
      if (!this.entries.some((each) => each.setId === entry.setId)) {
        // Undo took it back while it was in the air. If it landed anyway the log HAS it, and the
        // log is append-only — so the row comes back to the screen rather than the lifter being
        // left with a set in their history that nothing on the device admits to.
        if (outcome.verdict !== 'delivered') continue;
        report.restored.push({ entry, stored: outcome.stored });
        moved = true;
        continue;
      }
      if (outcome.verdict === 'delivered') {
        report.delivered.push({ entry, stored: outcome.stored });
        this.settle(entry.setId);
        moved = true;
        continue;
      }
      if (outcome.verdict === 'remint' && entry.remints < MAX_REMINTS) {
        // The repair budget is its own counter: a set that spent three seconds offline has not
        // spent any of the three id collisions it is allowed to survive.
        const reminted = { ...entry, setId: this.mint(), remints: entry.remints + 1 };
        report.reminted.push({ from: entry.setId, to: reminted.setId });
        this.settled.add(entry.setId);
        this.entries = this.entries.map((each) => (each.setId === entry.setId ? reminted : each));
        moved = true;
        continue;
      }
      if (outcome.verdict === 'remint' || outcome.verdict === 'refused') {
        report.refused.push({ entry, reason: outcome.reason });
        this.settle(entry.setId);
        moved = true;
        continue;
      }
      this.entries = this.entries.map((each) => (
        each.setId === entry.setId ? { ...each, attempts: each.attempts + 1 } : each));
      blocked.add(laneOf(entry));
      moved = true;
    }
    // A flush that found nothing to do touches neither the store nor the surface — the background
    // sweep runs every few seconds for the length of a workout, and an idle one should cost nothing.
    if (!moved) {
      report.pending = this.entries;
      return report;
    }
    this.persist();
    report.pending = this.entries;
    this.onReport(report);
    return report;
  }

  async send(entry) {
    try {
      const stored = await this.api.appendSet(entry.sessionId, {
        id: entry.setId,
        exerciseId: entry.exerciseId,
        weightKg: entry.weightKg,
        reps: entry.reps,
        kind: entry.kind,
        completedAt: entry.completedAt,
      });
      return { verdict: 'delivered', stored };
    } catch (error) {
      return { verdict: verdictFor(error), reason: refusalOf(error) };
    }
  }
}
