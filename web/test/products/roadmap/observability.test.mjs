import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { transformWithEsbuild } from 'vite';

const web = fileURLToPath(new URL('../../../', import.meta.url));

function sourcePathsUnder(directory) {
  return readdirSync(join(web, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourcePathsUnder(path);
    return /\.jsx?$/.test(entry.name) ? [path] : [];
  });
}

function namesIn(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))].sort();
}

const sources = sourcePathsUnder('src/products/roadmap').map((path) => ({ path, text: readFileSync(join(web, path), 'utf8') }));
const code = sources.map((source) => source.text).join('\n');
const doc = readFileSync(join(web, 'OBSERVABILITY.md'), 'utf8');
const roadmap = doc.slice(doc.indexOf('## Roadmap'));
const eventsTable = roadmap.slice(roadmap.indexOf('### Events'), roadmap.indexOf('### When an event stays silent'));
const failuresTable = roadmap.slice(roadmap.indexOf('### Technical failures'));

test('every event the roadmap emits has its row in OBSERVABILITY.md, and every row still has an emitter', () => {
  const inCode = [...new Set([
    ...namesIn(code, /\btrack\(\s*'([a-z_]+)'/g),
    ...namesIn(code, /name: '(roadmap_[a-z_]+)'/g),
    ...namesIn(code, /eventName = editing \? '([a-z_]+)'/g),
    ...namesIn(code, /eventName = editing \? '[a-z_]+' : '([a-z_]+)'/g),
  ])].sort();
  const documented = namesIn(eventsTable, /^\| [^|]+ \| `([a-z_]+)` \|/gm);
  assert.deepEqual(inCode, documented);
});

test('every Sentry operation the roadmap reports has its row in OBSERVABILITY.md, and every row still reports', () => {
  const reported = namesIn(code, /'(roadmap-[a-z]+(?:-[a-z]+)*)'/g);
  const documented = namesIn(failuresTable, /^\| `(roadmap-[a-z-]+)` \|/gm);
  assert.deepEqual(reported, documented);
});

// One row of the events table: { door: { values: ['a', 'b'], optional: false } }, by event name.
function documentedRows() {
  const rows = new Map();
  for (const [, name, cell] of eventsTable.matchAll(/^\| [^|]+ \| `([a-z_]+)` \| (.+) \|$/gm)) {
    const row = {};
    for (const [, key, optional, values] of cell.matchAll(/`([a-zA-Z]+)(\?)?: ([^`]+)`/g)) {
      row[key] = { values: values.split('/'), optional: optional === '?' };
    }
    rows.set(name, [...(rows.get(name) ?? []), row]);
  }
  return rows;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((entry) => walk(entry, visit));
    else if (child && typeof child === 'object') walk(child, visit);
  }
}

const calleeName = (call) => call.callee.property?.name ?? call.callee.name;

// A property's literal values, or null when only the running code knows them.
function literalValues(value) {
  if (value.type === 'Literal') return [String(value.value)];
  if (value.type === 'ConditionalExpression') {
    const branches = [literalValues(value.consequent), literalValues(value.alternate)];
    return branches.every(Boolean) ? branches.flat() : null;
  }
  return null;
}

const COUNT_BUCKETS = ['0', '1', '2-5', '6-20', '21+'];
const CONTENT_MEMBERS = new Set(['label', 'title', 'name', 'email', 'description', 'text', 'note', 'message', 'body', 'prompt', 'answer', 'token', 'id']);
const CONTENT_VARIABLES = new Set(['label', 'title', 'email', 'description', 'text', 'note', 'message', 'body', 'prompt', 'answer', 'token']);
// The two ids an event may carry, each documented as a constant or an authored id.
const AUTHORED_IDS = { demo_open: 'treeId', birth: 'quest' };

function readsContent(value, event, key) {
  let found = false;
  walk(value, (node) => {
    if (node.type === 'Identifier' && CONTENT_VARIABLES.has(node.name)) found = true;
    if (node.type !== 'MemberExpression' || node.computed || !CONTENT_MEMBERS.has(node.property.name)) return;
    if (node.property.name !== 'id' || AUTHORED_IDS[event] !== key) found = true;
  });
  return found;
}

// What a props object holds: its keys, the spreads it folds in, and each value as written.
function propsOf(object, event) {
  const shape = { keys: new Map(), spreads: [], problems: [] };
  for (const property of object?.properties ?? []) {
    if (property.type === 'SpreadElement') {
      shape.spreads.push(property.argument.name);
      continue;
    }
    if (property.computed) {
      shape.problems.push(`${event}: a computed prop name`);
      continue;
    }
    const key = property.key.name ?? property.key.value;
    if (readsContent(property.value, event, key)) shape.problems.push(`${event}: ${key} reads content`);
    const bucketed = property.value.type === 'CallExpression' && calleeName(property.value) === 'countBucket';
    shape.keys.set(key, { values: bucketed ? COUNT_BUCKETS : literalValues(property.value), opaque: !bucketed && !literalValues(property.value), value: property.value });
  }
  return shape;
}

const isUnboundedCount = (value) => {
  let found = false;
  walk(value, (node) => { if (node.type === 'MemberExpression' && node.property.name === 'length') found = true; });
  return found;
};

function fitsRow(shape, row, { partial }) {
  for (const [key, prop] of shape.keys) {
    if (!row[key]) return false;
    if (prop.values && !prop.values.every((value) => row[key].values.includes(value) || row[key].values[0].startsWith('<'))) return false;
    if (prop.opaque && row[key].values.includes('2-5') && isUnboundedCount(prop.value)) return false;
  }
  if (partial) return true;
  return Object.entries(row).every(([key, { optional }]) => optional || shape.keys.has(key));
}

// Functions that hand their last argument to a track call's spread, and the event it lands in.
const FORWARDERS = {
  'src/products/roadmap/graph/useGraphEditing.js': { writeEdit: { spread: 'changed', event: 'roadmap_board_edit' } },
  'src/products/roadmap/step/StepDetail.jsx': { act: { spread: 'extra', event: 'roadmap_board_step_action' } },
};

function readParsedEvents(parsedSources) {
  const found = { calls: [], problems: [] };
  for (const { path, ast } of parsedSources) {
    let eventNameChoices = null;
    walk(ast, (node) => {
      if (node.type === 'VariableDeclarator' && node.id.name === 'eventName') eventNameChoices = literalValues(node.init);
    });
    walk(ast, (node) => {
      if (node.type === 'ObjectExpression') {
        const name = node.properties.find((property) => property.key?.name === 'name');
        const props = node.properties.find((property) => property.key?.name === 'props');
        if (name?.value.type === 'Literal' && props?.value.type === 'ObjectExpression') found.calls.push({ path, events: [name.value.value], props: props.value });
        return;
      }
      if (node.type !== 'CallExpression') return;
      const callee = calleeName(node);
      if (callee === 'track' || callee === 'trackEvent') {
        const [event, props] = node.arguments;
        const named = event?.type === 'MemberExpression' && event.property.name === 'name' && props?.type === 'MemberExpression' && props.property.name === 'props';
        if (named) return; // a descriptor, read above where it is written
        const events = event?.type === 'Identifier' && event.name === 'eventName' ? eventNameChoices : literalValues(event);
        if (!events) found.problems.push(`${path}: an event name that is not a literal`);
        else if (props && props.type !== 'ObjectExpression') found.problems.push(`${path}: ${events[0]} takes props that are not an object literal`);
        else found.calls.push({ path, events, props });
      }
      const forwarder = FORWARDERS[path]?.[callee];
      const passed = node.arguments.at(-1);
      if (forwarder && node.arguments.length === 2) {
        if (passed.type === 'ObjectExpression') found.calls.push({ path, events: [forwarder.event], props: passed, partial: true });
        else if (passed.type !== 'Identifier' || passed.name !== forwarder.spread) found.problems.push(`${path}: ${callee} takes props that are not an object literal`);
      }
    });
  }
  return found;
}

const parsedSources = Promise.all(sources.map(async ({ path, text }) => {
  const { code: plain } = await transformWithEsbuild(text, path, { loader: 'jsx' });
  return { path, ast: parse(plain, { ecmaVersion: 'latest', sourceType: 'module' }) };
}));

test('every prop of every event fits one row of its event in OBSERVABILITY.md, and none reads what someone wrote', async () => {
  const rows = documentedRows();
  const { calls, problems } = readParsedEvents(await parsedSources);
  assert.ok(calls.length > 150, `read ${calls.length} events`);
  for (const { path, events, props, partial } of calls) {
    const shape = propsOf(props, events[0]);
    problems.push(...shape.problems.map((problem) => `${path}: ${problem}`));
    for (const spread of shape.spreads) {
      if (!Object.values(FORWARDERS[path] ?? {}).some((forwarder) => forwarder.spread === spread)) problems.push(`${path}: ${events[0]} spreads ${spread}`);
    }
    // A composer's one call names two events, and only the running code knows which rows it can reach.
    const fits = events.some((event) => (rows.get(event) ?? []).some((row) => fitsRow(shape, row, { partial: partial || shape.spreads.length > 0 })));
    if (!fits) problems.push(`${path}: ${events.join(' or ')} { ${[...shape.keys.keys()].join(', ')} } fits no row`);
  }
  assert.deepEqual(problems, []);
});

const REPORTERS = new Set(['reportRoadmapFailure', 'reportUnexpectedFailure', 'report', 'reportFailure']);
const OPERATION = /^roadmap-[a-z]+(?:-[a-z]+)*$/;

// A literal operation, none at all, or the name `operation` standing for one written literally where it is given.
function isStaticOperation(node) {
  if (node.type === 'Literal') return node.value === null || OPERATION.test(String(node.value));
  if (node.type === 'Identifier') return node.name === 'operation';
  if (node.type === 'MemberExpression') return node.property.name === 'operation';
  if (node.type === 'LogicalExpression') return isStaticOperation(node.left) && isStaticOperation(node.right);
  if (node.type === 'ConditionalExpression') return isStaticOperation(node.consequent) && isStaticOperation(node.alternate);
  return false;
}

test('every Sentry report names a static operation and builds no message from what someone wrote', async () => {
  const problems = [];
  for (const { path, ast } of await parsedSources) {
    walk(ast, (node) => {
      const given = [
        node.type === 'Property' && !node.computed && node.key.name === 'operation' && node.value.type !== 'AssignmentPattern' && node.value,
        node.type === 'AssignmentPattern' && node.left.name === 'operation' && node.right,
        node.type === 'VariableDeclarator' && node.id.name === 'operation' && node.init,
      ].find(Boolean);
      if (given && !isStaticOperation(given)) problems.push(`${path}: an operation that is not a literal`);
      if (node.type !== 'CallExpression' || !REPORTERS.has(calleeName(node)) || node.arguments.length === 0) return;
      const [operation, error] = node.arguments;
      if (!isStaticOperation(operation)) problems.push(`${path}: an operation that is not a literal`);
      const built = error?.type === 'NewExpression' ? error.arguments[0] : null;
      if (built && built.type !== 'Literal') problems.push(`${path}: a report whose error message is built at run time`);
    });
  }
  assert.deepEqual(problems, []);
});
