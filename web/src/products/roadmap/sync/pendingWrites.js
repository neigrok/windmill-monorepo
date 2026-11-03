import { compareHlc, parseHlc } from './lattice.js';
import { GENESIS_STAMP } from '../model/Legend.js';

export function writeStamps(frame = {}) {
  const stamps = {};
  for (const section of ['nodes', 'edges', 'kinds', 'marks']) {
    for (const row of frame?.[section] ?? []) {
      const id = section === 'edges' ? [row.from, row.to] : row.id ?? row.node;
      for (const [field, stamp] of Object.entries(row)) {
        if ((field.endsWith('At') || field === 'at') && typeof stamp === 'string') {
          stamps[JSON.stringify([section, id, field])] = stamp;
        }
      }
    }
  }
  if (frame?.title?.at) stamps[JSON.stringify(['title', '', 'at'])] = frame.title.at;
  return stamps;
}

export function unconfirmedStamps(stamps, confirmed) {
  return Object.fromEntries(Object.entries(stamps).filter(([key, stamp]) =>
    !confirmed[key] || compareHlc(parseHlc(stamp), parseHlc(confirmed[key])) > 0));
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
