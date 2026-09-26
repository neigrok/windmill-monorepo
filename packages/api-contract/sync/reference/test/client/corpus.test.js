// The reference as a runner of the client corpus: every client vector, run from its input as a Swift or
// Kotlin runner would, equals its expectation exactly.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareRecords, isVisible } from '../../core/rows.js';
import { Replica } from '../../client/replica.js';
import { capCount, view } from '../../client/views.js';
import { registry } from '../../vectors/fixtures.js';
import { runSteps } from '../../vectors/steps.js';

const CORPUS = fileURLToPath(new URL('../../../corpus/', import.meta.url));
const STEP_FILES = ['commit', 'coalesce', 'hold', 'refusal', 'write', 'lineage']
  .flatMap((dir) => readdirSync(`${CORPUS}${dir}`).map((file) => `${dir}/${file}`))
  .concat(['pull/pages.json']);

function load(path) {
  return JSON.parse(readFileSync(`${CORPUS}${path}`, 'utf8'));
}

for (const path of STEP_FILES) {
  test(`client steps: ${path}`, () => {
    for (const { name, input, expect } of load(path)) {
      const out = runSteps(input);
      const actual = { returns: out.returns, device: out.device, ended: out.ended };
      if (out.telemetry.length) actual.telemetry = out.telemetry;
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), expect, name);
    }
  });
}

for (const path of ['view/drawn.json', 'view/stored.json']) {
  test(`views: ${path}`, () => {
    const withStored = path.endsWith('stored.json');
    for (const { name, input, expect } of load(path)) {
      const replica = new Replica(input.replica);
      const records = [...view(replica, registry, input.scope, { withHeld: !withStored }).values()].sort(compareRecords);
      const actual = { records, visible: records.filter((record) => isVisible(registry.type(record.t), record)).map((record) => [record.t, record.id]) };
      if (withStored) {
        actual.capCount = {};
        for (const type of registry.types.values()) {
          if (type.cap !== undefined && type.scope === registry.scopeKindOf(input.scope)) actual.capCount[type.type] = capCount(replica, registry, input.scope, type.type);
        }
      }
      assert.deepEqual(actual, expect, name);
    }
  });
}
