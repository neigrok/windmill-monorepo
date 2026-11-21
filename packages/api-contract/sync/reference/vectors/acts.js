import { freshMeta } from '../client/replica.js';
import { stepsVector } from './steps.js';

export function actVectors() {
  const replica = 'rp_00000000000000000000000000000001';
  const device = { active: replica, replicas: [{ meta: freshMeta(replica, 'bound', 'A') }] };
  const tree = 'tree/b_00000001';
  const overlay = 'self/overlay/b_00000001';
  const board = { scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: 'b_00000001' }] };
  const meta = { scope: tree, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'First' } }] };
  const mark = { scope: overlay, changes: [{ op: 'write', t: 'mark', id: 'c_00000001', f: { done: true } }] };
  const act = (segments, extra = {}) => ({ op: 'commitAct', segments, deviceNow: 5000, ...extra });
  return [
    stepsVector('an act creates a governing record before its tree and overlay', {
      device, steps: [act([board, meta, mark]), { op: 'view', withHeld: true, scope: tree }, { op: 'view', withHeld: true, scope: overlay }],
    }),
    stepsVector('repeated scopes project a create into a later update', {
      device, steps: [act([
        { scope: 'self/probe', changes: [{ op: 'create', t: 'card', id: 'card0001', f: { title: 'First' } }] },
        { scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Next' } }] },
      ]), { op: 'view', withHeld: true, scope: 'self/probe' }],
    }),
    stepsVector('a later malformed segment rolls back earlier entries and local rows', {
      device, steps: [act([
        { ...board, opts: { local: { rack: 'temporary' } } },
        { scope: tree, changes: [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'Wrong scope' } }] },
      ]), act([board, meta])],
    }),
    stepsVector('a later cap refusal rolls back every earlier segment', {
      device, steps: [act([board, ...[1, 2, 3, 4].map((n) => ({ scope: 'self/probe', changes: [
        { op: 'create', t: 'card', id: `card000${n}`, f: { title: `Card ${n}` } },
      ] }))]), act([board, meta])],
    }),
    stepsVector('one held segment holds the whole act and one Undo removes it', {
      device, steps: [act([board, { ...meta, opts: { hold: true } }, mark]), { op: 'undo', gestureId: 'g1' }],
    }),
    stepsVector('explicit predictions project into later segment validation', {
      device, steps: [act([
        { scope: 'self/probe', changes: [], opts: { cmd: { name: 'probe.start', args: { id: 'run00001', startedAt: 5000, join: false } },
          predict: [{ op: 'create', t: 'run', id: 'run00001', f: { startedAt: 5000, label: 'First' } }] } },
        { scope: 'self/probe', changes: [{ op: 'update', t: 'run', id: 'run00001', f: { label: 'Next' } }] },
      ]), { op: 'view', scope: 'self/probe', withHeld: true }],
    }),
    stepsVector('a later oversized intent leaves no notice or earlier local row', {
      device, limits: { PUSH_MAX_BYTES: 1000 }, steps: [act([
        { ...board, opts: { local: { rack: 'temporary' } } },
        { scope: tree, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'x'.repeat(1200) } }] },
      ]), act([board, meta])],
    }),
    stepsVector('no-op segments have no stamp and consume no local ordinal', {
      device, steps: [act([board, { scope: 'self/probe', changes: [] }, meta])],
    }),
    stepsVector('empty and unchanged acts leave the clock and identity sequence alone', {
      device, steps: [act(null), act([]), act([board, meta])],
    }),
  ];
}

export function files() { return { 'commit/acts.json': actVectors() }; }
