// The plan grammar's shared cases (packages/api-contract/roadmap/plan/README.md), each run through the code the room
// runs: a text read, a plan to the domain's creation and to its import as the device's copy writes them, and a
// roadmap written and read back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { graftPlan } from '../../../../src/products/roadmap/paste/graftPlan.js';
import { parsePlan, plantedRoadmap, serializePlan } from '../../../../src/products/roadmap/paste/planGrammar.js';
import { ReplicaBirth } from '../../../../src/products/roadmap/room/ReplicaBirth.js';
import { ReplicaSession } from '../../../../src/products/roadmap/room/ReplicaSession.js';
import { Contract } from '../../../platform/domain-kit/vectors.js';

const OPERATIONS = {
  'read.json': ({ text, kinds }) => parsePlan(text, kinds),
  'read-into.json': ({ text, kinds }) => parsePlan(text, kinds, { bindOnly: true }),
  'create-roadmap.json': ({ text, kinds, name }) => {
    const roadmap = plantedRoadmap(parsePlan(text, kinds), name);
    if (roadmap === null) return null;
    const { title, steps, kinds: legend } = ReplicaBirth.creation(roadmap);
    const idOfKey = Object.fromEntries(steps.steps.map(({ key }) => [key, key]));
    return { CreateRoadmap: { title, steps, kinds: legend }, Complete: ReplicaBirth.marks(roadmap, { tree: 'T', steps: idOfKey }).map((mark) => mark.step) };
  },
  'import-steps.json': ({ text, kinds, under, held }) => {
    const graft = graftPlan({ parse: parsePlan(text, kinds, { bindOnly: true }), targetId: under, reservedNodeIds: held, liveKinds: kinds });
    if (graft === null) return null;
    const [importing, ...creating] = new ReplicaSession({ treeId: 'T', runner: null, roadmap: null, say: null }).actsOf({ kind: 'ImportSubgraph', ...graft });
    return { ImportSteps: { imported: importing.imported, under: importing.under }, CreateKind: creating.map((act) => act.kind) };
  },
  'write.json': ({ title, guide, kinds, nodes, done, readOver }) => {
    const text = serializePlan({ title, guide, nodes }, kinds, done);
    return { text, readBack: parsePlan(text, readOver) };
  },
};

test('every file of the plan cases is claimed', () => {
  const files = readdirSync(new URL('../../../../../packages/api-contract/roadmap/plan/', import.meta.url)).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(files, Object.keys(OPERATIONS).sort());
});

for (const [file, run] of Object.entries(OPERATIONS)) {
  for (const vector of Contract.vectors(`roadmap/plan/${file}`)) {
    test(`${file}: ${vector.name}`, () => assert.deepEqual(run(vector.input), vector.expect));
  }
}
