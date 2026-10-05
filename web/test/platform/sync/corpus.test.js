import './core/corpus.js';
import './client/corpus.js';
import './protocol.js';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { corpus, load, claim, claims } from './corpus-support.js';
import { CONSTANTS } from '../../../src/platform/sync/core/constants.js';
import { jcs } from '../../../src/platform/sync/core/jcs.js';
import { nextDocumentStamp } from '../../../src/platform/sync/core/content.js';
import { runSteps } from './oracle-adapters/steps.js';
import { journalRegistry, journalProduct } from './oracle-adapters/journal.js';
import { runClaimEdit } from './oracle-adapters/journal-claim.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';

claim('constants.json', 1);
test('browser corpus constants.json', () => assert.equal(jcs(CONSTANTS), jcs(load('constants.json'))));
for (const [path, run] of [
  ['journal/content-clock.json', (input) => ({ stamp: nextDocumentStamp(input) })],
  ['journal/claim-edit.json', runClaimEdit],
  ['journal/client.json', (input) => {
    const out = runSteps(input, journalRegistry);
    const last = out.returns.at(-1);
    if (last?.intents) {
      const served = push({ state: new ServerState(input.server), registry: journalRegistry,
        product: journalProduct, account: 'A', request: last, serverNow: input.serverNow });
      out.server = served.state.toJSON();
      out.response = served.response;
    }
    return out;
  }],
]) {
  claim(path);
  test(`browser corpus ${path}`, () => {
    for (const { name, input, expect } of load(path)) assert.equal(jcs(run(input)), jcs(expect), name);
  });
}

const server = new Set(['identity/table.json', 'envelope/credentials.json', 'push/serve.json',
  'pull/serve.json', 'pull/hello.json', 'live/death.json', 'machine/scope.json',
  'gym/admit.json', 'gym/backfill.json', 'gym/metadata.json', 'journal/admit.json', 'journal/backfill.json', 'journal/revisions.json']);
function inventory(directory = corpus, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? inventory(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`)
    : /\.jsonl?$/.test(entry.name) ? [`${prefix}${entry.name}`] : []);
}
test('every client/all corpus file is claimed; unknown files fail', (t) => {
  const required = inventory().filter((path) => !server.has(path) && !['admit', 'text'].includes(path.split('/')[0]));
  assert.deepEqual(required.filter((path) => !claims.has(path)), []);
  assert.deepEqual([...claims.keys()].filter((path) => !required.includes(path)), []);
  t.diagnostic(`${claims.size} client/all files; ${[...claims.values()].reduce((a, b) => a + b, 0)} vectors/transcript steps; zero unclaimed`);
});
