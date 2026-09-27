// write/map.json (§7.7 write map): a command's ok result carries the server's map; the client rewrites a
// joined id in its queued entries, restamps the command's prediction to the map, observes the map, and
// gives later queued writes of the named registers fresh stamps. Responses come from the reference server.

import { freshMeta } from '../client/replica.js';
import { bodyBytes } from '../core/wire.js';
import { push } from '../server/push.js';
import { ServerState } from '../server/state.js';
import { product, productScope, registry, row, serverState, st } from './fixtures.js';
import { runSteps, settle, stepsVector } from './steps.js';

const REPLICA = 'rp_00000000000000000000000000000001';

// Client steps interleaved with the reference server: `respond` answers the last push step's request.
class ServerScript {
  constructor({ device, server }) {
    this.input = { device, ids: [], steps: [] };
    this.server = new ServerState(server);
  }

  add(...steps) {
    this.input.steps.push(...steps);
    return this;
  }

  push(deviceNow) {
    return this.add({ op: 'push', deviceNow });
  }

  respond({ serverNow, tRecv = serverNow }) {
    const out = runSteps(this.input);
    const index = this.input.steps.map((step) => step.op).lastIndexOf('push');
    const pushed = push({ state: this.server, registry, product, account: 'A', request: out.returns[index], serverNow });
    this.server = pushed.state;
    return this.add({ op: 'pushResponse', response: pushed.response, deviceNow: tRecv, tSend: this.input.steps[index].deviceNow, tRecv });
  }

  limit(limits) {
    this.input.limits = limits;
    return this;
  }

  vector(name) {
    return stepsVector(name, this.input);
  }
}

const OPEN_RUN = row({ t: 'run', id: 'run00001', life: ['alive', st(1300, 0, 'srv')], born: st(1300, 0, 'srv'), f: { label: ['Early', st(1300, 0, 'srv')], startedAt: [1300, st(1300, 0, 'srv')] }, seq: 1 });

function server(rows, productState) {
  return serverState({ scopes: { 'acct:A/probe': productScope('A') }, rows: { 'acct:A/probe': rows }, productState });
}

function device(confirmed) {
  return settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), confirmed: { 'self/probe': confirmed } }] });
}

const commitStep = (changes, opts, deviceNow) => ({ op: 'commit', scope: 'self/probe', changes, ...(opts ? { opts } : {}), deviceNow });

const start = (id, label) => ({
  cmd: { name: 'probe.start', args: { id, ...(label ? { label } : {}), startedAt: 5000, join: true } },
  predict: [{ op: 'create', t: 'run', id, f: { ...(label ? { label } : {}), startedAt: 5000 } }],
});

const end = (runId, endedAt) => ({
  cmd: { name: 'probe.end', args: { runId, endedAt } },
  predict: [{ op: 'update', t: 'run', id: runId, f: { endedAt } }],
});

// A lap under a start that joins an open run whose id is 56 characters longer than the called one: the
// map lengthens the lap's runId past a request alone, with PUSH_MAX_BYTES at the lap's widest
// one-intent body as committed.
function outgrown() {
  const longRun = row({ t: 'run', id: `run${'0'.repeat(60)}1`, life: ['alive', st(1300, 0, 'srv')], born: st(1300, 0, 'srv'), f: { startedAt: [1300, st(1300, 0, 'srv')] }, seq: 1 });
  const lap = commitStep([{ op: 'create', t: 'lap', id: 'lap00001', f: { runId: 'run00009', weight: 40 } }], undefined, 5001);
  const committed = runSteps({ device: device([longRun]), steps: [commitStep([], start('run00009'), 5000), lap] });
  const entry = committed.device.replicas[0].outbox.find((candidate) => candidate.localId === 'g2/0');
  const widest = Number.MAX_SAFE_INTEGER;
  const limit = bodyBytes({ replica: REPLICA, ackThrough: widest, intents: [{ ...entry.intent, n: widest }] });
  return new ServerScript({ device: device([longRun]), server: server([longRun]) })
    .limit({ PUSH_MAX_BYTES: limit })
    .add(commitStep([], start('run00009'), 5000))
    .push(5000)
    .add(lap)
    .respond({ serverNow: 5010, tRecv: 5011 })
    .push(5012);
}

export function files() {
  const created = new ServerScript({ device: device([]), server: server([]) })
    .add(commitStep([], start('run00009', 'Go'), 5000))
    .push(5000)
    .add(commitStep([{ op: 'create', t: 'lap', id: 'lap00001', f: { runId: 'run00009', weight: 40 } }], undefined, 5001))
    .add(commitStep([{ op: 'update', t: 'run', id: 'run00009', f: { label: 'Late' } }], undefined, 5002))
    .add(commitStep([{ op: 'delete', t: 'run', id: 'run00009' }], { hold: true }, 5003))
    .respond({ serverNow: 5010, tRecv: 5011 });

  const joined = new ServerScript({ device: device([OPEN_RUN]), server: server([OPEN_RUN]) })
    .add(commitStep([], start('run00009'), 5000))
    .push(5000)
    .add(commitStep([{ op: 'create', t: 'lap', id: 'lap00001', f: { runId: 'run00009', weight: 40 } }], undefined, 5001))
    .add(commitStep([{ op: 'update', t: 'run', id: 'run00009', f: { label: 'Mine' } }], { guard: [{ t: 'run', id: 'run00009', field: 'label' }] }, 5002))
    .add(commitStep([], end('run00009', 5003), 5003))
    .add(commitStep([{ op: 'delete', t: 'run', id: 'run00009' }], { hold: true }, 5004))
    .respond({ serverNow: 5010, tRecv: 5011 });

  const replayed = new ServerScript({
    device: device([]),
    server: server([row({ t: 'run', id: 'run00009', life: ['alive', st(4000, 0, 'srv')], born: st(4000, 0, 'srv'), f: { startedAt: [4000, st(4000, 0, 'srv')] }, seq: 1 })], { receipts: { 'acct:A/probe': { run00009: 'run00009' } } }),
  })
    .add(commitStep([], start('run00009'), 5000))
    .push(5000)
    .respond({ serverNow: 5010, tRecv: 5011 });

  const ended = new ServerScript({ device: device([OPEN_RUN]), server: server([OPEN_RUN]) })
    .add(commitStep([], end('run00001', 4000), 5000))
    .push(5000)
    .add(commitStep([{ op: 'update', t: 'run', id: 'run00001', f: { label: 'Renamed' } }], undefined, 5001))
    .respond({ serverNow: 5010, tRecv: 5011 });

  const guarded = new ServerScript({ device: device([]), server: server([]) })
    .add(commitStep([], start('run00009', 'Go'), 5000))
    .push(5000)
    .add(commitStep([{ op: 'update', t: 'run', id: 'run00009', f: { label: 'Later' } }], { guard: [{ t: 'run', id: 'run00009', field: 'label' }] }, 5001))
    .respond({ serverNow: 5010, tRecv: 5011 });

  return {
    'write/map.json': [
      created.vector('a create map restamps the prediction to the server born and stamps, and later writes of its registers tick after them'),
      joined.vector('a join map rewrites the called id in queued deltas, refs, guards, command args and predictions, and refuses a queued delete of it'),
      replayed.vector('a replayed start maps to its run without from; only the life and born move'),
      ended.vector('an end map restamps the predicted endedAt and leaves other registers alone'),
      guarded.vector('a later guard naming the predicted stamp follows the map to the server stamp, and its write ticks after it'),
      outgrown().vector('an entry a join map lengthens past a request alone is refused too-large at numbering, with its notice, and never sent'),
    ],
  };
}
