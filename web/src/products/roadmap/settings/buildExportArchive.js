// The "Your data" export (X6 §5 · settings §04): every roadmap this account can reach,
// each written in F3's plan grammar, zipped, and handed to the browser as a download. The
// export format IS the paste format — a file dropped back into the composer replants — so
// this is serializePlan (the inverse of parsePlan) run once per tree, best-effort for the
// grammar-expressible structure.
//
// An ordered pipeline: list every tree, materialise each one's TreeData + progress from
// wherever it lives (a server tree loads through its repository, a device tree replays its
// local lattice), serialise, then store the whole set as one zip and trigger the download.

import { listAllTrees } from '../persistence/TreeRegistry.js';
import { HttpTreeRepository } from '../persistence/HttpTreeRepository.js';
import { ProgressStore } from '../persistence/ProgressStore.js';
import { SyncStore } from '../sync/SyncStore.js';
import { TreeLattice } from '../sync/lattice.js';
import { serializePlan } from '../paste/planGrammar.js';
import { storeZip } from '../paste/storeZip.js';

export async function buildExportArchive() {
  const trees = await listAllTrees();
  const files = [];
  for (const tree of trees) {
    const loaded = tree.origin === 'server' ? await loadServerTree(tree.id) : await loadDeviceTree(tree.id);
    if (!loaded) continue;
    const markdown = serializePlan(loaded.treeData, loaded.treeData.kinds, loaded.progress);
    files.push({ name: fileNameFor(loaded.treeData, tree.id), text: markdown });
  }

  const bytes = storeZip(files);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'windmill-export.zip';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  return { count: files.length };
}

// A server tree materialises through its repository: the authored document, then this
// user's progress overlay (which already falls back to the document's seed statuses).
async function loadServerTree(treeId) {
  const repository = new HttpTreeRepository({ treeId });
  const treeData = await repository.loadTree().catch(() => null);
  if (!treeData) return null;
  const overlay = await repository.loadProgress(treeData);
  return { treeData, progress: { completed: overlay.completed, inProgress: overlay.inProgress } };
}

// A device tree materialises by replaying its local lattice blob into the same TreeData
// projection every render path consumes; its progress lives in the local ProgressStore,
// falling back to the document's own seed statuses when this device never marked a step.
async function loadDeviceTree(treeId) {
  const saved = await new SyncStore().load(treeId).catch(() => null);
  if (!saved?.frame) return null;
  const lattice = new TreeLattice(treeId);
  lattice.join(saved.frame);
  const treeData = lattice.toTreeData();
  const overlay = new ProgressStore().load(treeId);
  return { treeData, progress: progressFrom(treeData, overlay) };
}

function progressFrom(treeData, overlay) {
  if (overlay) return { completed: new Set(overlay.completed ?? []), inProgress: new Set(overlay.inProgress ?? []) };
  return {
    completed: new Set(treeData.nodes.filter((node) => node.status === 'complete').map((node) => node.id)),
    inProgress: new Set(treeData.nodes.filter((node) => node.status === 'active').map((node) => node.id)),
  };
}

// One .md per tree: a slug of the title, disambiguated by a short slice of the tree id so
// two trees sharing a title never collide in the archive.
function fileNameFor(treeData, treeId) {
  const slug = String(treeData.title ?? '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'roadmap';
  const short = treeId.replace(/^t_/, '').slice(0, 8);
  return `${slug}-${short}.md`;
}
