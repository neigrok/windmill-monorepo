import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { seededId } from '../../core/derive.js';
import { Registry, RegistryError, isPortablePattern } from '../../core/registry.js';

const CONTRACT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name) => JSON.parse(readFileSync(`${CONTRACT}${name}`, 'utf8'));
const SCHEMA = read('registry.schema.json');
const PROBE = read('probe.registry.json');
// The registries the products ship: every registry file but the test-only probe's.
const PRODUCTS = readdirSync(CONTRACT).filter((name) => name.endsWith('.registry.json') && name !== 'probe.registry.json').sort().map(read);
// The registries a deployment composes (§2.4): composition.json names them.
const COMPOSITION = read('composition.json');
const COMPOSED = COMPOSITION.registries.map(read);

// The JSON Schema 2020-12 keywords registry.schema.json uses, and no others: a failed keyword throws.
function errorsOf(schema, value, path = '$', root = schema) {
  if (schema === true) return [];
  if (schema === false) return [`${path}: nothing is allowed here`];
  const errors = [];
  const add = (message) => errors.push(`${path}: ${message}`);
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  const known = new Set(['$schema', '$id', 'title', 'description', '$defs', '$ref', 'type', 'properties', 'required', 'additionalProperties',
    'propertyNames', 'enum', 'const', 'pattern', 'minimum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'minLength', 'minProperties', 'uniqueItems', 'items', 'oneOf', 'allOf', 'if', 'then', 'not']);
  for (const keyword of Object.keys(schema)) if (!known.has(keyword)) throw new Error(`the test validator lacks ${keyword}`);
  if (schema.$ref) {
    const target = schema.$ref.replace('#/', '').split('/').reduce((node, key) => node[key], root);
    errors.push(...errorsOf(target, value, path, root));
  }
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    const fits = schema.type === actual || (schema.type === 'number' && actual === 'integer');
    if (!fits) return [...errors, `${path}: expected ${schema.type}, got ${actual}`];
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) add(`expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) add(`not one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) add(`does not match ${schema.pattern}`);
  if (typeof value === 'string' && schema.minLength !== undefined && [...value].length < schema.minLength) add(`shorter than ${schema.minLength}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add(`below ${schema.minimum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) add(`not above ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) add(`not below ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add(`fewer than ${schema.minItems} items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) add('items repeat');
    if (schema.items) value.forEach((item, index) => errors.push(...errorsOf(schema.items, item, `${path}[${index}]`, root)));
  }
  if (typeOf(value) === 'object') {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) add(`fewer than ${schema.minProperties} properties`);
    for (const key of schema.required ?? []) if (!keys.includes(key)) add(`missing ${key}`);
    for (const key of keys) {
      if (schema.propertyNames) errors.push(...errorsOf(schema.propertyNames, key, `${path}{${key}}`, root));
      if (schema.properties && Object.hasOwn(schema.properties, key)) errors.push(...errorsOf(schema.properties[key], value[key], `${path}.${key}`, root));
      else if (schema.additionalProperties !== undefined) errors.push(...errorsOf(schema.additionalProperties, value[key], `${path}.${key}`, root));
    }
  }
  for (const part of schema.allOf ?? []) errors.push(...errorsOf(part, value, path, root));
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((option) => errorsOf(option, value, path, root).length === 0).length;
    if (matches !== 1) add(`matches ${matches} of oneOf`);
  }
  if (schema.not && errorsOf(schema.not, value, path, root).length === 0) add('matches not');
  if (schema.if !== undefined && errorsOf(schema.if, value, path, root).length === 0 && schema.then) errors.push(...errorsOf(schema.then, value, path, root));
  return errors;
}

function broken(edit) {
  const copy = structuredClone(PROBE);
  edit(copy);
  return copy;
}

const card = (registry) => registry.types.find((type) => type.type === 'card');
const command = (registry, name) => registry.commands.find((entry) => entry.name === name);

test('the probe registry is valid against registry.schema.json', () => {
  assert.deepEqual(errorsOf(SCHEMA, PROBE), []);
});

test('registry.schema.json refuses broken registries', () => {
  const cases = {
    'no types': broken((r) => delete r.types),
    'an unknown identity class': broken((r) => { card(r).identity = 'random'; }),
    'a ranked field without ranks': broken((r) => { delete card(r).fields.tier.rank; }),
    'a serial field written by clients': broken((r) => { r.types.find((t) => t.type === 'lap').fields.no.writer = 'client'; }),
    'a minted type without an id space': broken((r) => { delete card(r).idSpace; }),
    'an unknown field kind': broken((r) => { card(r).fields.title.kind = 'counter'; }),
    'a singleton with life': broken((r) => { r.types.find((t) => t.type === 'meta').life = true; }),
    'a tuple key of one part': broken((r) => { r.types.find((t) => t.type === 'link').key.tuple.pop(); }),
    'a malformed argument type': broken((r) => { r.commands[0].args.id.type = 'ref<Run>'; }),
    'an unknown type property': broken((r) => { card(r).colour = 'red'; }),
    'a parent without a ref': broken((r) => { delete r.types.find((t) => t.type === 'lap').fields.runId.ref; }),
    'a derived type without its rule': broken((r) => { delete r.types.find((t) => t.type === 'tag').derive; }),
    'an unanchored id pattern': broken((r) => { card(r).idPattern = '[a-z]+'; }),
    'a quantum of zero': broken((r) => { card(r).fields.size.domain.quantum = 0; }),
    'a quantum above 1 that is not an integer': broken((r) => { card(r).fields.size.domain.quantum = 2.5; }),
    'a quantum on the field rather than its number domain': broken((r) => { card(r).fields.size.quantum = 0.01; }),
    'a quantum on a string domain': broken((r) => { card(r).fields.title.domain.quantum = 1; }),
    'a product code that is not kebab-case': broken((r) => { r.products.probe.codes = ['Bad_Code']; }),
    'a whole put on a minted type': broken((r) => { card(r).wholePut = true; }),
    'a whole put on a keyed type without life': broken((r) => { r.types.find((t) => t.type === 'mark').wholePut = true; }),
    'a whole put type with a client field that is not lww': broken((r) => { r.types.find((t) => t.type === 'fact').fields.at.kind = 'fww'; }),
    'a whole put type with a server-written text field': broken((r) => { Object.assign(r.types.find((t) => t.type === 'fact').fields, { note: { kind: 'text', writer: 'server', unit: 'bytes', max: 40 } }); }),
    'a minted type without its mint': broken((r) => { delete card(r).mint; }),
    'a mint alphabet of one character': broken((r) => { card(r).mint.alphabet = 'a'; }),
    'an opens field a client writes': broken((r) => { r.types.find((t) => t.type === 'meta').fields.visibility.writer = 'client'; }),
    'a beforePull command that is not server-internal': broken((r) => { command(r, 'probe.tick').serverInternal = false; }),
    'an order field on a keyed type': broken((r) => { r.types.find((t) => t.type === 'day').fields.ord = { kind: 'lww', writer: 'client', domain: { type: 'fracKey' } }; }),
    'a governing type with scoped ids': broken((r) => { r.types.find((t) => t.type === 'board').idSpace = 'scope'; }),
    'a bound without its unit': broken((r) => { delete card(r).fields.title.unit; }),
    'a string domain bound without its unit': broken((r) => { delete command(r, 'probe.start').args.label.domain.unit; }),
    'a pattern outside printable ASCII': broken((r) => { card(r).idPattern = '^[a-zé]{8,64}$'; }),
    'an order field on a singleton': broken((r) => { r.types.find((t) => t.type === 'meta').fields.ord = { kind: 'lww', writer: 'client', domain: { type: 'fracKey' } }; }),
  };
  for (const [name, registry] of Object.entries(cases)) assert.notDeepEqual(errorsOf(SCHEMA, registry), [], name);
});

test('the Registry refuses what the schema cannot express', () => {
  const cases = {
    'a ref to an unknown type': broken((r) => { card(r).fields.attachment.ref = 'ghost'; }),
    'origins without replica': broken((r) => { card(r).origins = ['server']; }),
    'a revivable type whose dead rows are spent': broken((r) => { card(r).revivable = true; }),
    'serialNext naming an unknown field': broken((r) => { r.types.find((t) => t.type === 'lap').fields.no.serialNext = ['ghost']; }),
    'a server-internal command a replica may call': broken((r) => { command(r, 'probe.tick').origins = ['replica', 'server']; }),
    'a mint whose ids miss idPattern': broken((r) => { card(r).mint.length = 4; }),
    'a mint alphabet outside idPattern': broken((r) => { card(r).mint.alphabet = 'ab!'; }),
    'opens on a field of a product-scope type': broken((r) => { card(r).fields.claim.opens = ['x']; card(r).fields.claim.writer = 'server'; }),
    'opens values outside the domain': broken((r) => { r.types.find((t) => t.type === 'meta').fields.visibility.opens = ['secret']; }),
    'a default off the field\'s domain': broken((r) => { card(r).fields.size.default = 1.005; }),
    'a default on a serial field': broken((r) => { r.types.find((t) => t.type === 'lap').fields.no.default = 1; }),
    'a product code that is an engine code': broken((r) => { r.products.probe.codes = ['stale']; }),
    'a whole put on a type with a text field': broken((r) => { Object.assign(r.types.find((t) => t.type === 'fact').fields, { note: { kind: 'text', writer: 'client', unit: 'bytes', max: 40 } }); }),
    'a whole put type with a client field that is not lww': broken((r) => { r.types.find((t) => t.type === 'fact').fields.at.kind = 'const'; }),
    'a command that predicts a whole put type': broken((r) => { command(r, 'probe.start').predicts.push('fact'); }),
    'a quantum that is neither an integer nor 1/k': broken((r) => { card(r).fields.size.domain.quantum = 0.3; }),
    'a key that names its own type': broken((r) => { r.types.find((t) => t.type === 'mark').key.ref = 'mark'; }),
    'two keys that name each other': broken((r) => {
      r.types.find((t) => t.type === 'mark').key.ref = 'link';
      r.types.find((t) => t.type === 'link').key.tuple[0].ref = 'mark';
    }),
    'a tuple key part that leads back to its own type': broken((r) => { r.types.find((t) => t.type === 'link').key.tuple[1].ref = 'link'; }),
    'a string domain bound without its unit': broken((r) => { delete command(r, 'probe.start').args.label.domain.unit; }),
    'an idPattern with a dot': broken((r) => { r.types.find((t) => t.type === 'run').idPattern = '^.{8,64}$'; }),
    'a domain pattern with a class escape': broken((r) => { card(r).fields.attachment.domain.properties.id.pattern = '^\\S{8,64}$'; }),
    'a keyPattern with a negated class': broken((r) => { r.products.probe.device.picture.keyPattern = '^picture:[^/]{8,64}$'; }),
  };
  for (const [name, registry] of Object.entries(cases)) assert.throws(() => new Registry(registry), RegistryError, name);
});

test('§2.4 patterns: only the portable subset, which every dialect reads alike, repeat counts at most 65 535', () => {
  const patterns = [
    '^b_[0-9a-f]{8}$', '^[A-Za-z0-9_-]{8,64}$', '^[-a]$', '^(?:ab|cd)+$', '^(a|b)?c{2,}$', '^a\\.b\\/c$', '^[\\]\\-]$',
    'b_[0-9a-f]{8}$', '^b_[0-9a-f]{8}', '^a|b$', '^.{1,64}$', '^\\s+$', '^\\d+$', '^\\w+$', '^a\\b$', '^\\_$',
    '^[^/]+$', '^[]$', '^[z-a]$', '^[a-b-c]$', '^[a--]$', '^[a&&b]$', '^[[a]]$', '^a+?$', '^a**$', '^a{3,2}$', '^a{,2}$',
    '^(?=a)a$', '^(a)\\1$', '^a$b$', '^é$', '^a\\$',
    '^a{65535}$', '^a{1,65535}$', '^[a:]$', '^a{65536}$', '^a{2,65536}$', '^[:a]$', '^[\\--a]$',
  ];
  assert.deepEqual(patterns.map(isPortablePattern), [
    true, true, true, true, true, true, true,
    false, false, false, false, false, false, false, false, false,
    false, false, false, false, false, false, false, false, false, false, false,
    false, false, false, false, false,
    true, true, true, false, false, false, false,
  ]);
});

test('the Registry, like the schema, keeps a governing type global', () => {
  assert.throws(() => new Registry(broken((r) => { r.types.find((type) => type.type === 'board').idSpace = 'scope'; })), RegistryError);
});

test('the Registry, like the schema, keeps order fields on minted and derived types', () => {
  const order = { kind: 'lww', writer: 'client', domain: { type: 'fracKey' } };
  for (const t of ['day', 'meta']) {
    assert.throws(() => new Registry(broken((r) => { r.types.find((type) => type.type === t).fields.ord = order; })), RegistryError, t);
  }
});

test('scope references map to registry scope kinds', () => {
  const registry = new Registry(PROBE);
  assert.deepEqual(
    ['self/probe', 'self/overlay/b_00000001', 'tree/b_00000001', 'device/probe', 'self/gym', 'tree/', 'self/overlay/', 'other/x'].map((ref) => registry.scopeKindOf(ref)),
    ['product:probe', 'overlay', 'tree', 'device', null, null, null, null],
  );
  assert.deepEqual(['self/probe', 'tree/b_00000001', 'self/overlay/b_00000001', 'device/probe'].map((ref) => registry.productOfRef(ref)), ['probe', 'probe', 'probe', 'probe']);
});

test('the registry exposes the opening field and the before-pull commands', () => {
  const registry = new Registry(PROBE);
  assert.deepEqual(registry.opening, { type: 'meta', id: 'meta', field: 'visibility', values: ['unlisted', 'public'] });
  assert.deepEqual(registry.beforePullCommands('product:probe').map((entry) => entry.name), ['probe.tick']);
  assert.deepEqual(registry.beforePullCommands('tree'), []);
});

test('the product registries are gym and journal, each valid against registry.schema.json and the Registry', () => {
  assert.deepEqual(PRODUCTS.map((registry) => registry.registry), ['gym', 'journal']);
  for (const registry of PRODUCTS) {
    assert.deepEqual(errorsOf(SCHEMA, registry), [], registry.registry);
    assert.doesNotThrow(() => new Registry(registry), registry.registry);
  }
});

// A deployment composes the registries composition.json names into one registry: one version, the version every
// request carries (§9.1), and no product, type, command or refusal code a second registry declares again. It names
// gym and journal (§2.4).
test('composition.json names the composed registries: gym and journal, each a product registry', () => {
  assert.deepEqual(Object.keys(COMPOSITION).sort(), ['composition', 'registries']);
  assert.deepEqual(COMPOSITION.registries, ['gym.registry.json', 'journal.registry.json']);
  for (const name of COMPOSITION.registries) assert.ok(PRODUCTS.some((registry) => `${registry.registry}.registry.json` === name), name);
});

// So a product registry joins the composition without a rename, no two product registries, composed or not, declare a
// name twice.
test('the composed registries declare one version, and no product registry declares a name another does', () => {
  assert.deepEqual(COMPOSED.map((registry) => [registry.version, registry.minVersion]), [[6, 4], [6, 4]]);
  const names = (pick) => PRODUCTS.flatMap(pick);
  const codes = names((r) => Object.values(r.products).flatMap((product) => product.codes ?? []));
  for (const declared of [names((r) => Object.keys(r.products)), names((r) => r.types.map((t) => t.type)), names((r) => r.commands.map((c) => c.name)), codes]) {
    assert.deepEqual(declared.filter((name, index) => declared.indexOf(name) !== index), []);
  }
});

test('gym authoritative metadata preserves server writers, frozen values and unknown creation counts', () => {
  const gym = PRODUCTS.find((registry) => registry.registry === 'gym');
  const fields = (name) => gym.types.find((type) => type.type === name).fields;
  assert.deepEqual({
    revision: fields('routine').revision,
    createdEntries: fields('routine').createdEntries,
    baseRevision: fields('proposal').baseRevision,
    baseName: fields('proposal').baseName,
    changeCount: fields('proposal').changeCount,
    updatedAt: fields('note').updatedAt,
  }, {
    revision: { kind: 'lww', writer: 'server', domain: { type: 'number', integer: true, min: 1, max: 2147483647 } },
    createdEntries: { kind: 'const', writer: 'server', domain: { type: 'number', integer: true, min: 0, max: 2147483647 } },
    baseRevision: { kind: 'const', writer: 'server', domain: { type: 'number', integer: true, min: 1, max: 2147483647 } },
    baseName: { kind: 'const', writer: 'server', unit: 'bytes', max: 240, domain: { type: 'string' } },
    changeCount: { kind: 'const', writer: 'server', domain: { type: 'number', integer: true, min: 0, max: 2147483647 } },
    updatedAt: { kind: 'lww', writer: 'server', domain: { type: 'number', integer: true, min: 0 } },
  });
});

test('gym creation receipts keep independent string identities and exact server snapshots after routine death', () => {
  const gym = PRODUCTS.find((registry) => registry.registry === 'gym');
  const receiptIndex = gym.types.findIndex((type) => type.type === 'routineCreation');
  assert.equal(gym.types[receiptIndex - 1].type, 'routine');
  assert.deepEqual(gym.types[receiptIndex], {
    type: 'routineCreation',
    scope: 'product:gym',
    identity: 'keyed',
    idPattern: gym.types[receiptIndex - 1].idPattern,
    life: false,
    origins: ['replica', 'server'],
    fields: { snapshot: { kind: 'const', writer: 'server', domain: { type: 'json' } } },
  });
});

// D-8 and A.2: every gym minted type is seeded, and its widest seeded id, a seed at the bound and the largest ordinal, fits
// its id pattern.
test('every minted gym type is seeded, its widest seeded id in its pattern', () => {
  const minted = PRODUCTS.flatMap((json) => [...new Registry(json).types.values()]).filter((type) => type.identity === 'minted');
  const seeded = minted.filter((type) => type.seeded);
  assert.deepEqual(seeded.map((type) => type.type), minted.map((type) => type.type));
  assert.deepEqual(seeded.map((type) => type.type), ['routine', 'exercise', 'session', 'set', 'note', 'proposal']);
  for (const type of seeded) {
    assert.doesNotThrow(() => seededId(type, 'Z'.repeat(type.seeded.seedMax), type.seeded.ordinalMax), type.type);
  }
});
