// hold/*.json (§7.3, §7.4): held gestures wait for their release, coalesce on release, and undo only
// while every entry of the gesture is still held, folding their dependents silently; numbering passes
// over held entries and holds back what depends on them.

import { freshMeta } from '../client/replica.js';
import { row, st } from './fixtures.js';
import { settle, stepsVector } from './steps.js';

const REPLICA = 'rp_00000000000000000000000000000001';

function device() {
  const confirmed = {
    'self/probe': [
      row({ t: 'card', id: 'card0001', life: ['alive', st(1000)], born: st(1000), f: { title: ['One', st(1000)] }, seq: 1 }),
      row({ t: 'card', id: 'card0002', life: ['alive', st(1100)], born: st(1100), f: { title: ['Two', st(1100)] }, seq: 2 }),
    ],
  };
  return settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), confirmed }] });
}

const holdDelete = (id, deviceNow, gestureId) => ({ op: 'commit', scope: 'self/probe', changes: [{ op: 'delete', t: 'card', id }], opts: { hold: true, gestureId }, deviceNow });
const rename = (id, title, deviceNow) => ({ op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'card', id, f: { title } }], deviceNow });
const probe = (changes, opts, deviceNow) => ({ op: 'commit', scope: 'self/probe', changes, ...(opts ? { opts } : {}), deviceNow });
const holdCreate = (id, deviceNow) => probe([{ op: 'create', t: 'card', id, f: { title: 'New' } }], { hold: true, gestureId: 'new' }, deviceNow);

function releases() {
  return [
    stepsVector('a held entry stays held before its releaseAt', {
      device: device(),
      steps: [holdDelete('card0001', 5000, 'del'), { op: 'releaseDue', deviceNow: 13999 }],
    }),
    stepsVector('a held entry is released at its releaseAt', {
      device: device(),
      steps: [holdDelete('card0001', 5000, 'del'), { op: 'releaseDue', deviceNow: 14000 }],
    }),
    stepsVector('releaseDue releases only the entries whose time has come', {
      device: device(),
      steps: [holdDelete('card0001', 5000, 'first'), holdDelete('card0002', 8000, 'second'), { op: 'releaseDue', deviceNow: 15000 }],
    }),
    stepsVector('release of one entry answers true; of an entry not held, false', {
      device: device(),
      steps: [holdDelete('card0001', 5000, 'del'), rename('card0002', 'Dos', 5001), { op: 'release', localId: 'del/0' }, { op: 'release', localId: 'g1/0' }],
    }),
    stepsVector('leaving the app releases every held entry', {
      device: device(),
      steps: [holdDelete('card0001', 5000, 'first'), holdDelete('card0002', 5001, 'second'), { op: 'releaseAll', deviceNow: 5002 }],
    }),
    stepsVector('push numbers ready entries and passes over held ones', {
      device: device(),
      steps: [holdDelete('card0001', 5000, 'del'), rename('card0002', 'Dos', 5001), { op: 'push', deviceNow: 5002 }],
    }),
    stepsVector('a released delete joins the ready update before it', {
      device: device(),
      steps: [rename('card0001', 'Uno', 5000), holdDelete('card0001', 5001, 'del'), { op: 'releaseAll', deviceNow: 5002 }],
    }),
    stepsVector('an update of a held create is held back unnumbered, a later independent edit is numbered past both, and the release numbers the two in commit order', {
      device: device(),
      steps: [
        holdCreate('card0009', 5000),
        rename('card0009', 'Renamed', 5001),
        rename('card0001', 'Uno', 5002),
        { op: 'push', deviceNow: 5003 },
        { op: 'releaseAll', deviceNow: 5004 },
        { op: 'push', deviceNow: 5005 },
      ],
    }),
    stepsVector('an edit of a record a held-back entry touches is held back too, and a held-back command stops numbering', {
      device: device(),
      steps: [
        holdCreate('card0009', 5000),
        probe([{ op: 'update', t: 'card', id: 'card0009', f: { title: 'Both' } }, { op: 'update', t: 'card', id: 'card0001', f: { title: 'Both' } }], { atomic: true }, 5001),
        probe([{ op: 'update', t: 'card', id: 'card0001', f: { tier: 'done' } }], { guard: [{ t: 'card', id: 'card0001', field: 'title' }] }, 5002),
        rename('card0002', 'Dos', 5003),
        probe([{ op: 'create', t: 'board', id: 'b_00000009' }], { hold: true, gestureId: 'board' }, 5004),
        probe([], { cmd: { name: 'probe.copy', args: { src: 'b_00000009', dst: 'b_0000000a' } }, predict: [{ op: 'create', t: 'board', id: 'b_0000000a' }] }, 5005),
        rename('card0002', 'Zwei', 5006),
        { op: 'push', deviceNow: 5007 },
      ],
    }),
  ];
}

function undos() {
  return [
    stepsVector('undo while the gesture is held removes it', {
      device: device(),
      steps: [holdDelete('card0001', 5000, 'del'), { op: 'undo', gestureId: 'del' }],
    }),
    stepsVector('undo after the release changes nothing', {
      device: device(),
      steps: [holdDelete('card0001', 5000, 'del'), { op: 'releaseDue', deviceNow: 14000 }, { op: 'undo', gestureId: 'del' }],
    }),
    stepsVector('undo of a gesture with no entries answers false', {
      device: device(),
      steps: [holdDelete('card0001', 5000, 'del'), { op: 'undo', gestureId: 'other' }],
    }),
    stepsVector('undo of a gesture that was never held answers false', {
      device: device(),
      steps: [{ op: 'commit', scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Uno' } }], opts: { gestureId: 'edit' }, deviceNow: 5000 }, { op: 'undo', gestureId: 'edit' }],
    }),
    stepsVector('undo of a held create folds its dependents silently: an update of the record ends, and an atomic entry keeps its independent part', {
      device: device(),
      steps: [
        holdCreate('card0009', 5000),
        rename('card0009', 'Renamed', 5001),
        probe([{ op: 'update', t: 'card', id: 'card0009', f: { tier: 'done' } }, { op: 'update', t: 'card', id: 'card0001', f: { title: 'Kept' } }], { atomic: true }, 5002),
        { op: 'undo', gestureId: 'new' },
        { op: 'push', deviceNow: 5003 },
      ],
    }),
    stepsVector('a keyed put that carries the life a held put wrote is held back, and the undo folds it silently', {
      device: device(),
      steps: [
        probe([{ op: 'put', t: 'day', id: '2026-09-01' }], { hold: true, gestureId: 'day' }, 5000),
        probe([{ op: 'put', t: 'day', id: '2026-09-01', f: { score: 5 } }], undefined, 5001),
        rename('card0001', 'Uno', 5002),
        { op: 'push', deviceNow: 5003 },
        { op: 'undo', gestureId: 'day' },
      ],
    }),
  ];
}

export function files() {
  return { 'hold/release.json': releases(), 'hold/undo.json': undos() };
}
