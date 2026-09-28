// D-4 scopes and access: a wire reference maps to a server key for the principal, and read and write
// access follow the key's kind; a tree opens through the registry's `opens` field (§2.4).

export function scopeKeyOf(registry, ref, account) {
  const kind = registry.scopeKindOf(ref);
  if (kind === null || kind === 'device') return null;
  const parts = ref.split('/');
  if (kind === 'tree') return { key: `tree:${parts[1]}`, kind: 'tree', tree: parts[1] };
  if (account === null || account === undefined) return null;
  if (kind === 'overlay') return { key: `acct:${account}/overlay/${parts[2]}`, kind: 'overlay', tree: parts[2], owner: account };
  return { key: `acct:${account}/${parts[1]}`, kind: 'product', product: parts[1], owner: account };
}

function treeIsOpen(registry, state, treeKey) {
  const opening = registry.opening;
  if (opening === null) return false;
  return opening.values.includes(state.row(treeKey, opening.type, opening.id)?.f?.[opening.field]?.[0]);
}

// The access answer for one principal (null when signed out) on one scope: which refusal a write
// meets, which answer a read meets, and whether an absent scope is created by the write. An overlay
// answers as its tree does.
export function accessOf(registry, state, target, account) {
  if (target.kind === 'product') {
    const scope = state.scope(target.key);
    return { read: true, write: true, create: scope === undefined };
  }
  const treeKey = `tree:${target.tree}`;
  const tree = state.scope(treeKey);
  if (tree === undefined) return { refusal: 'not-found', read: false };
  const owner = tree.owner === account;
  if (tree.state === 'dead') return { refusal: owner ? 'scope-dead' : 'not-found', read: false, gone: owner };
  const readable = owner || treeIsOpen(registry, state, treeKey);
  if (!readable) return { refusal: 'not-found', read: false };
  if (target.kind === 'tree') return owner ? { read: true, write: true } : { read: true, write: false, refusal: 'forbidden' };
  return { read: true, write: true, create: state.scope(target.key) === undefined };
}
