// hold/*.json (§7.3): held gestures wait for their release, coalesce on release, and undo only while
// every entry of the gesture is still held.

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
  ];
}

export function files() {
  return { 'hold/release.json': releases(), 'hold/undo.json': undos() };
}
