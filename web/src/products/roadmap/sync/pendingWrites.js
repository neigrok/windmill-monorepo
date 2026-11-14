import { TREE_REGISTERS, compareHlc, parseHlc } from './lattice.js';
import { progressStamp } from './progressLattice.js';
import { GENESIS_STAMP } from '../model/Legend.js';

const SECTIONS = ['nodes', 'edges', 'kinds', 'marks'];

const rowId = (section, row) => (section === 'edges' ? [row.from, row.to] : row.id ?? row.node);
const stampKey = (section, id, field) => JSON.stringify([section, id, field]);
const registerKey = (name) => stampKey(name, '', 'at');
const isStamp = (field, value) => (field.endsWith('At') || field === 'at') && typeof value === 'string';

export function writeStamps(frame = {}) {
  const stamps = {};
  for (const section of SECTIONS) {
    for (const row of frame?.[section] ?? []) {
      const id = rowId(section, row);
      for (const [field, stamp] of Object.entries(row)) {
        if (isStamp(field, stamp)) stamps[stampKey(section, id, field)] = stamp;
      }
    }
  }
  for (const name of TREE_REGISTERS) if (frame?.[name]?.at) stamps[registerKey(name)] = frame[name].at;
  return stamps;
}

// The part of a row whose registers `keeps` answers for; a mark is one register, so it stands or goes whole.
function rowWrites(section, row, keeps) {
  const id = rowId(section, row);
  if (section === 'marks') return keeps(stampKey(section, id, 'at'), row.at) ? row : null;
  const part = section === 'edges' ? { from: row.from, to: row.to } : { id: row.id };
  let kept = false;
  for (const [field, stamp] of Object.entries(row)) {
    if (!isStamp(field, stamp) || !keeps(stampKey(section, id, field), stamp)) continue;
    part[field] = stamp;
    const register = field.slice(0, -2);
    if (register in row) part[register] = row[register];
    kept = true;
  }
  return kept ? part : null;
}

// The part of a frame whose registers `keeps` answers for: what one writer wrote, or what a discard leaves.
export function frameWrites(frame = {}, keeps) {
  const part = {};
  for (const section of SECTIONS) {
    if (!frame?.[section]) continue;
    part[section] = frame[section].map((row) => rowWrites(section, row, keeps)).filter(Boolean);
  }
  for (const name of TREE_REGISTERS) if (frame?.[name]?.at && keeps(registerKey(name), frame[name].at)) part[name] = frame[name];
  return part;
}

export function unconfirmedStamps(stamps, confirmed) {
  return Object.fromEntries(Object.entries(stamps).filter(([key, stamp]) =>
    !confirmed[key] || compareHlc(parseHlc(stamp), parseHlc(confirmed[key])) > 0));
}

export function outboxStamps(stamps, confirmed, carried = []) {
  const pending = unconfirmedStamps(stamps, confirmed);
  for (const references of carried) {
    for (const [key, stamp] of Object.entries(references)) {
      if (pending[key] === stamp) delete pending[key];
    }
  }
  return pending;
}

export function outboxWrites(frame, confirmedFrame, carriedFrames = []) {
  const pending = outboxStamps(writeStamps(frame), writeStamps(confirmedFrame), Array.from(carriedFrames, writeStamps));
  return frameWrites(frame, (key, stamp) => pending[key] === stamp);
}

export function pendingRecordCount(stamps) {
  return new Set(Object.keys(stamps).map((key) => JSON.stringify(JSON.parse(key).slice(0, 2)))).size;
}

// The references among a lane's `gestures` to registers its `frame` holds. One to a register the lattice does not keep,
// as a stored record may name, or to a mark whose stamp no mark can carry, is no unsent write; a gesture left with no
// reference is gone.
export function retainedGestures(lane, frame, gestures = {}) {
  const current = writeStamps(frame);
  const holds = ([key, at]) => current[key] && (lane !== 'progress' || progressStamp(at));
  const retained = {};
  for (const [stamp, references] of Object.entries(gestures)) {
    const valid = Object.fromEntries(Object.entries(references).filter(holds));
    if (Object.keys(valid).length) retained[stamp] = valid;
  }
  return retained;
}

export function pendingGestures(frame, confirmedFrame, gestures = {}) {
  const confirmed = writeStamps(confirmedFrame);
  const pending = {};
  for (const [stamp, references] of Object.entries(gestures)) {
    const remaining = unconfirmedStamps(references, confirmed);
    if (Object.keys(remaining).length) pending[stamp] = remaining;
  }
  // A register an act already references is that act's: one act cut into several stamps stays one, and only a write
  // no act references is taken for an act of its own, under its stamp.
  const referenced = new Set(Object.values(pending).flatMap((references) =>
    Object.entries(references).map(([key, stamp]) => `${key}\n${stamp}`)));
  for (const [key, stamp] of Object.entries(unconfirmedStamps(writeStamps(frame), confirmed))) {
    if (stamp === GENESIS_STAMP || referenced.has(`${key}\n${stamp}`)) continue;
    pending[stamp] ??= {};
    pending[stamp][key] = stamp;
  }
  return pending;
}
