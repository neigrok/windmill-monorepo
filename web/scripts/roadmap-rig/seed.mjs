// Seeds a local copy of the dogfood tree, owned by the rig's browser user, from the repo fixture
// (test/products/roadmap/fixtures/dogfood-tree.json) or a raw MCP get_tree reply given as --snapshot.
//   node seed.mjs --backend http://localhost:8088 --cookie <wm_session> [--tree t_...] [--snapshot path]
// The cookie may also come from WM_RIG_COOKIE; it never lives in the repo.
// Structure + legend: POST /v1/trees with the client-supplied id (byte-exact document seed).
// Progress: MCP set_progress in bulk (the backend must run with WINDMILL_MCP_USER = the cookie's user).
// Then re-reads the copy over HTTP and compares node / edge / progress counts with the snapshot.
import fs from 'node:fs';
import path from 'node:path';

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
const snapshot = { tree: raw.tree ?? raw, edges: raw.edges };
const treeId = args.tree ?? snapshot.tree.id;
const mcpToken = args.mcpToken ?? 'devtoken';

const headers = { 'content-type': 'application/json', Cookie: `wm_session=${cookie}`, Origin: 'http://localhost:5173' };

function documentOf(tree) {
  const nodes = tree.nodes.map((n) => {
    const node = { id: n.id, label: n.label, color: n.color, prerequisites: n.prerequisites ?? [] };
    if (n.icon) node.icon = n.icon;
    if (n.order) node.order = n.order;
    if (n.description) node.description = n.description;
    if (n.links?.length) node.links = n.links;
    if (n.position) node.position = n.position;
    // `status`, `state`, `kind`, `outOfOrder` are the caller's own marks / derived views, not document fields.
    return node;
  });
  const kinds = (tree.kinds ?? []).map((k) => ({
    id: k.id, hue: k.hue, label: k.label ?? '', description: k.description ?? '', crossBranchExempt: !!k.crossBranchExempt,
  }));
  return { id: treeId, title: tree.title, nodes, kinds };
}

async function mcp(method, params, sid) {
  const res = await fetch(`${backend}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${mcpToken}`, ...(sid ? { 'Mcp-Session-Id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, sid: res.headers.get('mcp-session-id'), body: text.startsWith('{') ? JSON.parse(text) : text };
}

const doc = documentOf(snapshot.tree);
const expected = {
  nodes: snapshot.tree.nodes.length,
  edges: snapshot.tree.nodes.reduce((s, n) => s + (n.prerequisites?.length ?? 0), 0),
  complete: snapshot.tree.nodes.filter((n) => n.status === 'complete').length,
  none: snapshot.tree.nodes.filter((n) => n.status !== 'complete').length,
  outOfOrder: snapshot.tree.nodes.filter((n) => n.status === 'complete' && n.outOfOrder).length,
  kinds: (snapshot.tree.kinds ?? []).length,
};
console.log('snapshot', expected, 'edges list length', snapshot.edges?.length);

const created = await fetch(`${backend}/v1/trees`, { method: 'POST', headers, body: JSON.stringify(doc) });
console.log('POST /v1/trees', created.status, await created.text());
if (created.status !== 200) process.exit(1);

const init = await mcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rig-seed', version: '0' } });
if (!init.sid) { console.error('mcp initialize failed', init); process.exit(1); }
const updates = snapshot.tree.nodes.map((node) => {
  const status = node.status === 'complete' ? 'complete' : 'none';
  return { nodeId: node.id, status, ...(status === 'complete' && node.outOfOrder ? { outOfOrder: true } : {}) };
});
const progress = await mcp('tools/call', { name: 'set_progress', arguments: { treeId, updates } }, init.sid);
const receipt = progress.body?.result?.structuredContent ?? progress.body?.result ?? progress.body;
const receiptText = JSON.stringify(receipt);
console.log('set_progress', progress.status, receiptText.length > 600 ? receiptText.slice(0, 600) + '…' : receiptText);

const readBack = await (await fetch(`${backend}/v1/trees/${treeId}`, { headers })).json();
// GET /v1/trees/:id answers { data: the projection {id,title,nodes,kinds}, state: the lattice frame
// (nodes/edges/kinds with stamps; a live edge has removedAt "0:0:"), mine, visibility, seq }.
const readNodes = readBack.data?.nodes ?? [];
const readEdges = (readBack.state?.edges ?? []).filter((e) => !e.removedAt || e.removedAt === '0:0:');
// GET /v1/trees/:id/progress answers { marks: [{node, status, at, markedAt, outOfOrder?}] }.
const readProgress = await (await fetch(`${backend}/v1/trees/${treeId}/progress`, { headers })).json();
const marks = readProgress.marks ?? [];
const actual = {
  nodes: readNodes.length,
  edges: readEdges.length,
  complete: marks.filter((m) => m.status === 'complete').length,
  none: marks.filter((m) => m.status === 'none').length,
  outOfOrder: marks.filter((m) => m.outOfOrder).length,
  kinds: (readBack.data?.kinds ?? []).length,
};
console.log('read back keys', Object.keys(readBack), 'progress keys', Object.keys(readProgress), 'first node createdAt', readBack.state?.nodes?.[0]?.createdAt);
console.log('local copy', actual);
const mismatches = Object.keys(expected).filter((k) => expected[k] !== actual[k]);
if (mismatches.length) { console.error('MISMATCH on', mismatches); process.exit(2); }
console.log(`OK — local ${treeId} matches the snapshot on nodes/edges/complete/none/outOfOrder/kinds`);
