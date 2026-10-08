import composition from '../../../../packages/api-contract/sync/composition.json' with { type: 'json' };
import gym from '../../../../packages/api-contract/sync/gym.registry.json' with { type: 'json' };
import journal from '../../../../packages/api-contract/sync/journal.registry.json' with { type: 'json' };
import { Registry } from '../../../../packages/api-contract/sync/reference/core/registry.js';

const registries = { 'gym.registry.json': gym, 'journal.registry.json': journal };
const members = composition.registries.map((name) => registries[name]);
if (members.some((member) => !member)) throw new Error('unknown sync registry');
if (new Set(members.map((member) => member.version)).size !== 1) throw new Error('sync schema mismatch');

export const registry = new Registry({
  registry: composition.composition,
  version: members[0].version,
  minVersion: Math.max(...members.map((member) => member.minVersion)),
  products: Object.assign({}, ...members.map((member) => member.products)),
  types: members.flatMap((member) => member.types),
  commands: members.flatMap((member) => member.commands ?? []),
});
