import roster from '../../../../../packages/api-contract/roadmap/quests/roster.json' with { type: 'json' };

// The id a quest's kind takes, by the hue it wears, on the roads that name a kind themselves (`POST /v1/trees` and the
// device's lattice): a genesis kind's id changes that kind in place, keeping its rank. `CreateRoadmap` mints its own.
const KIND_IDS = {
  'frontend-path': { terracotta: 'build', olive: 'learn', gold: 'ship' },
  'rust-from-zero': { brick: 'core', olive: 'practice', gold: 'ship' },
  'ml-foundations': { plum: 'theory', sky: 'data', terracotta: 'practice' },
  'ship-v1': { terracotta: 'build', sky: 'polish', gold: 'launch' },
  'learn-to-sail': { terracotta: 'seamanship', olive: 'knots', sky: 'weather', brick: 'safety', gold: 'harbor' },
  'run-a-10k': { olive: 'training', gold: 'race-prep' },
  'room-makeover': { terracotta: 'make', sky: 'assemble' },
  'personal-finance-reset': { olive: 'habits', sky: 'systems' },
  'learn-watercolor': { sky: 'technique', terracotta: 'studies' },
};

// The shared roster in its order, each quest as the room reads a roadmap: steps that name the steps they follow and
// their web links by bare address, the shape the thumbnail lays out and every planting road takes.
export const ROSTER = roster.map(({ id, group, estimate, source, plants }) => ({
  id,
  title: plants.title,
  group,
  estimate,
  source,
  kinds: plants.kinds.map(({ hue, label, description }) => ({ id: KIND_IDS[id][hue], hue, label, description })),
  nodes: plants.steps.steps.map(({ key, label, icon, color, description, links }) => ({
    id: key,
    label,
    color,
    prerequisites: plants.steps.links.filter(([, to]) => to === key).map(([from]) => from),
    description,
    ...(links ? { links: links.map((link) => link.url) } : {}),
    ...(icon ? { icon } : {}),
  })),
}));
