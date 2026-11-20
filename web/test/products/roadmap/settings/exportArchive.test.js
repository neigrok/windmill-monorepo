import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSTANTS } from '../../../../../packages/api-contract/sync/reference/core/constants.js';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { roadmapRegistry } from '../domain/vectors.js';
import { closuresIn } from '../sourceClosures.js';
import { CreateKind } from '../../../../src/products/roadmap/domain/kinds.js';
import { Complete } from '../../../../src/products/roadmap/domain/progress.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { CreateRoadmap, CreateSubtree, WriteRoadmap } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { CreateStep, DeleteStep, RoadmapStep } from '../../../../src/products/roadmap/domain/steps.js';
import { AddStepLink, AddSubtask } from '../../../../src/products/roadmap/domain/workspace.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { parsePlan, serializePlan } from '../../../../src/products/roadmap/paste/planGrammar.js';
import { LatticeReading } from '../../../../src/products/roadmap/room/LatticeReading.js';
import { HeldRoadmap, ReplicaRoadmap } from '../../../../src/products/roadmap/room/ReplicaRoadmap.js';
import { ReplicaReading } from '../../../../src/products/roadmap/room/ReplicaReading.js';
import { buildExportArchive, buildRoadmapExport, readAccountRoadmaps, readReplicaRoadmaps, storeZip } from '../../../../src/products/roadmap/settings/exportArchive.js';

const HELLO = 'hello world'; // CRC32 0x0d4a1185
const FOX = 'The quick brown fox jumps over the lazy dog'; // CRC32 0x414fa339

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;

function bytes(files) {
  const out = storeZip(files);
  return { out, view: new DataView(out.buffer), text: (from, len) => new TextDecoder().decode(out.subarray(from, from + len)) };
}

test('the local file header carries the store signature, a real CRC32, the name, and the raw bytes', () => {
  const { out, view, text } = bytes([{ name: 'hello.txt', text: HELLO }]);

  assert.equal(view.getUint32(0, true), LOCAL_SIG);
  assert.equal(view.getUint16(4, true), 20); // version needed
  assert.equal(view.getUint16(8, true), 0); // method: store
  assert.equal(view.getUint32(14, true), 0x0d4a1185); // CRC32 of "hello world"
  assert.equal(view.getUint32(18, true), HELLO.length); // compressed size == raw size
  assert.equal(view.getUint32(22, true), HELLO.length); // uncompressed size
  assert.equal(view.getUint16(26, true), 'hello.txt'.length); // filename length
  assert.equal(text(30, 'hello.txt'.length), 'hello.txt');
  assert.equal(text(30 + 'hello.txt'.length, HELLO.length), HELLO);
  assert.equal(out.length, 30 + 9 + 11 + 46 + 9 + 22); // local + name + data + central + name + eocd
});

test('the central directory and end record close the archive, one entry per file', () => {
  const { out, view } = bytes([{ name: 'hello.txt', text: HELLO }, { name: 'fox.txt', text: FOX }]);

  const end = out.length - 22;
  assert.equal(view.getUint32(end, true), END_SIG);
  assert.equal(view.getUint16(end + 8, true), 2); // records on this disk
  assert.equal(view.getUint16(end + 10, true), 2); // total records

  const centralStart = view.getUint32(end + 16, true);
  const centralBytes = view.getUint32(end + 12, true);
  assert.equal(centralStart + centralBytes, end); // the directory sits flush against the end record
  assert.equal(view.getUint32(centralStart, true), CENTRAL_SIG);
  assert.equal(view.getUint32(centralStart + 16, true), 0x0d4a1185); // first entry's CRC32
  assert.equal(view.getUint32(centralStart + 42, true), 0); // first entry's local-header offset

  const secondCentral = centralStart + 46 + 'hello.txt'.length;
  assert.equal(view.getUint32(secondCentral, true), CENTRAL_SIG);
  assert.equal(view.getUint32(secondCentral + 16, true), 0x414fa339); // second entry's CRC32
});

test('a stock `unzip` accepts the archive and hands every file back verbatim', () => {
  const out = storeZip([{ name: 'hello.txt', text: HELLO }, { name: 'nested/fox.txt', text: FOX }]);
  const dir = mkdtempSync(join(tmpdir(), 'storezip-'));
  const archive = join(dir, 'out.zip');
  try {
    writeFileSync(archive, out);
    execFileSync('unzip', ['-t', archive]); // CRC integrity check — throws on a bad archive
    assert.equal(execFileSync('unzip', ['-p', archive, 'hello.txt']).toString(), HELLO);
    assert.equal(execFileSync('unzip', ['-p', archive, 'nested/fox.txt']).toString(), FOX);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one roadmap exports its current marks as a paste-format Markdown file with a stable name', async () => {
  const tree = {
    id: 't_1234567890', title: 'Learn to sail', kinds: [], nodes: [
      { id: 'root', label: 'Learn to sail', color: 'terracotta', prerequisites: [] },
      { id: 'wind', label: 'Read the wind', color: 'terracotta', prerequisites: ['root'] },
      { id: 'dock', label: 'Leave the dock', color: 'terracotta', prerequisites: ['wind'], description: 'Check the lines.' },
    ],
  };
  const file = buildRoadmapExport(tree, { completed: new Set(['wind']) });
  assert.deepEqual(file, {
    name: 'learn-to-sail-12345678.md',
    text: '# Learn to sail\n<!-- windmill:roadmap -->\n- Learn to sail <!-- windmill:kind terracotta -->\n  - [x] Read the wind\n    - Leave the dock\n      Check the lines.',
  });
  const replanted = parsePlan(file.text);
  assert.equal(serializePlan(replanted, replanted.kinds), file.text);
  assert.deepEqual(buildRoadmapExport({ id: 't_abcdefghijk', title: '🌱', nodes: [], kinds: [] }, null), {
    name: 'roadmap-abcdefgh.md', text: '# 🌱\n<!-- windmill:roadmap -->',
  });
});

test('export and Settings zip preserve a distinct root label and its completion under the roadmap title', async () => {
  const tree = {
    id: 't_1234567890', title: 'Learn to sail', kinds: [], nodes: [
      { id: 'root', label: 'Choose a course', color: 'terracotta', prerequisites: [] },
      { id: 'wind', label: 'Read the wind', color: 'terracotta', prerequisites: ['root'] },
      { id: 'dock', label: 'Leave the dock', color: 'terracotta', prerequisites: ['wind'] },
    ],
  };
  const file = buildRoadmapExport(tree, { completed: new Set(['root', 'wind']) });
  assert.deepEqual(file, {
    name: 'learn-to-sail-12345678.md',
    text: '# Learn to sail\n<!-- windmill:roadmap -->\n- [x] Choose a course <!-- windmill:kind terracotta -->\n  - [x] Read the wind\n    - Leave the dock',
  });
  const replanted = parsePlan(file.text);
  assert.deepEqual(replanted, {
    title: 'Learn to sail',
    missingRoot: false,
    nodes: [
      { id: 'choose-a-course', label: 'Choose a course', color: 'terracotta', prerequisites: [], icon: 'sparkles', status: 'complete' },
      { id: 'read-the-wind', label: 'Read the wind', color: 'terracotta', prerequisites: ['choose-a-course'], status: 'complete' },
      { id: 'leave-the-dock', label: 'Leave the dock', color: 'terracotta', prerequisites: ['read-the-wind'] },
    ],
    kinds: [],
    gutter: [
      { glyph: null, nodeId: null, liberty: null },
      { glyph: null, nodeId: null, liberty: null },
      { glyph: '✓', nodeId: 'choose-a-course', liberty: null },
      { glyph: '✓', nodeId: 'read-the-wind', liberty: null },
      { glyph: '·', nodeId: 'leave-the-dock', liberty: null },
    ],
    readout: { steps: 3, branches: 0, done: 2 },
    imperfections: [],
  });
  assert.equal(serializePlan(replanted, replanted.kinds), file.text);
  const archive = bytes([file]);
  const nameLength = archive.view.getUint16(26, true);
  const textLength = archive.view.getUint32(22, true);
  const archivedText = archive.text(30 + nameLength, textLength);
  assert.equal(archivedText, file.text);
  assert.deepEqual(parsePlan(archivedText), replanted);
});

test('an export carries the roadmap\'s guide as a quote under its title, and a replant plants the same steps without it', async () => {
  const nodes = [
    { id: 'root', label: 'Choose a course', color: 'terracotta', prerequisites: [] },
    { id: 'wind', label: 'Read the wind', color: 'terracotta', prerequisites: ['root'] },
  ];
  const guide = 'One step a week, on weekend sails with Maya.\n\n- Agents: ask before changing a completed step.\n<!-- /windmill:guide -->';
  const file = buildRoadmapExport({ id: 't_1234567890', title: 'Learn to sail', guide, kinds: [], nodes }, { completed: new Set(['root']) });
  assert.equal(file.text, [
    '# Learn to sail', '<!-- windmill:roadmap -->',
    '<!-- windmill:guide -->',
    '> One step a week, on weekend sails with Maya.', '>', '> - Agents: ask before changing a completed step.', '> <!-- /windmill:guide -->',
    '<!-- /windmill:guide -->',
    '- [x] Choose a course <!-- windmill:kind terracotta -->', '  - Read the wind',
  ].join('\n'));
  const withoutGuide = buildRoadmapExport({ id: 't_1234567890', title: 'Learn to sail', guide: '  \n', kinds: [], nodes }, { completed: new Set(['root']) });
  assert.equal(withoutGuide.text, '# Learn to sail\n<!-- windmill:roadmap -->\n- [x] Choose a course <!-- windmill:kind terracotta -->\n  - Read the wind');
  const replanted = parsePlan(file.text);
  const { gutter, ...planted } = replanted;
  const { gutter: plainGutter, ...plain } = parsePlan(withoutGuide.text);
  assert.deepEqual(planted, plain);
  assert.equal(gutter.length, plainGutter.length + 6);
  assert.deepEqual(replanted.imperfections, []);
});

test('a guide whose lines end in CR or CRLF stays in its quote, so a replant plants no step from it', async () => {
  const nodes = [{ id: 'root', label: 'Choose a course', color: 'terracotta', prerequisites: [] }];
  const planted = (guide) => parsePlan(buildRoadmapExport({ id: 't_1234567890', title: 'Sail', guide, kinds: [], nodes }, null).text).nodes.map(({ label }) => label);
  assert.deepEqual(planted('x\r<!-- /windmill:guide -->\r- A planted fake step'), ['Choose a course']);
  assert.deepEqual(planted('line one\r\n- line two\r\n<!-- /windmill:guide -->'), ['Choose a course']);
  assert.equal(buildRoadmapExport({ id: 't_1234567890', title: 'Sail', guide: 'a\rb\r\nc', kinds: [], nodes }, null).text.split('\n').slice(2, 7).join('|'),
    '<!-- windmill:guide -->|> a|> b|> c|<!-- /windmill:guide -->');
});

const committed = (outcome) => {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return outcome.result;
};

// The files of a stored zip, in its order.
function filesIn({ bytes }) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (from, length) => new TextDecoder().decode(bytes.subarray(from, from + length));
  const files = [];
  for (let at = 0; view.getUint32(at, true) === 0x04034b50;) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    files.push({ name: text(at + 30, nameLength), text: text(at + 30 + nameLength, size) });
    at += 30 + nameLength + size;
  }
  return files;
}

// What an exported file says, field by field, as a replant reads it: its name, title and guide, the legend's kinds, and
// each step with its mark, kind, the steps it comes after, its notes and its links.
function fieldsOf({ name, text }) {
  const plan = parsePlan(text);
  const labels = new Map(plan.nodes.map((node) => [node.id, node.label]));
  return {
    name, title: plan.title, guide: text.split('\n').filter((line) => line.startsWith('>')),
    kinds: plan.kinds.map(({ hue, label }) => ({ hue, label })),
    steps: plan.nodes.map((node) => ({ label: node.label, done: node.status === 'complete', kind: node.color,
      after: node.prerequisites.map((id) => labels.get(id)), notes: node.description ?? '', links: node.links ?? [] })),
  };
}

test('with the switch on, Settings and the row export a roadmap with a subtree, kinds, marks, links, a guide and a workspace from the device’s copy into the document today’s export makes of it', async (t) => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  t.after(() => a.close());
  const { tree: knot, steps: { bowline } } = committed(await a.runner.runAct(new CreateRoadmap('Learn to knot', {
    steps: [{ key: 'bowline', label: 'Tie a bowline' }], links: [] })));
  for (const scope of [RoadmapScopes.tree(knot), RoadmapScopes.overlay(knot)]) a.observe(scope);
  await a.sync();
  a.world.now += 60_000;
  a.env.timers.time = a.world.now;
  const { tree: sail } = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail')));
  const practice = committed(await a.runner.runAct(new CreateKind(sail, { hue: 'sky', label: 'Practice', description: 'Time on the water' })));
  committed(await a.runner.runAct(new CreateStep(sail, { label: 'Choose a course', links: [{ url: 'https://example.com/syllabus', label: 'Syllabus' }] }, [], 'course')));
  committed(await a.runner.runAct(new CreateStep(sail, { label: 'Tie the knots', color: 'sky', description: 'Bowline, cleat hitch.' }, ['course'], 'knots')));
  committed(await a.runner.runAct(new CreateStep(sail, { label: 'Read the wind', color: 'olive', description: 'Watch the flags.\nFeel the gusts.' }, ['course'], 'wind')));
  committed(await a.runner.runAct(new CreateStep(sail, { label: 'Leave the dock', color: 'sky' }, ['wind'], 'dock')));
  committed(await a.runner.runAct(new CreateStep(sail, { label: 'Sail solo', color: 'gold' }, ['dock', 'wind'], 'solo')));
  committed(await a.runner.runAct(new WriteRoadmap(sail, { guide: 'One step a week, on weekend sails.\n\n- Ask before changing a completed step.' })));
  committed(await a.runner.runAct(Complete(sail, 'course')));
  committed(await a.runner.runAct(Complete(sail, 'knots')));
  committed(await a.runner.runAct(AddSubtask(sail, 'wind', 'Download a forecast app')));
  committed(await a.runner.runAct(AddStepLink(sail, 'wind', { url: 'https://example.com/forecast', title: 'Forecast' })));
  const { subtree } = committed(await a.runner.runAct(new CreateSubtree(sail, 'dock')));
  committed(await a.runner.runAct(new CreateStep(subtree, { label: 'Cast off the lines' }, [], 'cast')));
  committed(await a.runner.runAct(new CreateStep(subtree, { label: 'Coil the ropes' }, ['cast'], 'coil')));
  committed(await a.runner.runAct(Complete(subtree, 'cast')));
  for (const tree of [sail, subtree]) for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) a.observe(scope);
  await a.sync();
  const session = { getSnapshot: () => ({ engine: a.engine, ready: true, online: true, error: false }), subscribe: () => () => {} };

  // Today's server answers for the same roadmaps, as its routes send them: a document's steps in id order, each step's
  // prerequisites in the order of the ids they come from, a subtree named by its owning step, and the owner's marks.
  const genesis = [
    { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
    { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
    { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
  ];
  const marked = (...steps) => ({ marks: steps.map((node, index) => ({ node, status: 'complete', at: `1800000060000:${index}:r_000000000002`, markedAt: 1_800_000_060_000 })) });
  const answers = {
    '/v1/me': { user: { id: 'A' } },
    '/v1/trees': { trees: [{ id: sail, title: 'Learn to sail', updatedAt: 1_800_000_060_000 }, { id: knot, title: 'Learn to knot', updatedAt: 1_800_000_000_000 }] },
    [`/v1/trees/${knot}`]: { data: { id: knot, title: 'Learn to knot', guide: '', kinds: genesis, nodes: [
      { id: bowline, label: 'Tie a bowline', color: 'terracotta', prerequisites: [] },
    ] }, root: knot, parent: null, path: [], depth: 0, mine: true, visibility: 'private' },
    [`/v1/trees/${knot}/progress`]: { marks: [] },
    [`/v1/trees/${sail}`]: { data: { id: sail, title: 'Learn to sail', guide: 'One step a week, on weekend sails.\n\n- Ask before changing a completed step.',
      kinds: [...genesis, { id: practice, hue: 'sky', label: 'Practice', description: 'Time on the water' }], nodes: [
        { id: 'course', label: 'Choose a course', color: 'terracotta', prerequisites: [], links: [{ url: 'https://example.com/syllabus', label: 'Syllabus' }] },
        { id: 'dock', label: 'Leave the dock', color: 'sky', prerequisites: ['wind'], subtree: { id: subtree, done: 1, total: 2, state: 'open' } },
        { id: 'knots', label: 'Tie the knots', color: 'sky', prerequisites: ['course'], description: 'Bowline, cleat hitch.' },
        { id: 'solo', label: 'Sail solo', color: 'gold', prerequisites: ['dock', 'wind'] },
        { id: 'wind', label: 'Read the wind', color: 'olive', prerequisites: ['course'], description: 'Watch the flags.\nFeel the gusts.' },
      ] }, root: sail, parent: null, path: [], depth: 0, mine: true, visibility: 'private' },
    [`/v1/trees/${sail}/progress`]: marked('course', 'knots'),
    [`/v1/trees/${subtree}`]: { data: { id: subtree, title: 'Leave the dock', guide: '', kinds: genesis, nodes: [
      { id: 'cast', label: 'Cast off the lines', color: 'terracotta', prerequisites: [] },
      { id: 'coil', label: 'Coil the ropes', color: 'terracotta', prerequisites: ['cast'] },
    ] }, root: sail, parent: { tree: sail, step: 'dock' }, path: [{ tree: sail, step: 'dock', title: 'Learn to sail' }], depth: 1, mine: true, visibility: 'private' },
    [`/v1/trees/${subtree}/progress`]: marked('cast'),
    [`/v1/trees/${sail}/activity`]: { events: [] },
    [`/v1/trees/${subtree}/activity`]: { events: [] },
  };
  const realFetch = globalThis.fetch;
  const rows = new Map();
  globalThis.fetch = async (url) => {
    const answer = answers[new URL(url).pathname];
    assert.ok(answer, 'today’s export asks only what its routes answer');
    return { ok: true, status: 200, json: async () => structuredClone(answer) };
  };
  globalThis.window = { localStorage: { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value), removeItem: (key) => rows.delete(key) } };
  t.after(() => {
    globalThis.fetch = realFetch;
    delete globalThis.window;
  });

  const settings = { today: [], replica: [] };
  assert.deepEqual(await buildExportArchive(readAccountRoadmaps, (zip) => settings.today.push(zip)), { count: 2, total: 2 });
  assert.deepEqual(await buildExportArchive(() => readReplicaRoadmaps({ session, timers: a.env.timers }), (zip) => settings.replica.push(zip)), { count: 2, total: 2 });
  const [today, replica] = [filesIn(settings.today[0]), filesIn(settings.replica[0])];
  assert.deepEqual(replica.map(fieldsOf), today.map(fieldsOf));
  assert.deepEqual(today, [
    { name: `learn-to-sail-${sail.slice(2, 10)}.md`, text: [
      '# Learn to sail', '<!-- windmill:roadmap -->',
      '<!-- windmill:guide -->', '> One step a week, on weekend sails.', '>', '> - Ask before changing a completed step.', '<!-- /windmill:guide -->',
      '- [x] Choose a course <!-- windmill:kind terracotta Build -->', '  https://example.com/syllabus',
      '  - [x] Tie the knots <!-- windmill:kind sky Practice -->', '    Bowline, cleat hitch.',
      '  - Read the wind <!-- windmill:kind olive Learn -->', '    Watch the flags.', '    Feel the gusts.',
      '    - Leave the dock <!-- windmill:kind sky Practice -->',
      '      - Sail solo <!-- windmill:kind gold Milestone -->', '        needs also: Read the wind',
    ].join('\n') },
    { name: `learn-to-knot-${knot.slice(2, 10)}.md`, text: '# Learn to knot\n<!-- windmill:roadmap -->\n- Tie a bowline <!-- windmill:kind terracotta Build -->' },
  ]);
  assert.deepEqual(replica, today);
  assert.deepEqual(settings.replica[0], settings.today[0], 'the two archives are the same bytes');

  // The row exports the room's own picture: today's reading's, and the reading of the device's copy where the switch is on.
  const verbs = await closuresIn('room/useRowVerbs.js');
  const exportFromRow = ({ seed, overlay }) => {
    const files = [];
    verbs.callback('exportFromRow', { phone: false, projectionRef: { current: seed }, boardTree: new SkillTree(seed), completed: overlay.completed,
      buildRoadmapExport, downloadExport: (file) => files.push(file), reportRoadmapFailure: (operation) => assert.fail(operation), track: () => {} })();
    return files;
  };
  for (const treeId of [sail, subtree]) {
    const lattice = new LatticeReading({ treeId, demo: false, shared: false, demotion: false, known: { current: new Map() }, room: null });
    const fromToday = exportFromRow(await lattice.read({ signal: new AbortController().signal }));
    lattice.close();
    const reading = new ReplicaReading({ treeId, timers: a.env.timers, session,
      repository: { loadProgress: async () => assert.fail('an owner reads their own marks'), loadActivity: async () => [] } });
    const fromReplica = exportFromRow(await reading.read({ signal: new AbortController().signal }));
    reading.close();
    assert.deepEqual(fromReplica.map(fieldsOf), fromToday.map(fieldsOf));
    assert.deepEqual(fromReplica, fromToday);
    if (treeId === sail) assert.deepEqual(fromToday, today.slice(0, 1), 'the row and Settings export the roadmap alike');
    else assert.deepEqual(fromToday, [{ name: `leave-the-dock-${subtree.slice(2, 10)}.md`,
      text: '# Leave the dock\n<!-- windmill:roadmap -->\n- [x] Cast off the lines <!-- windmill:kind terracotta Build -->\n  - Coil the ropes' }]);
  }
});

test('with no connection, Settings’ export reads every roadmap the device’s copy holds, and one the device has not read stays out', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree: knot } = committed(await a.runner.runAct(new CreateRoadmap('Learn to knot', { steps: [{ key: 'bowline', label: 'Tie a bowline' }], links: [] })));
    for (const scope of [RoadmapScopes.tree(knot), RoadmapScopes.overlay(knot)]) a.observe(scope);
    await a.sync();
    const b = await a.device();
    committed(await b.runner.runAct(new CreateRoadmap('Learn to row', { steps: [{ key: 'grip', label: 'Grip the oars' }], links: [] })));
    while (await b.senderStep());
    while (await a.pullerStep());
    a.engine.setOnline(false);
    const zips = [];
    const session = { getSnapshot: () => ({ engine: a.engine, ready: true, online: false, error: false }), subscribe: () => () => {} };
    assert.deepEqual(await buildExportArchive(() => readReplicaRoadmaps({ session, timers: a.env.timers }), (zip) => zips.push(zip)), { count: 1, total: 2 });
    assert.deepEqual(filesIn(zips[0]), [
      { name: `learn-to-knot-${knot.slice(2, 10)}.md`, text: '# Learn to knot\n<!-- windmill:roadmap -->\n- Tie a bowline <!-- windmill:kind terracotta Build -->' },
    ]);
  } finally {
    a.close();
  }
});

test('Settings’ export of the device’s copy says nothing where the copy does not open, rather than an empty list', async () => {
  const session = { getSnapshot: () => ({ engine: null, ready: false, online: true, error: true }), subscribe: () => () => {} };
  assert.equal(await buildExportArchive(() => readReplicaRoadmaps({ session }), () => assert.fail('nothing downloads')), null);
});

// What the device's copy holds otherwise than today's server does, read as the room reads it: steps in the roadmap's own
// order (§4 Order) where the server listed them by id, a step that followed a step deleted elsewhere following what that
// step followed (D-5) where the server lost its link, and completion from the owner's marks alone (§5 Complete and Reset)
// where the server fell back to a step's seed status.
test('where the device’s copy reads a roadmap otherwise than today’s server, the export says what the room shows', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree: row } = committed(await a.runner.runAct(new CreateRoadmap('Learn to row')));
    committed(await a.runner.runAct(new CreateStep(row, { label: 'Find the stroke' }, [], 'stroke')));
    committed(await a.runner.runAct(new CreateStep(row, { label: 'Grip the oars' }, [], 'grip')));
    committed(await a.runner.runAct(new CreateStep(row, { label: 'Feather the oars' }, ['grip'], 'feather')));
    committed(await a.runner.runAct(new CreateStep(row, { label: 'Turn the boat' }, ['feather'], 'turn')));
    committed(await a.runner.runAct(new DeleteStep(row, 'feather')));
    for (const scope of [RoadmapScopes.tree(row), RoadmapScopes.overlay(row)]) a.observe(scope);
    await a.advance(CONSTANTS.HOLD_MS);
    await a.sync();
    const snapshot = (scope) => a.engine.observe(scope).getSnapshot();
    const seeded = snapshot(RoadmapScopes.tree(row)).drawn.map((record) => (record.t === RoadmapStep.type && record.id === 'stroke'
      ? { ...record, f: { ...record.f, status: ['complete', record.f.label[1]] } } : record));
    const listed = snapshot(RoadmapScopes.account).drawn.find((record) => record.id === row);
    const held = new ReplicaRoadmap(roadmapRegistry, row, [new HeldRoadmap({ id: row, record: listed, tree: seeded, overlay: snapshot(RoadmapScopes.overlay(row)).drawn })]);
    const today = buildRoadmapExport({ id: row, title: 'Learn to row', guide: '', kinds: [{ id: 'build', hue: 'terracotta', label: 'Build' }], nodes: [
      { id: 'grip', label: 'Grip the oars', color: 'terracotta', prerequisites: [] },
      { id: 'stroke', label: 'Find the stroke', color: 'terracotta', prerequisites: [], status: 'complete' },
      { id: 'turn', label: 'Turn the boat', color: 'terracotta', prerequisites: [] },
    ] }, { completed: new Set(['stroke']) });
    assert.deepEqual({ today: today.text, replica: buildRoadmapExport(held.seedOf(row), held.marksOf(row)).text }, {
      today: '# Learn to row\n<!-- windmill:roadmap -->\n- Grip the oars <!-- windmill:kind terracotta Build -->\n- [x] Find the stroke\n- Turn the boat',
      replica: '# Learn to row\n<!-- windmill:roadmap -->\n- Find the stroke <!-- windmill:kind terracotta Build -->\n- Grip the oars\n  - Turn the boat',
    });
  } finally {
    a.close();
  }
});

test('Settings’ export tells a copy that did not open in time apart from one that read nothing, and from one that read part of the list', async () => {
  const { exportOutcome } = await import('../../../../src/products/roadmap/settings/exportArchive.js');
  assert.deepEqual([null, { count: 0, total: 0 }, { count: 0, total: 2 }, { count: 1, total: 2 }, { count: 2, total: 2 }].map(exportOutcome),
    ['unopened', 'done', 'failed', 'partial', 'done']);
});
