// The private lane's replica: one last-writer-wins register per node over `complete | active |
// none`. `none` is a value, not a deletion, so a step cleared elsewhere converges instead of being
// resurrected by an older `complete`.
// Two clocks: `at` is the stamp and decides what wins; `markedAt` is when the mark was recorded,
// the server's instant, and the only one that may be shown to a person.
// Keep this lane separate from TreeLattice: the structure is shared with everyone who can read the
// tree and this is one account's private overlay. They share a socket, a clock and a stored blob —
// never a frame.

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

  // Folds a frame of stamped registers in and returns the frontier of the stamps it carried.
  // Validates before mutating, so a malformed frame leaves the replica untouched.
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
        // Only the server puts a markedAt on the wire, so any that arrives is the receipt.
        if (Number.isFinite(row.markedAt)) record.markedAt = row.markedAt;
        continue;
      }
      record.status = row.status;
      record.at = at;
      // A frame with no instant leaves the register undated rather than guessing one.
      record.markedAt = Number.isFinite(row.markedAt) ? row.markedAt : null;
    }
    return frontier;
  }

  // A mark made here, dated provisionally by this device. Returns the frame that carries it, or
  // null when the stamp lost to one already held.
  mark(nodeId, status, at, nowMs) {
    if (!STATUSES.has(status)) throw new Error(`unknown progress status "${status}"`);
    const record = this.markRecord(nodeId);
    if (compareHlc(at, record.at) <= 0) return null;
    record.status = status;
    record.at = at;
    record.markedAt = nowMs;
    return { marks: [{ node: nodeId, status, at: hlcText(at) }] };
  }

  // The outbox, derived rather than kept: every register the coverage does not account for.
  // `markedAt` never goes on the wire. Emitted in node order, here and in toFrame, so equal
  // replicas serialize to equal bytes.
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

  // The whole replica as one frame, for the stored blob; it carries `markedAt`.
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

  // One register answers both dates: an active mark's `markedAt` is when it started, a complete
  // one's is when it finished.
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
