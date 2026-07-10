// Pure TreeData → TreeData edit transforms. Each returns a new TreeData with
// structural sharing — only the touched nodes are replaced, unchanged ones are
// reused — so TreeEditor's history snapshots stay cheap and undo is exact. These
// are the domain logic behind the editing gestures; the tools/view just pick the
// transform and commit its result. Structural transforms (add/connect/delete)
// land here as their features are built.

// Pin a node to an explicit position (a manual override on top of auto-layout).
export function repositionNode(treeData, id, x, y) {
  return {
    ...treeData,
    nodes: treeData.nodes.map((node) => (node.id === id ? { ...node, position: { x, y } } : node)),
  };
}
