// The export format IS the paste format: a file dropped back into the composer replants the tree's steps; its guide rides
// along as a quote the replant reads past.

import { listAllTrees } from '../persistence/TreeRegistry.js';
import { HttpTreeRepository } from '../persistence/HttpTreeRepository.js';
import { ProgressLattice } from '../sync/progressLattice.js';
import { SyncStore } from '../sync/SyncStore.js';
import { TreeLattice } from '../sync/lattice.js';
import { serializePlan } from '../paste/planGrammar.js';
import { reportInvalidProgressMark, reportRoadmapFailure } from '../reportFailure.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01 — the ZIP epoch, so archives are byte-for-byte deterministic
const UTF8_FLAG = 0x0800;
const VERSION = 20; // 2.0 — the floor for store + UTF-8 names
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

// One roadmap's file: its title and guide, every step with its own mark, in the paste format.
export function buildRoadmapExport(treeData, progress) {
  return {
    name: fileNameFor(treeData),
    text: serializePlan(treeData, treeData.kinds, progress),
  };
}

// One .md per tree: a slug of the title, disambiguated by a short slice of the tree id.
function fileNameFor({ id, title }) {
  const slug = String(title ?? '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'roadmap';
  const short = id.replace(/^t_/, '').slice(0, 8);
  return `${slug}-${short}.md`;
}

export function downloadExport({ name, text, bytes, type = 'text/markdown;charset=utf-8' }) {
  const anchor = document.createElement('a');
  const url = URL.createObjectURL(new Blob([bytes ?? text], { type }));
  try {
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

export function reportExportFailure(operation, error, tags) {
  reportRoadmapFailure(operation, error, tags, '#/settings');
}

// The zip of every roadmap of the person's list that `readRoadmaps` could read, handed to `download`: how many files it
// holds, and how many roadmaps the list holds. Nothing to put in it downloads nothing; null where the list could not be read.
export async function buildExportArchive(readRoadmaps, download = downloadExport) {
  const roadmaps = await readRoadmaps();
  if (roadmaps === null) return null;
  const files = roadmaps.flatMap((roadmap) => (roadmap ? [buildRoadmapExport(roadmap.treeData, roadmap.progress)] : []));
  if (files.length > 0) download({ name: 'windmill-export.zip', bytes: storeZip(files), type: 'application/zip' });
  return { count: files.length, total: roadmaps.length };
}

// What Settings' Export all came to, as `roadmap_export` tells it: `unopened` where the device's copy did not open in time
// (`archive` null), `done` where it holds every roadmap of the list, none among them, `failed` where it holds none of
// several, and `partial` otherwise.
export function exportOutcome(archive) {
  if (archive === null) return 'unopened';
  if (archive.count === archive.total) return 'done';
  return archive.count === 0 ? 'failed' : 'partial';
}

// The person's roadmaps as the device's copy holds them (roadmap-on-the-engine.md §8.4), each read through the domain as
// the room reads it, and with no connection what the device holds: null for one the device has not read, or whose read
// threw. Null where the copy did not open. `collaborators` are what the reading is given (the engine's holder, timers).
export async function readReplicaRoadmaps(collaborators = {}) {
  const { ReplicaReading } = await import('../room/ReplicaReading.js');
  const reading = new ReplicaReading({ ...collaborators, treeId: null });
  try {
    const roadmaps = await reading.readEveryRoadmap({ signal: new AbortController().signal });
    if (!roadmaps) return null;
    return roadmaps.account.list().map(({ id }) => {
      try {
        const treeData = roadmaps.seedOf(id);
        return treeData && { treeData, progress: roadmaps.marksOf(id) };
      } catch (error) {
        reportExportFailure('roadmap-export-load', error);
        return null;
      }
    });
  } finally {
    reading.close();
  }
}

// The person's roadmaps as roadmap's own sync keeps them, which retires at the move (§8.4): the server's list and this
// device's own, each read from the server or the device's store, null where it could not be.
export async function readAccountRoadmaps() {
  const roadmaps = [];
  for (const tree of await listAllTrees()) roadmaps.push(await loadForExport(tree));
  return roadmaps;
}

async function loadForExport(tree) {
  try {
    return await (tree.origin === 'server' ? loadServerTree(tree.id) : loadDeviceTree(tree.id));
  } catch (error) {
    reportExportFailure('roadmap-export-load', error);
    return null;
  }
}

// Failed progress requests keep the tree out of the export; invalid rows report and leave its valid marks intact.
async function loadServerTree(treeId) {
  const repository = new HttpTreeRepository({
    treeId,
    operation: 'roadmap-export-load',
    reportFailure: reportExportFailure,
  });
  const treeData = await repository.loadTree().catch(() => null);
  if (!treeData) return null;
  const overlay = await repository.loadProgress(treeData);
  return { treeData, progress: { completed: overlay.completed } };
}

// One local record holds both lanes: the structure and this account's marks.
async function loadDeviceTree(treeId) {
  const saved = await new SyncStore().load(treeId).catch(() => null);
  if (!saved?.frame) return null;
  const lattice = new TreeLattice(treeId);
  lattice.join(saved.frame);
  const treeData = lattice.toTreeData();
  const progress = new ProgressLattice();
  if (saved.progress) progress.join(saved.progress, () => reportInvalidProgressMark(reportExportFailure));
  return { treeData, progress: progressFrom(treeData, progress.marks.size ? progress.overlay() : null) };
}

function progressFrom(treeData, overlay) {
  if (overlay) return { completed: new Set(overlay.completed ?? []) };
  return {
    completed: new Set(treeData.nodes.filter((node) => node.status === 'complete').map((node) => node.id)),
  };
}

// A store-only (method 0, no compression) ZIP writer emitting raw bytes: local file headers, a
// central directory and an end-of-central-directory record, all little-endian.
export function storeZip(files) {
  const encoder = new TextEncoder();
  const entries = files.map((file) => {
    const data = encoder.encode(file.text ?? '');
    return { name: encoder.encode(file.name), data, crc: crc32(data), offset: 0 };
  });

  const localBytes = entries.reduce((sum, entry) => sum + LOCAL_HEADER + entry.name.length + entry.data.length, 0);
  const centralBytes = entries.reduce((sum, entry) => sum + CENTRAL_HEADER + entry.name.length, 0);
  const out = new Uint8Array(localBytes + centralBytes + END_RECORD);
  const view = new DataView(out.buffer);

  let at = 0;
  for (const entry of entries) {
    entry.offset = at;
    at = writeLocalHeader(view, out, at, entry);
  }
  const centralStart = at;
  for (const entry of entries) at = writeCentralHeader(view, out, at, entry);
  writeEndRecord(view, at, entries.length, centralBytes, centralStart);

  return out;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeLocalHeader(view, out, at, entry) {
  view.setUint32(at, 0x04034b50, true); // "PK\3\4"
  view.setUint16(at + 4, VERSION, true);
  view.setUint16(at + 6, UTF8_FLAG, true);
  view.setUint16(at + 8, 0, true); // method: store
  view.setUint16(at + 10, DOS_TIME, true);
  view.setUint16(at + 12, DOS_DATE, true);
  view.setUint32(at + 14, entry.crc, true);
  view.setUint32(at + 18, entry.data.length, true); // compressed size == raw size
  view.setUint32(at + 22, entry.data.length, true);
  view.setUint16(at + 26, entry.name.length, true);
  view.setUint16(at + 28, 0, true); // extra field length
  out.set(entry.name, at + LOCAL_HEADER);
  out.set(entry.data, at + LOCAL_HEADER + entry.name.length);
  return at + LOCAL_HEADER + entry.name.length + entry.data.length;
}

function writeCentralHeader(view, out, at, entry) {
  view.setUint32(at, 0x02014b50, true); // "PK\1\2"
  view.setUint16(at + 4, VERSION, true); // version made by
  view.setUint16(at + 6, VERSION, true); // version needed
  view.setUint16(at + 8, UTF8_FLAG, true);
  view.setUint16(at + 10, 0, true); // method: store
  view.setUint16(at + 12, DOS_TIME, true);
  view.setUint16(at + 14, DOS_DATE, true);
  view.setUint32(at + 16, entry.crc, true);
  view.setUint32(at + 20, entry.data.length, true);
  view.setUint32(at + 24, entry.data.length, true);
  view.setUint16(at + 28, entry.name.length, true);
  view.setUint16(at + 30, 0, true); // extra field length
  view.setUint16(at + 32, 0, true); // comment length
  view.setUint16(at + 34, 0, true); // disk number start
  view.setUint16(at + 36, 0, true); // internal attributes
  view.setUint32(at + 38, 0, true); // external attributes
  view.setUint32(at + 42, entry.offset, true); // offset of the local header
  out.set(entry.name, at + CENTRAL_HEADER);
  return at + CENTRAL_HEADER + entry.name.length;
}

function writeEndRecord(view, at, count, centralBytes, centralStart) {
  view.setUint32(at, 0x06054b50, true); // "PK\5\6"
  view.setUint16(at + 4, 0, true); // this disk number
  view.setUint16(at + 6, 0, true); // disk with the central directory
  view.setUint16(at + 8, count, true); // central records on this disk
  view.setUint16(at + 10, count, true); // total central records
  view.setUint32(at + 12, centralBytes, true);
  view.setUint32(at + 16, centralStart, true);
  view.setUint16(at + 20, 0, true); // archive comment length
}
