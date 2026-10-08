import { claim } from './corpus-support.js';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { steadyTiming } from '../../../../packages/api-contract/sync/reference/core/clock.js';
import { CONSTANTS } from '../../../../packages/api-contract/sync/reference/core/constants.js';
import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { intentDigest } from '../../../../packages/api-contract/sync/reference/core/wire.js';
import { commit } from '../../../../packages/api-contract/sync/reference/client/commit.js';
import { release, releaseAll } from '../../../../packages/api-contract/sync/reference/client/hold.js';
import { signIn, signOut } from '../../../../packages/api-contract/sync/reference/client/lifecycle.js';
import { onFrame, onPullResponse, pullRequest } from '../../../../packages/api-contract/sync/reference/client/puller.js';
import { Device } from '../../../../packages/api-contract/sync/reference/client/replica.js';
import { nextPush, onHello, onPushResponse } from '../../../../packages/api-contract/sync/reference/client/sender.js';
import { reconcile } from '../../../../packages/api-contract/sync/reference/client/subscriptions.js';
import { deathFrameFor, frameFor, hello, pull } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { ACTOR, product, productScope, registry, serverState } from './oracle-adapters/fixtures.js';

const PROTOCOL = new URL('../../../../packages/api-contract/sync/corpus/protocol/', import.meta.url);
const transcripts = readdirSync(PROTOCOL).filter((name) => name.endsWith('.jsonl')).sort();
const linesOf = (file) => readFileSync(new URL(file, PROTOCOL), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

for (const file of transcripts) {
  claim(`protocol/${file}`, linesOf(file).length - 1);
  test(`protocol/${file} replays in the client role`, () => {
    const [header, ...lines] = linesOf(file);
    const devices = Object.fromEntries(Object.entries(header.devices).map(([name, json]) => [name, new Device(json)]));
    const ids = structuredClone(header.ids);
    const ended = Object.fromEntries(Object.keys(devices).map((name) => [name, []]));
    let gestures = 0;
    const actors = Object.fromEntries(Object.keys(devices).map((name) => [name, [...(header.actors[name] ?? [ACTOR])]]));
    const current = Object.fromEntries(Object.entries(actors).map(([name, list]) => [name, list.shift()]));
    const unused = () => {
      throw new Error('the transcript lists none');
    };
    const ctx = (name, deviceNow) => ({
      registry,
      actor: current[name],
      deviceNow,
      ended: ended[name],
      telemetry: [],
      appVersion: '1',
      device: devices[name],
      nextGestureId: () => `g${(gestures += 1)}`,
      newReplicaId: () => ids[name].shift(),
      newActor: () => actors[name].shift(),
      newForkGuard: unused,
      draw: unused,
      limits: CONSTANTS,
    });
    for (const line of lines) {
      if (line.end) {
        assert.equal(jcs(Object.fromEntries(Object.entries(devices).map(([name, device]) => [name, device.toJSON()]))), jcs(line.devices));
        assert.equal(jcs(ended), jcs(line.ended));
        continue;
      }
      if (line.server === 'load') continue;
      const device = devices[line.device];
      const replica = device.activeReplica;
      const context = ctx(line.device, line.deviceNow);
      const timing = steadyTiming(line.deviceNow, line.deviceNow);
      if (line.http === 'hello') {
        onHello(replica, context, line.response, timing);
      } else if (line.do) {
        const { args } = line;
        let out = null;
        if (line.do === 'commit') out = commit(replica, context, args.scope, args.changes ?? [], args.opts ?? {});
        else if (line.do === 'release') out = release(replica, registry, context.ended, replica.entry(args.localId));
        else if (line.do === 'releaseAll') releaseAll(replica, registry, context.ended);
        else if (line.do === 'signIn') out = signIn(device, context, args);
        else if (line.do === 'signOut') out = signOut(device, context, args);
        else if (line.do === 'reconcile') reconcile(replica, context, args.scopes);
        else if (line.do === 'load') devices[line.device] = new Device(args.device);
        assert.equal(jcs(out), jcs(line.returns), `step ${line.step}`);
      } else if (line.http === 'push') {
        const request = nextPush(replica, context);
        assert.equal(jcs(request), jcs(line.request), `step ${line.step}`);
        if (!line.lost) onPushResponse(replica, context, request, line.response, timing);
      } else if (line.http === 'pull') {
        const request = pullRequest(replica, registry, line.request.scopes.map((entry) => entry.scope));
        assert.equal(jcs(request), jcs(line.request), `step ${line.step}`);
        assert.equal(jcs(onPullResponse(replica, context, request, line.response, timing)), jcs(line.returns), `step ${line.step}`);
      } else if (line.frame) {
        assert.equal(onFrame(replica, context, line.frame), line.returns, `step ${line.step}`);
      }
      current[line.device] = context.actor;
    }
  });
}
