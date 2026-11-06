// The private lane's replica: one last-writer-wins register per node over `complete | none`. `none` is a value, not a deletion, so a step cleared elsewhere converges instead of being
// resurrected by an older `complete`.
// Two clocks: `at` is the stamp and decides what wins; `markedAt` is when the mark was recorded,
// the server's instant, and the only one that may be shown to a person.
// Keep this lane separate from TreeLattice: the structure is shared with everyone who can read the
// tree and this is one account's private overlay. They share a socket, a clock and a stored blob —
// never a frame.

import { VersionVector, compareHlc, hlcText, parseHlc } from './lattice.js';

const UNSET = { ms: 0, counter: 0, actor: '' };
const STATUSES = new Set(['complete', 'none']);

function newMark() {
  return { status: 'none', at: { ...UNSET }, markedAt: null };
}

export function progressStamp(text) {
  if (typeof text !== 'string' || !/^(0|[1-9]\d*):(0|[1-9]\d*):[\x20-\x7e]{1,64}$/.test(text)) return null;
  const at = parseHlc(text);
  if (!Number.isSafeInteger(at.ms) || at.counter >= 2 ** 32) return null;
  return at;
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

  // Invalid rows are reported and skipped; every valid row in the frame still joins.
  join(frame, onInvalidMark = () => {}) {
    const rows = frame?.marks ?? [];
    if (!Array.isArray(rows)) {
      onInvalidMark();
      return new VersionVector();
    }
    const valid = [];
    for (const row of rows) {
      const identity = typeof row?.node === 'string' && row.node.length > 0;
      const status = row?.status === 'active' || row?.status === 'inProgress' || STATUSES.has(row?.status);
      const at = progressStamp(row?.at);
      if (!identity || !status || !at) {
        onInvalidMark();
        continue;
      }
      valid.push({ row, at });
    }

    const frontier = new VersionVector();
    for (const { row, at } of valid) {
      frontier.observe(at);
      const record = this.markRecord(row.node);
      const order = compareHlc(at, record.at);
      if (order < 0) continue; // an older stamp changes nothing, its date included
      if (order === 0) {
        // Only the server puts a markedAt on the wire, so any that arrives is the receipt.
        if (Number.isFinite(row.markedAt)) record.markedAt = row.markedAt;
        continue;
      }
      record.status = STATUSES.has(row.status) ? row.status : 'none';
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

  // The stored replica carries `markedAt`; the transport projects marks to node, status and at.
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

  overlay() {
    const completed = new Set();
    const completedAt = {};
    for (const [node, record] of this.marks) {
      if (record.status === 'complete') {
        completed.add(node);
        if (record.markedAt != null) completedAt[node] = record.markedAt;

      }
    }
    return { completed, completedAt };
  }
}
