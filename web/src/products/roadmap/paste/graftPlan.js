// A parsed plan grafted onto a live tree under one node; the caller dispatches the result as one
// ImportSubgraph gesture. With parse.missingRoot false the pasted root becomes a child of the
// target, icon dropped; with it true the synthesized root is dropped and its direct children
// re-parent onto the target. A null target lands the graft at root level. `reservedNodeIds` must
// be every id the lattice has a record for, tombstones included, or a colliding paste resurrects a
// deleted node. The legend is adds-only, by id.

export function graftPlan({ parse, targetId, reservedNodeIds, liveKinds }) {
  const rootId = parse.nodes[0]?.id;
  const dissolve = parse.missingRoot;

  const remap = new Map();
  const taken = new Set(reservedNodeIds);
  for (const parsed of parse.nodes) {
    if (dissolve && parsed.id === rootId) continue; // the synthesized root never lands
    let id = parsed.id;
    if (taken.has(id)) {
      let n = 2;
      while (taken.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    taken.add(id);
    remap.set(parsed.id, id);
  }

  const nodes = [];
  const edges = [];
  for (const parsed of parse.nodes) {
    if (dissolve && parsed.id === rootId) continue;
    const id = remap.get(parsed.id);
    const grafted = { id, label: parsed.label, color: parsed.color, position: null };
    if (parsed.status) grafted.status = parsed.status;
    if (parsed.description) grafted.description = parsed.description;
    if (parsed.links?.length) grafted.links = [...parsed.links];
    nodes.push(grafted);

    // A kept root takes the target as its only parent; every other node keeps its remapped ones.
    // With no target, a parent that resolves to it drops and the node lands as a root.
    const attachRoot = !dissolve && parsed.id === rootId;
    const prereqs = attachRoot
      ? (targetId ? [targetId] : [])
      : parsed.prerequisites.map((from) => (dissolve && from === rootId ? targetId : remap.get(from)));
    for (const from of prereqs) if (from) edges.push({ from, to: id });
  }

  const liveKindIds = new Set(liveKinds.map((kind) => kind.id));
  const kinds = parse.kinds
    .filter((kind) => !liveKindIds.has(kind.id))
    .map(({ id, hue, label, description }) => ({ id, hue, label, description }));

  return { nodes, edges, kinds };
}

export default graftPlan;
