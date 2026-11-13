// How a replica's structure writes are cut into socket frames. No frame is larger than the limit, but for one entry
// that alone is. A frame holds whole stamps, never part of one: the server answers a subscriber with everything past
// the stamps it covers, so a stamp half-landed when a replica grafts is one whose other half that replica is never
// sent. Frames go out in stamp order for the same reason, and a write too large for one frame is stamped once per
// frame where it is made, so each of its parts is a whole stamp of its own. One stamp can still be too large for a
// frame — in a record an earlier bundle saved, which stamped a whole act once — and that one alone is cut across
// frames under its one stamp, as that bundle sent it: stored writes are never stamped again.

import { TREE_REGISTERS, compareHlc, hlcText, parseHlc } from './lattice.js';
import { writeStamps } from './pendingWrites.js';

// The most one frame's JSON text weighs: packages/api-contract/roadmap-socket.json, `maxFrameBytes`, a quarter of what
// the server takes in one message.
export const MAX_FRAME_BYTES = 256 * 1024;
// A frame is judged one this browser cannot send only past this size: no healthy path between a tab and the server
// refuses a smaller message, so a smaller frame lost with its socket is retried without limit.
export const UNSENDABLE_FROM_BYTES = 64 * 1024;

const SECTIONS = ['kinds', 'nodes', 'edges'];
const FRAME_ID = 'x'.repeat(36);
const encoder = new TextEncoder();

export const bytesOf = (value) => encoder.encode(JSON.stringify(value)).length;

const isStamp = (field, value) => field.endsWith('At') && typeof value === 'string';
const rowKey = (section, row) => (section === 'edges' ? JSON.stringify([row.from, row.to]) : row.id);
const emptyPart = () => ({ nodes: [], edges: [], kinds: [] });
const EMPTY_PART_BYTES = bytesOf(emptyPart());

// The bytes a frame of this tree and replica leaves for its writes: the limit less its envelope, counted with the
// longer intent and a full frame id so a write is cut alike whichever send carries it. A frame is its envelope and its
// writes as one object, a byte shorter than the two apart.
export function frameRoom(treeId, actor, maxBytes = MAX_FRAME_BYTES) {
  return maxBytes - bytesOf({ t: 'subgraph', v: 1, treeId, frameId: FRAME_ID, actor, intent: 'flush' }) + 1;
}

// The stamps writes carry, earliest first.
export function stampsOf(writes) {
  return [...new Set(Object.values(writeStamps(writes)))].sort((a, b) => compareHlc(parseHlc(a), parseHlc(b)));
}

const withStamp = (row, stamp) => Object.fromEntries(Object.entries(row).map(([field, value]) =>
  [field, isStamp(field, value) ? stamp : value]));

// One act's writes, all under the one stamp it was given, stamped for the frames that will carry them. Writes that fit
// one frame keep that stamp. Larger ones are cut into frame-sized parts, each under a stamp of its own: the first
// keeps the act's, and each next takes the clock's next tick of the same millisecond, so the parts are consecutive and
// go out in the order they were cut. A kind's own registers lead, in the first part: a peer that sees only that part
// knows the kind's new hue, so what it adds to the kind meanwhile lands in it, and the nodes still to follow are the
// ones this replica owes. Nodes come before the edges that join them.
export function stampedPerFrame(writes, clock, room) {
  if (bytesOf(writes) <= room) return writes;
  const first = stampsOf(writes)[0];
  if (!first) return writes;
  const ms = parseHlc(first).ms;
  const stamped = { ...writes, ...emptyPart() };
  let stamp = first;
  let size = EMPTY_PART_BYTES;
  let rows = 0;
  for (const section of SECTIONS) {
    let inSection = 0;
    for (const row of writes[section] ?? []) {
      let entry = withStamp(row, stamp);
      if (rows && size + bytesOf(entry) + (inSection ? 1 : 0) > room) {
        stamp = hlcText(clock.tick(ms));
        entry = withStamp(row, stamp);
        size = EMPTY_PART_BYTES;
        rows = 0;
        inSection = 0;
      }
      size += bytesOf(entry) + (inSection ? 1 : 0);
      stamped[section].push(entry);
      rows += 1;
      inSection += 1;
    }
  }
  return stamped;
}

// Writes as the registers of each stamp they carry: stamp → the part of every row that stamp wrote.
function partsByStamp(writes) {
  const parts = new Map();
  const partOf = (stamp) => {
    if (!parts.has(stamp)) parts.set(stamp, { ...emptyPart(), rows: new Map() });
    return parts.get(stamp);
  };
  for (const section of SECTIONS) {
    for (const row of writes[section] ?? []) {
      for (const [field, stamp] of Object.entries(row)) {
        if (!isStamp(field, stamp)) continue;
        const part = partOf(stamp);
        const key = `${section}:${rowKey(section, row)}`;
        if (!part.rows.has(key)) {
          const entry = section === 'edges' ? { from: row.from, to: row.to } : { id: row.id };
          part.rows.set(key, entry);
          part[section].push(entry);
        }
        const entry = part.rows.get(key);
        entry[field] = stamp;
        const register = field.slice(0, -2);
        if (register in row) entry[register] = row[register];
      }
    }
  }
  for (const name of TREE_REGISTERS) if (writes[name]?.at) partOf(writes[name].at)[name] = writes[name];
  return parts;
}

// What adding `part` to a frame holding `held` weighs: its entries, and a comma before each but the first of a section.
function addedBytes(held, part) {
  let bytes = 0;
  for (const section of SECTIONS) {
    if (!part[section].length) continue;
    for (const entry of part[section]) bytes += bytesOf(entry);
    bytes += part[section].length - 1 + (held[section].length ? 1 : 0);
  }
  return bytes;
}

// One stamp too large for a frame, cut across frames in section order: only a record an earlier bundle saved holds one.
function* cutAcross(part, room) {
  let frame = emptyPart();
  let size = EMPTY_PART_BYTES;
  let rows = 0;
  for (const section of SECTIONS) {
    for (const entry of part[section]) {
      const cost = bytesOf(entry) + (frame[section].length ? 1 : 0);
      if (rows && size + cost > room) {
        yield frame;
        frame = emptyPart();
        size = EMPTY_PART_BYTES;
        rows = 0;
      }
      size += bytesOf(entry) + (frame[section].length ? 1 : 0);
      frame[section].push(entry);
      rows += 1;
    }
  }
  if (rows) yield frame;
}

// Writes as the frames that carry them: whole stamps, earliest first, as many to a frame as fit `room`, a row two of
// them wrote being one entry of the frame. A stamp heavy enough to be judged unsendable goes alone, so a frame a path
// refuses for its size takes no small write with it; a stamp too large for any frame is cut across frames (cutAcross);
// and a tree register goes in a frame of its own, so a refused title or guide strands nothing else.
export function* framesOf(writes, room) {
  const parts = partsByStamp(writes);
  let frame = null;
  for (const stamp of stampsOf(writes)) {
    const { rows, ...part } = parts.get(stamp);
    const alone = EMPTY_PART_BYTES + addedBytes(emptyPart(), part);
    const added = frame ? addedBytes(frame.part, part) : 0;
    const apart = alone - EMPTY_PART_BYTES > UNSENDABLE_FROM_BYTES || TREE_REGISTERS.some((name) => part[name]);
    if (frame && (apart || frame.size + added > room)) {
      yield frame.part;
      frame = null;
    }
    if (alone > room && part.nodes.length + part.edges.length + part.kinds.length > 1) {
      yield* cutAcross(part, room);
      continue;
    }
    if (apart) {
      yield part;
      continue;
    }
    if (!frame) {
      frame = { part, rows, size: alone };
      continue;
    }
    for (const section of SECTIONS) {
      for (const entry of part[section]) {
        const key = `${section}:${rowKey(section, entry)}`;
        if (frame.rows.has(key)) Object.assign(frame.rows.get(key), entry);
        else {
          frame.rows.set(key, entry);
          frame.part[section].push(entry);
        }
      }
    }
    frame.size += added;
  }
  if (frame) yield frame.part;
}
