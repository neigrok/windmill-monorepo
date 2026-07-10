// Local persistence for edits (editing-spec: Save & load). The authored roadmap
// stays the source of truth; this only overlays a user's in-app edits on top of
// it between reloads. Each saved entry is stamped with a signature of the seed it
// was edited from — when the authored seed changes (someone edits roadmapTree.js),
// the signature no longer matches and the stale edits are dropped, so code always
// wins over a browser's leftover state. No versioning, no migration: it's a cache
// of edits, not a database.

const KEY_PREFIX = 'windmill:tree:';

export class TreeStore {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  // The persisted edits for this seed, or null if there are none or the seed has
  // since changed underneath them.
  load(seed) {
    let entry;
    try {
      const text = this.storage.getItem(KEY_PREFIX + seed.id);
      entry = text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
    if (!entry || entry.signature !== signature(seed)) return null;
    return entry.treeData;
  }

  save(seed, treeData) {
    try {
      this.storage.setItem(KEY_PREFIX + seed.id, JSON.stringify({ signature: signature(seed), treeData }));
    } catch {
      // storage full or unavailable — persistence is best-effort, never fatal
    }
  }

  clear(seedId) {
    try {
      this.storage.removeItem(KEY_PREFIX + seedId);
    } catch {
      // ignore
    }
  }
}

// A fingerprint of the seed's authored shape — every field the author controls,
// but not layout positions (those are derived) or a user's later edits.
function signature(seed) {
  const shape = seed.nodes
    .map((node) => [node.id, node.label ?? '', node.icon ?? '', node.color ?? '', node.status ?? '', [...node.prerequisites].sort().join('>')].join('|'))
    .join(';');
  let hash = 2166136261;
  for (let i = 0; i < shape.length; i++) {
    hash ^= shape.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
