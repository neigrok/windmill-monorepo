// paste append-mode (F3 §01): a parsed plan grafted onto a LIVE tree, under one node.
// Pure and dependency-free — parsePlan gives the subgraph, this shapes it to attach, and
// SkillTreeView dispatches the result as one ImportSubgraph gesture (one undo entry).
//
// THE GRAFT RULE, keyed on parse.missingRoot (which the parser already computes):
//   • missingRoot === false — the paste opened with a real named root (`# Heading` or a
//     first plain line). ATTACH: the parsed root becomes a child of the target, its
//     subtree kept beneath it. Its 'sparkles' icon is a birth-only glyph, so it is
//     dropped — a grafted node never wears the tree-birth spark.
//   • missingRoot === true — the parser synthesized an empty root (a bullet list or a
//     bare `##`). DISSOLVE: that root is dropped and each of its direct children is
//     re-parented onto the target. A flat list attaches directly; append never forces
//     a wrapper name.
// A null target (an empty or rootless tree) lands the graft at root level instead — a
// paste into nothing plants it, rather than vanishing.
//
// Two correctness guards live here:
//   • ID collision — parsed ids (slug + counter) can collide with ids the lattice already
//     holds. `reservedNodeIds` is every id the lattice has a record for — present AND
//     tombstoned, because a `created` write re-lives a tombstone (its old fields and edges
//     survive the delete), so a colliding paste would silently resurrect a deleted node.
//     A remap suffixes every collision (-2/-3, the parser's own scheme), applied to every
//     node id AND every prerequisite reference — no existing node is lost, overwritten, or revived.
//   • Adds-only legend — only kinds absent from the live legend land, by id; an existing
//     kind is never renamed, recolored or removed. (Birth's diff prunes defaults; append
//     keeps every existing kind untouched.)

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
    nodes.push(grafted); // icon deliberately dropped — the birth spark is not grafted

    // ATTACH: the kept root gets the target as its only parent; every other node keeps its
    // (remapped) parents — including references to the kept root. DISSOLVE: the root is gone,
    // so its direct children re-root onto the target instead. With no target (an empty tree),
    // a parent that resolves to the missing target drops to null — the node lands as a root.
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
