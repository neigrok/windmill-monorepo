// The private lane's replica (docs/GRAPH_SYNC_DESIGN.md §12) — the same lattice the structure
// uses, one register wide. A node's mark is a last-writer-wins register over
// `complete | active | none`, stamped by whichever replica made it; `none` is a VALUE, not a
// deletion, which is the whole reason a step cleared on a phone converges here instead of being
// resurrected by this browser's older `complete`.
//
// It is separate from TreeLattice on purpose and must stay that way: the structure is shared with
// everyone who can read the tree, and this is one account's private overlay. They ride one socket,
// one clock and one stored blob — never one frame.
//
// TWO CLOCKS, and mixing them up is the bug this lane was built to end. `at` is the stamp: it
// decides what wins and nothing else. `markedAt` is when the mark was RECORDED — the server's own
// instant, which is the only one that can be asserted to a person, because an HLC's ms is the
// writing device's clock and a wrong device clock would confidently date work in the wrong week.
// A mark this device just made carries its own local instant until the server's echo replaces it:
// that is this device asserting about its own action, in the moment, to the person who took it —
// not a foreign clock being trusted.

import { VersionVector, compareHlc, hlcText, parseHlc } from './lattice.js';

const UNSET = { ms: 0, counter: 0, actor: '' };
const STATUSES = new Set(['complete', 'active', 'none']);

function newMark() {
  return { status: 'none', at: { ...UNSET }, markedAt: null };
}

export class ProgressLattice {
  constructor() {
    this.marks = new Map(); // nodeId -> { status, at, markedAt }
  }

  markRecord(nodeId) {
    let record = this.marks.get(nodeId);
    if (!record) { record = newMark(); this.marks.set(nodeId, record); }
    return record;
  }

  // Fold a frame of stamped registers in, and return the frontier of the stamps it carried — the
  // one merge, shared by the subscribe graft, a live echo and the stored blob, exactly as
  // TreeLattice.join is. Validates before mutating so a malformed frame leaves the replica
  // untouched and the caller can treat the throw as a gap.
  join(frame) {
    const rows = frame?.marks ?? [];
    for (const row of rows) {
      if (typeof row?.node !== 'string' || !row.node) throw new Error('malformed progress mark');
      if (!STATUSES.has(row.status)) throw new Error(`unknown progress status "${row.status}"`);
    }

    const frontier = new VersionVector();
    for (const row of rows) {
      const at = parseHlc(row.at);
      frontier.observe(at);
      const record = this.markRecord(row.node);
      const order = compareHlc(at, record.at);
      if (order < 0) continue; // an older stamp changes nothing, its date included
      if (order === 0) {
        // The SAME stamp — our own mark coming back as an echo, or the stored blob being reloaded.
        // The register is already right, but the instant may not be: a mark made here carries this
        // device's provisional one until the server states its own. Only the server ever puts a
        // markedAt on the wire (deltaSince never sends one up), so any that arrives is the
        // authoritative receipt and replaces the guess. Without this the provisional stands
        // forever, and on a device with a wrong clock it is wrong forever.
        if (Number.isFinite(row.markedAt)) record.markedAt = row.markedAt;
        continue;
      }
      record.status = row.status;
      record.at = at;
      // The receipt instant belongs to the stamp that won. A frame with no instant (this device's
      // own write, before the echo) leaves the register undated rather than guessing one.
      record.markedAt = Number.isFinite(row.markedAt) ? row.markedAt : null;
    }
    return frontier;
  }

  // A mark made here: stamped, dated by this device provisionally, and folded through the same
  // join every remote frame takes — so a local write and a remote one cannot diverge in how they
  // land. Returns the frame that carries it, or null when the stamp lost to one already held.
  mark(nodeId, status, at, nowMs) {
    if (!STATUSES.has(status)) throw new Error(`unknown progress status "${status}"`);
    const record = this.markRecord(nodeId);
    if (compareHlc(at, record.at) <= 0) return null;
    record.status = status;
    record.at = at;
    record.markedAt = nowMs;
    return { marks: [{ node: nodeId, status, at: hlcText(at) }] };
  }

  // The outbox, derived rather than kept (§6): every register the given coverage does not already
  // account for. `markedAt` is deliberately absent — it is the server's statement about when it
  // took delivery, and a replica asserting it back upward would be inventing a receipt.
  //
  // Emitted in node order, here and in toFrame, so that equal replicas serialize to equal bytes.
  // A Map iterates by insertion, so without this two replicas that reached the same lattice point
  // by seeing the same frames in different orders would produce different frames — convergence
  // that no byte comparison, stored blob or golden fixture could actually check.
  deltaSince(vector) {
    const marks = [];
    for (const node of [...this.marks.keys()].sort()) {
      const record = this.marks.get(node);
      if (record.at.ms === 0 && record.at.counter === 0 && !record.at.actor) continue;
      if (vector && vector.covers(record.at)) continue;
      marks.push({ node, status: record.status, at: hlcText(record.at) });
    }
    return { marks };
  }

  // The whole replica as one frame — the stored blob. Unlike the wire delta this DOES carry
  // `markedAt`, because the blob is this device remembering what the server told it, not this
  // device telling the server something.
  toFrame() {
    const marks = [];
    for (const node of [...this.marks.keys()].sort()) {
      const record = this.marks.get(node);
      const row = { node, status: record.status, at: hlcText(record.at) };
      if (record.markedAt != null) row.markedAt = record.markedAt;
      marks.push(row);
    }
    return { marks };
  }

  seedClock(clock) {
    for (const record of this.marks.values()) clock.observe(record.at);
  }

  // The present-time projection every render path consumes — the same shape the load pipeline
  // always handed the view. One register answers both dates: a step that is ACTIVE was marked
  // active at `markedAt`, which is when it started; a COMPLETE one was marked complete then,
  // which is when it finished. There is no third fact to keep, and no second map to disagree.
  overlay() {
    const completed = new Set();
    const inProgress = new Set();
    const startedAt = {};
    const completedAt = {};
    for (const [node, record] of this.marks) {
      if (record.status === 'complete') {
        completed.add(node);
        if (record.markedAt != null) completedAt[node] = record.markedAt;
      } else if (record.status === 'active') {
        inProgress.add(node);
        if (record.markedAt != null) startedAt[node] = record.markedAt;
      }
    }
    return { completed, inProgress, startedAt, completedAt };
  }
}
