// Pure TreeData → TreeData edit transforms. Each returns a new TreeData with
// structural sharing — only the touched nodes are replaced, unchanged ones are
// reused — so TreeEditor's history snapshots stay cheap and undo is exact. These
// are the domain logic behind the editing gestures; the tools/view just pick the
// transform and commit its result. Connect/reconnect/delete/rename/kind land here
// as their features are built.

// Pin a node to an explicit position (a manual override on top of auto-layout).
export function repositionNode(treeData, id, x, y) {
  return {
    ...treeData,
    nodes: treeData.nodes.map((node) => (node.id === id ? { ...node, position: { x, y } } : node)),
  };
}

// Add a child of `parentId`, born not-done, inheriting the parent's kind, pinned
// just outward of it. The new node's state falls out of UnlockRules like any other.
export function addChildNode(treeData, { id, label, icon, color, parentId, x, y }) {
  const node = { id, label, icon, color, prerequisites: [parentId], position: { x, y } };
  return { ...treeData, nodes: [...treeData.nodes, node] };
}
