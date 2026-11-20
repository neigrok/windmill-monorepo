// @ts-check

import assert from 'node:assert/strict';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { hello, pull } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { steadyTiming } from '../../../../packages/api-contract/sync/reference/core/clock.js';
import { releaseAll, releaseDue, undoOffers } from '../../../../packages/api-contract/sync/reference/client/hold.js';
import { engineStart } from '../../../../packages/api-contract/sync/reference/client/lifecycle.js';
import { onPullResponse, pullRequest } from '../../../../packages/api-contract/sync/reference/client/puller.js';
import { nextPush, onPushResponse } from '../../../../packages/api-contract/sync/reference/client/sender.js';
import { ActionRunner, EngineReplica } from '../../../src/platform/domain-kit/runner.js';
import { DomainNotice } from '../../../src/platform/domain-kit/refusals.js';
import { FixedZone } from '../../../src/platform/domain-kit/time.js';
import { environment } from '../sync/fakes.js';
import { DEFAULT_NOW } from './vectors.js';

/** @typedef {{ registry: import('../../../../packages/api-contract/sync/reference/core/registry.js').Registry, product: any, scope: string, scopes: Set<string>, now: number, serial: number, random: (bound: number) => number, server: any, phones: Harness[], zone: import('../../../src/platform/domain-kit/time.js').Zone }} World */

export class Harness {
  /** @param {World} world @param {any} env @param {any} engine @param {any} options */
  constructor(world, env, engine, options) {
    this.world = world;
    this.env = env;
    this.engine = engine;
    this.options = options;
    this.runner = new ActionRunner(new EngineReplica(engine), world.registry, world.zone);
    world.phones.push(this);
  }

  /** @param {{ registry: import('../../../../packages/api-contract/sync/reference/core/registry.js').Registry, product: any, scope: string, start?: number, zone?: import('../../../src/platform/domain-kit/time.js').Zone }} options */
  static async open({ registry, product, scope, start = DEFAULT_NOW, zone = new FixedZone(0) }) {
    let seed = 1;
    // §14.2's seeded ids: a fixed linear congruential sequence, so a second mint of a type draws another id.
    const random = (/** @type {number} */ bound) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % bound;
    };
    const world = { registry, product, scope, scopes: new Set([scope]), now: start, serial: 0, random, server: ServerState.empty({ epoch: 'ep-domain', accounts: { A: { name: 'A' } } }), phones: [], zone };
    return Harness.phone(world);
  }

  /** @param {World} world */
  static async phone(world) {
    const env = environment();
    env.timers.time = world.now;
    env.transport.request = async () => ({ response: hello(/** @type {any} */ ({ state: world.server, registry: world.registry, account: 'A', serverTime: world.now })), timing: steadyTiming(world.now, world.now) });
    const options = { ...env.options, registry: world.registry, now: () => world.now, monotonic: () => world.now, draw: (/** @type {number} */ bound) => world.random(bound),
      newActor: () => `r_${String(++world.serial).padStart(12, '0')}`, newReplicaId: () => `rp_${String(++world.serial).padStart(32, '0')}` };
    const engine = await BrowserSyncEngine.open(options);
    const phone = new Harness(world, env, engine, options);
    assert.equal((await engine.signIn('A')).complete, true);
    for (const scope of world.scopes) engine.observe(scope);
    return phone;
  }

  async device() { return Harness.phone(this.world); }
  get server() { return this.world.server; }

  // Every phone observes, pulls and releases each scope a test names, so an act's intents in other scopes settle.
  /** @param {string} scope */
  observe(scope) {
    this.world.scopes.add(scope);
    for (const phone of this.world.phones) phone.engine.observe(scope);
  }

  get scopes() { return [...this.world.scopes]; }

  async restart() {
    this.engine.close();
    this.engine = await BrowserSyncEngine.open(this.options);
    await this.engine.write(null, (/** @type {any} */ device, /** @type {any} */ context) => engineStart(device, context));
    this.runner = new ActionRunner(new EngineReplica(this.engine), this.world.registry, this.world.zone);
    for (const scope of this.world.scopes) this.engine.observe(scope);
  }

  async senderStep() {
    const { world, engine } = this;
    const request = await engine.write(null, (/** @type {any} */ device, /** @type {any} */ context) => nextPush(device.activeReplica, context));
    if (request === null) return false;
    const out = push(/** @type {any} */ ({ state: world.server, registry: world.registry, product: world.product, account: 'A', request, serverNow: world.now }));
    world.server = out.state;
    assert.equal(out.response.status, 200);
    await engine.write(null, (/** @type {any} */ device, /** @type {any} */ context) => onPushResponse(device.activeReplica, context, request, out.response, steadyTiming(world.now, world.now)), this.scopes);
    return true;
  }

  async pullerStep() {
    const { world, engine } = this;
    const request = pullRequest(engine.device.activeReplica, world.registry, this.scopes);
    const out = pull(/** @type {any} */ ({ state: world.server, registry: world.registry, product: world.product, account: 'A', request, serverNow: world.now }));
    world.server = out.state;
    assert.equal(out.response.status, 200);
    await engine.write(null, (/** @type {any} */ device, /** @type {any} */ context) => onPullResponse(device.activeReplica, context, request, out.response, steadyTiming(world.now, world.now)), this.scopes);
    return /** @type {any} */ (out.response.body).pages.some((/** @type {any} */ page) => page.more);
  }

  async sync() {
    for (let round = 0; round < 100; round += 1) {
      let sent = false;
      for (const phone of this.world.phones) sent = await phone.senderStep() || sent;
      for (const phone of this.world.phones) {
        let pages = 0;
        while (await phone.pullerStep()) assert.ok(++pages < 100, 'pull never reached its head');
      }
      if (!sent) {
        for (const phone of this.world.phones) assert.ok(phone.engine.device.activeReplica.entries().every((/** @type {any} */ entry) => entry.state === 'held'), 'sync left an unsettled intent');
        return;
      }
    }
    assert.fail('sync never became quiescent');
  }

  /** @param {number} ms */
  async advance(ms) {
    this.world.now += ms;
    for (const phone of this.world.phones) {
      phone.env.timers.time = this.world.now;
      await phone.engine.write(null, (/** @type {any} */ device, /** @type {any} */ context) => releaseDue(device.activeReplica, this.world.registry, context.ended, this.world.now), this.scopes);
    }
  }

  async leave() {
    await this.engine.write(null, (/** @type {any} */ device, /** @type {any} */ context) => releaseAll(device.activeReplica, this.world.registry, context.ended), this.scopes);
  }

  failNextCommit() {
    const transact = this.engine.store.transact.bind(this.engine.store);
    this.engine.store.transact = (/** @type {any[]} */ ...args) => {
      this.engine.store.transact = transact;
      return Promise.reject(new DOMException('the disk is full', 'QuotaExceededError'));
    };
  }

  /** @template E @param {import('../../../src/platform/domain-kit/entities.js').EntityType<E>} type @param {string} [scope] */
  drawn(type, scope = type.boundScope()) { return this.runner.read(type.boundScope(scope), (read) => read.repository(type).all('drawn')); }
  /** @template E @param {import('../../../src/platform/domain-kit/entities.js').EntityType<E>} type @param {string} [scope] */
  stored(type, scope = type.boundScope()) { return this.runner.read(type.boundScope(scope), (read) => read.repository(type).all('stored')); }
  /** @template R @param {import('../../../src/platform/domain-kit/refusals.js').Refusals<R>} refusals @param {string} [scope] */
  notices(refusals, scope = this.world.scope) {
    const hold = this.engine.observe(scope);
    try { return hold.getSnapshot().notices.map((/** @type {any} */ notice) => new DomainNotice(notice, this.world.registry, refusals)); }
    finally { hold.release(); }
  }
  undoOffers() { return undoOffers(this.engine.device.activeReplica, this.world.scope); }
  close() { for (const phone of this.world.phones) phone.engine.close(); }
}
