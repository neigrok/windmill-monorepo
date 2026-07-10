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

// Add `sourceId` as a prerequisite of `targetId` (a new dependency edge). A no-op
// if already connected; the caller prevents cycles before committing.
export function addEdge(treeData, sourceId, targetId) {
  return {
    ...treeData,
    nodes: treeData.nodes.map((node) =>
      node.id === targetId && !node.prerequisites.includes(sourceId)
        ? { ...node, prerequisites: [...node.prerequisites, sourceId] }
        : node),
  };
}

export function renameNode(treeData, id, label) {
  return {
    ...treeData,
    nodes: treeData.nodes.map((node) => (node.id === id ? { ...node, label } : node)),
  };
}

// Remove a node without orphaning its children: a child that loses its only
// parent is re-tethered to the deleted node's own parents (spliced up); a child
// with other parents just drops this one. One transform → one undo step, and the
// re-tether targets are ancestors, so it stays a DAG.
export function deleteNode(treeData, id) {
  const target = treeData.nodes.find((node) => node.id === id);
  if (!target) return treeData;
  const grandparents = target.prerequisites;
  const nodes = treeData.nodes
    .filter((node) => node.id !== id)
    .map((node) => {
      if (!node.prerequisites.includes(id)) return node;
      const others = node.prerequisites.filter((prereqId) => prereqId !== id);
      const rewired = others.length > 0 ? others : grandparents;
      const prerequisites = [...new Set(rewired)].filter((prereqId) => prereqId !== node.id);
      return { ...node, prerequisites };
    });
  return { ...treeData, nodes };
}
