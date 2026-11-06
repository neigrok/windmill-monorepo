import { compareHlc, parseHlc } from './lattice.js';
import { GENESIS_STAMP } from '../model/Legend.js';

const SECTIONS = ['nodes', 'edges', 'kinds', 'marks'];
const TITLE_KEY = JSON.stringify(['title', '', 'at']);

const rowId = (section, row) => (section === 'edges' ? [row.from, row.to] : row.id ?? row.node);
const stampKey = (section, id, field) => JSON.stringify([section, id, field]);
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
  if (frame?.title?.at) stamps[TITLE_KEY] = frame.title.at;
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
  if (frame?.title?.at && keeps(TITLE_KEY, frame.title.at)) part.title = frame.title;
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

export function pendingGestures(frame, confirmedFrame, gestures = {}) {
  const confirmed = writeStamps(confirmedFrame);
  const pending = {};
  for (const [stamp, references] of Object.entries(gestures)) {
    const remaining = unconfirmedStamps(references, confirmed);
    if (Object.keys(remaining).length) pending[stamp] = remaining;
  }
  for (const [key, stamp] of Object.entries(unconfirmedStamps(writeStamps(frame), confirmed))) {
    if (stamp === GENESIS_STAMP) continue;
    pending[stamp] ??= {};
    pending[stamp][key] = stamp;
  }
  return pending;
}
