// Composes the motion-language "sentence" — camera ease → travel → bloom → pulse
// → toast (guidelines/motion-language.md X1) — into one ceremony at a time. The
// director is pure sequencing: it holds no GL state and reaches growth only through
// injected collaborators (node/edge batches, camera, a toast sink, a seconds clock,
// a motion flag). Only upward changes arrive here — growth is the one thing
// celebrated; the scene applies downward dims itself.
//
// One ceremony plays at a time; changes that land mid-ceremony coalesce and
// celebrate once. Any canvas grab fast-forwards the live beats to their end state
// over a single YIELD; the toast still speaks.

import { TIER_COMPLETE } from '../theme.js';

// Canonical constants — guidelines/motion-language.md §6. Milliseconds.
const IGNITE = 280;
const BLOSSOM = 620; // matches the shader bloom window — pulse/toast land after it settles
const HANDOFF = 0.85;
const DEPEND_AT = 0.90;
const TOAST_GAP = 120;
const YIELD = 150;
const IDLE_COALESCE = 400;
const JITTER = 60; // ±, seeded per node
const SETTLE_POLL = 16;
const SETTLE_CAP = 760; // never wait past the 720ms camera cap + slack
const CADENCE = 320;       // one depth ring enters this long after the previous
const CADENCE_FLOOR = 160; // compress no tighter than this when a deep tree won't fit
const CEREMONY_MAX = 2400; // structural budget, first ignite -> last settle
const ARRIVAL_REST_MAX = 400; // past this many nodes the rings are skipped — one cross-fade, toast intact

export class CeremonyDirector {
  constructor(deps) {
    this.nodes = deps.nodes;   // { igniteNode(id, atSec, toTier, opts), pulse(id, atSec) }
    this.edges = deps.edges;   // { travel(from, to, atSec, opts), edgeDuration(from, to) }
    this.camera = deps.camera; // { glideTo(x, y), settleProgress() }
    this.speak = deps.speak;   // (message, { action }) => void — action is an optional {label, run}
    this.clock = deps.clock;   // () => elapsedSeconds
    this.motion = deps.motion; // () => 0 | 1

    this.live = null;    // { changeset, spoken }
    this.pending = null; // coalesced changeset waiting for the floor to clear
    this.timers = [];
    this.settleTimer = null;
    this.idleTimer = null;
    this.editing = false;
  }

  // ---- external signals ------------------------------------------------

  // A growth changeset. While editing, hold and celebrate once the canvas idles;
  // while a ceremony plays, coalesce into the next; otherwise begin now.
  celebrate(changeset) {
    if (!changeset) return;
    if (!changeset.risen.length) {
      // Nothing grew (e.g. an in-progress step completed with no child to open) —
      // there's no beat to play, but a summary still speaks, once, if the floor is clear.
      if (changeset.summary && !this.live && !this.editing) this.speak(changeset.summary, { action: changeset.action });
      return;
    }
    if (this.editing) { this.pending = merge(this.pending, changeset); this.armIdle(); return; }
    if (this.live) { this.pending = merge(this.pending, changeset); return; }
    this.begin(changeset);
  }

  setEditing(editing) {
    if (this.editing === editing) return;
    this.editing = editing;
    if (!editing) this.armIdle();
  }

  // Pointer-down / wheel / pinch: the user always wins. Fast-forward the live beats
  // to their end state over one YIELD; the toast still speaks.
  yieldToInput() {
    if (!this.live) return;
    const cs = this.live.changeset;
    const spoken = this.live.spoken;
    this.clearTimers();
    this.settleAll(cs);
    if (cs.summary && !spoken) this.schedule(YIELD, () => this.speak(cs.summary, { action: cs.action }));
    this.live = null;
    this.drain();
  }

  // A ceremony is coming: one is live, or one waits (coalesced, or held for the canvas to idle)
  // for the floor. Every path that ends a ceremony — spoken, reduced, summary-less, yielded,
  // cancelled — clears `live`, so this goes false even when nothing was said.
  busy() { return this.live !== null || this.pending !== null; }

  cancel() {
    this.clearTimers();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.live = null;
    this.pending = null;
  }

  // ---- the sentence ----------------------------------------------------

  begin(changeset) {
    this.live = { changeset, spoken: false };
    if (this.motion() === 0) { this.playReduced(changeset); return; }
    if (changeset.focus) this.camera.glideTo(changeset.focus.x, changeset.focus.y);
    this.waitForSettle(() => this.playBeats(changeset));
  }

  // Completed sources full-bloom → light travels each newly-lit edge → the child
  // wakes as the light lands (handoff) → the frontier pulses → the toast speaks
  // last. Beats overlap on the canonical score; they never queue end-to-end.
  playBeats(changeset) {
    const t0 = this.clock();
    let lastSettle = 0;
    const waking = new Set();
    // A step the light will wake (a child on a newly-lit edge) blooms as the light lands, not at
    // t0 — so a chain completed in one changeset (a return-recap replay, a coalesced multi-finish)
    // cascades one bloom per node rather than every step blooming at once and re-blooming on wake.
    const woken = new Set(Object.values(changeset.wakeByEdge).map((child) => child.id));

    for (const n of changeset.risen) {
      if (n.toTier !== TIER_COMPLETE || woken.has(n.id)) continue;
      this.nodes.igniteNode(n.id, t0, TIER_COMPLETE, { blossom: true });
      lastSettle = Math.max(lastSettle, BLOSSOM);
    }

    for (const e of changeset.litEdges) {
      // e.wave staggers a multi-hop replay a cadence apart so light flows down a chain in order;
      // ordinary single-hop completions carry no wave and ride IGNITE exactly as before.
      const at = IGNITE + (e.wave ?? 0) * CADENCE;
      const dur = this.edges.edgeDuration(e.from, e.to) || IGNITE;
      this.schedule(at, () => this.edges.travel(e.from, e.to, this.clock(), {}));
      const child = changeset.wakeByEdge[key(e.from, e.to)];
      if (!child) { lastSettle = Math.max(lastSettle, at + dur); continue; }
      waking.add(child.id);
      const wakeAt = at + dur * HANDOFF + jitter(child.id);
      this.schedule(wakeAt, () => this.nodes.igniteNode(child.id, this.clock(), child.toTier, { blossom: child.toTier === TIER_COMPLETE }));
      lastSettle = Math.max(lastSettle, wakeAt + BLOSSOM);
    }

    for (const n of changeset.risen) {
      if (n.toTier === TIER_COMPLETE || waking.has(n.id)) continue;
      this.nodes.igniteNode(n.id, t0, n.toTier, {});
      lastSettle = Math.max(lastSettle, BLOSSOM);
    }

    for (const id of changeset.frontier) this.schedule(lastSettle, () => this.nodes.pulse(id, this.clock()));

    this.schedule(lastSettle + TOAST_GAP, () => this.speakNow(changeset));
    this.schedule(lastSettle + TOAST_GAP + 1, () => { this.live = null; this.drain(); });
  }

  // uMotion = 0: no glide, no travel head, no stagger, no pulse — every riser
  // cross-fades to its end tier (the shaders clamp the fade to 150ms), then a toast.
  playReduced(changeset) {
    this.settleAll(changeset);
    this.schedule(IGNITE, () => { this.speakNow(changeset); this.live = null; this.drain(); });
  }

  // #3 paste arrival: the whole roadmap comes alive. The scene has dimmed everything
  // and fit the camera; here each depth ring wakes on the 320ms cadence (light travels
  // the edges into it), the root's crown ignites first, and one toast plants the tree.
  // A deep tree compresses the cadence to a floor; rings past the budget join the last.
  // Reduced motion and trees past the sanity ceiling take the one-beat cross-fade
  // instead — the pre-dimmed tree settles to rest and the toast still speaks.
  arrival(plan) {
    this.live = { changeset: arrivalChangeset(plan), spoken: false };
    const planted = plan.rings.reduce((sum, ring) => sum + ring.length, 0);
    if (this.motion() === 0 || planted > ARRIVAL_REST_MAX) { this.playReduced(this.live.changeset); return; }

    const rings = plan.rings;
    let cadence = CADENCE;
    if (rings.length * cadence > CEREMONY_MAX) cadence = Math.max(CADENCE_FLOOR, Math.floor(CEREMONY_MAX / rings.length));
    const lastAnimated = Math.min(rings.length - 1, Math.floor(CEREMONY_MAX / cadence));
    let lastSettle = 0;

    rings.forEach((ring, depth) => {
      const at = Math.min(depth, lastAnimated) * cadence; // rings past the budget join the last beat
      // Arrived-complete steps wake DIRECTLY into their complete rest — imported history
      // is shown, never replayed (paste-import §04). Live completions keep their bloom.
      for (const node of ring) this.schedule(at + jitter(node.id), () => this.nodes.igniteNode(node.id, this.clock(), node.tier, { blossom: false }));
      for (const e of plan.litEdgesByRing[depth]) this.schedule(at, () => this.edges.travel(e.from, e.to, this.clock(), {}));
      lastSettle = Math.max(lastSettle, at + BLOSSOM);
    });

    this.schedule(lastSettle + TOAST_GAP, () => this.speakNow(this.live.changeset));
    this.schedule(lastSettle + TOAST_GAP + 1, () => { this.live = null; this.drain(); });
  }

  // ---- plumbing --------------------------------------------------------

  settleAll(changeset) {
    const now = this.clock();
    for (const n of changeset.risen) this.nodes.igniteNode(n.id, now, n.toTier, { durationMs: YIELD, blossom: false });
    for (const e of changeset.litEdges) this.edges.travel(e.from, e.to, now, { durationMs: YIELD });
  }

  speakNow(changeset) {
    if (!changeset.summary || (this.live && this.live.spoken)) return;
    if (this.live) this.live.spoken = true;
    this.speak(changeset.summary, { action: changeset.action });
  }

  // Dependent beats begin at DEPEND_AT of the camera settle — or now, when the
  // glide no-op'd because the target already sat inside the safe frame. Capped so
  // a cancelled/absent glide never leaves the ceremony hanging.
  waitForSettle(run) {
    if (this.camera.settleProgress() >= DEPEND_AT) { run(); return; }
    const start = this.clock();
    this.settleTimer = setInterval(() => {
      if (this.camera.settleProgress() >= DEPEND_AT || (this.clock() - start) * 1000 >= SETTLE_CAP) {
        clearInterval(this.settleTimer);
        this.settleTimer = null;
        run();
      }
    }, SETTLE_POLL);
  }

  drain() { if (this.pending) { const next = this.pending; this.pending = null; this.begin(next); } }
  armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.idleTimer = null; if (!this.editing && !this.live) this.drain(); }, IDLE_COALESCE);
  }
  schedule(ms, fn) { this.timers.push(setTimeout(fn, ms)); }
  clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.settleTimer) { clearInterval(this.settleTimer); this.settleTimer = null; }
  }
}

const key = (from, to) => `${from}|${to}`;

// The arrival's end state, for a yield/reduced-motion fast-forward: every ring node
// that lights (tier >= 1) rose from the dimmed baseline, and every ring edge lights.
function arrivalChangeset(plan) {
  const risen = plan.rings.flat().filter((n) => n.tier >= 1).map((n) => ({ id: n.id, fromTier: 0, toTier: n.tier, x: n.x, y: n.y }));
  return { focus: null, risen, fell: [], litEdges: plan.litEdgesByRing.flat(), wakeByEdge: {}, frontier: [], summary: plan.summary, action: null };
}

function jitter(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return ((Math.abs(h) % 1000) / 1000 * 2 - 1) * JITTER;
}

function merge(a, b) {
  if (!a) return b;
  return {
    focus: a.focus ?? b.focus,
    risen: dedupe([...a.risen, ...b.risen], (n) => n.id),
    litEdges: dedupe([...a.litEdges, ...b.litEdges], (e) => key(e.from, e.to)),
    wakeByEdge: { ...a.wakeByEdge, ...b.wakeByEdge },
    frontier: [...new Set([...a.frontier, ...b.frontier])],
    summary: b.summary ?? a.summary,
    // The action belongs to whichever summary won — never pair a milestone's Share button with a
    // later ordinary step's line.
    action: b.summary != null ? b.action : a.action,
  };
}

function dedupe(items, keyOf) {
  const seen = new Map();
  for (const item of items) seen.set(keyOf(item), item);
  return [...seen.values()];
}
