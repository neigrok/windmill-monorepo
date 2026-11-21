import composition from '../../../../packages/api-contract/sync/composition.json' with { type: 'json' };
import gym from '../../../../packages/api-contract/sync/gym.registry.json' with { type: 'json' };
import journal from '../../../../packages/api-contract/sync/journal.registry.json' with { type: 'json' };
import roadmap from '../../../../packages/api-contract/sync/roadmap.registry.json' with { type: 'json' };
import { composeRegistry } from '../../../../packages/api-contract/sync/reference/core/composition.js';
import { Registry } from '../../../../packages/api-contract/sync/reference/core/registry.js';

const registries = { 'gym.registry.json': gym, 'journal.registry.json': journal, 'roadmap.registry.json': roadmap };
export const registry = new Registry(composeRegistry(composition, registries));
