// Seeds a local copy of the dogfood tree, owned by the rig's browser user, from the repo fixture
// (test/products/roadmap/fixtures/dogfood-tree.json) or a raw MCP get_tree reply given as --snapshot, and prints its id.
//   node seed.mjs --backend http://localhost:8088 --cookie <wm_session> [--snapshot path] [--mcpToken devtoken]
// The cookie may also come from WM_RIG_COOKIE; it never lives in the repo. The roadmap is planted through MCP
// (planter.mjs), so the backend must run with WINDMILL_MCP_USER = the cookie's user. Then the copy is read back, its
// steps, links and legend through MCP get_tree and its marks through GET /v1/trees/{id}/progress as the cookie's user, and
// compared with the snapshot by counts.
import fs from 'node:fs';
import path from 'node:path';
import { RoadmapPlanter } from './planter.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const here = path.dirname(new URL(import.meta.url).pathname);
const backend = args.backend ?? 'http://localhost:8088';
const cookie = args.cookie ?? process.env.WM_RIG_COOKIE;
if (!cookie) { console.error('--cookie <wm_session> or WM_RIG_COOKIE is required'); process.exit(2); }
const snapshotPath = args.snapshot ?? path.join(here, '..', '..', 'test', 'products', 'roadmap', 'fixtures', 'dogfood-tree.json');
const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
// A raw get_tree reply wraps the tree; the fixture is the tree itself.
const snapshot = raw.tree ?? raw;
const expected = {
  nodes: snapshot.nodes.length,
  edges: snapshot.nodes.reduce((sum, node) => sum + (node.prerequisites?.length ?? 0), 0),
  complete: snapshot.nodes.filter((node) => node.status === 'complete').length,
  outOfOrder: snapshot.nodes.filter((node) => node.status === 'complete' && node.outOfOrder).length,
  kinds: (snapshot.kinds ?? []).length,
};
console.log('snapshot', expected);

const planter = await RoadmapPlanter.connect({ api: backend, token: args.mcpToken ?? 'devtoken', client: 'rig-seed' });
const treeId = await planter.plant(snapshot);
console.log(`planted ${treeId}`);

const nodes = [];
let kinds = [];
for (let cursor = null; ;) {
  const page = await planter.call('roadmap_get_tree', { treeId, fields: ['id', 'prerequisites'], limit: 1000, ...(cursor && { cursor }) });
  nodes.push(...page.tree.nodes);
  kinds = page.tree.kinds;
  if (!page.nextCursor) break;
  cursor = page.nextCursor;
}
// GET /v1/trees/{id}/progress answers { marks: [{node, status, at, markedAt, outOfOrder?}] }.
const progress = await fetch(`${backend}/v1/trees/${treeId}/progress`, { headers: { Cookie: `wm_session=${cookie}` } });
if (!progress.ok) { console.error(`GET /v1/trees/{id}/progress answered ${progress.status}`); process.exit(1); }
const { marks = [] } = await progress.json();
const actual = {
  nodes: nodes.length,
  edges: nodes.reduce((sum, node) => sum + (node.prerequisites?.length ?? 0), 0),
  complete: marks.filter((mark) => mark.status === 'complete').length,
  outOfOrder: marks.filter((mark) => mark.status === 'complete' && mark.outOfOrder).length,
  kinds: kinds.length,
};
console.log('local copy', actual);
const mismatches = Object.keys(expected).filter((key) => expected[key] !== actual[key]);
if (mismatches.length) { console.error('MISMATCH on', mismatches); process.exit(2); }
console.log(`OK — local ${treeId} matches the snapshot on nodes/edges/complete/outOfOrder/kinds`);
