// The explore rules (canon §4): the lens (a kind, held), the lookup (a query, typed) and the gate
// a locked step answers with. The first two are one predicate over the outline, so they are one
// function here; the third is a graph walk. Pure like outline.js and editing.js — no React, no
// DOM — so the phone's reading surfaces are testable without a screen. ListView owns the field,
// the chips, and everything the finger revealed.

import { NODE_COLOR_NAMES, DEFAULT_NODE_COLOR } from '../theme.js';
import { unlocksOf } from '../ui/nextUpPlan.js';

const SNIPPET_PAD = 40; // characters kept either side of a description hit
const LINE_CAP = 6;     // hops — a breadcrumb longer than a phone width stops being an answer

// A section survives when its head or one of its rows match; it keeps its head either way (depth
// is the information, so the scaffolding stays) and hides the rest behind a count the finger can
// open. `matches` counts exactly what the body will render — the root included — so zero IS the
// empty state, and a row that hit on its description alone carries the fragment that proves it.
export function filterOutline(outline, nodesById, { query = '', kind = null, revealed = null } = {}) {
  const needle = query.trim().toLowerCase();
  const finder = needle === '' ? null : new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const look = (id) => {
    const node = nodesById.get(id);
    if (!node) return null;
    if (kind && (node.color ?? DEFAULT_NODE_COLOR) !== kind) return null;
    if (!finder) return { snippet: null };
    if ((node.label ?? '').toLowerCase().includes(needle)) return { snippet: null };
    const description = node.description ?? '';
    const hit = finder.exec(description); // against the ORIGINAL — lowercasing is not length-preserving
    if (!hit) return null;
    const from = Math.max(0, hit.index - SNIPPET_PAD);
    const to = Math.min(description.length, hit.index + hit[0].length + SNIPPET_PAD);
    const cutBefore = description.slice(0, from).trim() !== '';
    const cutAfter = description.slice(to).trim() !== '';
    return { snippet: `${cutBefore ? '…' : ''}${description.slice(from, to).trim()}${cutAfter ? '…' : ''}` };
  };

  const rootHit = outline.rootId ? look(outline.rootId) : null;
  const sections = [];
  let matches = rootHit ? 1 : 0;
  for (const section of outline.sections) {
    const head = look(section.head);
    const matched = [];
    for (const row of section.rows) {
      const found = look(row.id);
      if (found) matched.push({ id: row.id, depth: row.depth, snippet: found.snippet });
    }
    if (!head && matched.length === 0) continue; // 40 empty headers is not "keeping depth"
    matches += matched.length + (head ? 1 : 0);
    const snippets = new Map(matched.map((row) => [row.id, row.snippet]));
    const rows = revealed?.has(section.head)
      ? section.rows.map((row) => ({ id: row.id, depth: row.depth, snippet: snippets.get(row.id) ?? null }))
      : matched;
    sections.push({
      head: section.head,
      headMatches: !!head,
      headSnippet: head?.snippet ?? null,
      rows,
      hidden: section.rows.length - rows.length,
    });
  }
  return { root: rootHit ? { id: outline.rootId, snippet: rootHit.snippet } : null, sections, matches };
}

// Only hues a step actually wears, in legend order, strays in palette order — never a filter that
// returns nothing, and never a row at all on a tree of one kind, where the answer is everything.
// Hue is the filter key because hue is what a node stores: two legend kinds sharing one hue are
// one chip, named after the first.
export function kindOptions(tree, legend = []) {
  const worn = new Set(tree.nodes.map((node) => node.color ?? DEFAULT_NODE_COLOR));
  if (worn.size < 2) return [];
  const named = new Map();
  for (const kind of legend ?? []) if (!named.has(kind.hue)) named.set(kind.hue, kind);
  const hues = [
    ...(legend ?? []).map((kind) => kind.hue).filter((hue) => worn.has(hue)),
    ...NODE_COLOR_NAMES.filter((hue) => worn.has(hue) && !named.has(hue)),
  ];
  return [...new Set(hues)].map((hue) => ({
    id: named.get(hue)?.id ?? hue,
    hue,
    label: named.get(hue)?.label || `${hue[0].toUpperCase()}${hue.slice(1)}`,
  }));
}

// Everything a locked step waits on: the owed set, the part of it that can be started today
// (ranked the way the whole app ranks work), how deep the gate runs — and the breadcrumb only when
// every hop owes exactly one step, since forcing a chain onto a branching gate is a lie with good
// typography. `clipped` says the six-hop cap dropped the far end; the near hops are the kept ones.
export function gateOf(tree, states, id) {
  const step = tree.nodesById.get(id);
  if (!step) return { blockedBy: 0, frontier: [], longestChain: 0, line: null, clipped: false };
  const unmet = (node) => {
    const owing = new Map(); // by id — a prerequisite listed twice still gates once
    for (const parent of tree.parentsOf(node.id)) {
      if (states.get(parent.id) !== 'complete') owing.set(parent.id, parent);
    }
    return [...owing.values()];
  };

  const owed = new Map();
  const pending = unmet(step);
  while (pending.length > 0) {
    const node = pending.pop();
    if (owed.has(node.id)) continue;
    owed.set(node.id, node);
    pending.push(...unmet(node));
  }

  const frontier = [...owed.values()]
    .filter((node) => unmet(node).length === 0)
    .map((node) => ({ node, unlocks: unlocksOf(tree, states, node.id) }))
    .sort((a, b) => b.unlocks - a.unlocks || (a.node.id < b.node.id ? -1 : 1))
    .map((entry) => entry.node);

  // Depth is a peel: today's frontier is layer one, what only they gate is layer two, and so on.
  // A cycle never peels, so a round that removes nothing ends it instead of hanging the phone.
  const peeled = new Set(frontier.map((node) => node.id));
  let longestChain = peeled.size > 0 ? 1 : 0;
  while (peeled.size < owed.size) {
    const layer = [...owed.values()].filter((node) => !peeled.has(node.id) && unmet(node).every((parent) => peeled.has(parent.id)));
    if (layer.length === 0) break;
    for (const node of layer) peeled.add(node.id);
    longestChain += 1;
  }

  const walk = [step];
  const walked = new Set([step.id]);
  let above = unmet(step);
  while (above.length === 1 && !walked.has(above[0].id)) {
    walked.add(above[0].id);
    walk.push(above[0]);
    above = unmet(above[0]);
  }

  // Running out of blockers AND covering the whole owed set is the proof of a line: a branch
  // leaves nodes behind, and a cycle stops the walk with something still above it.
  const straight = above.length === 0 && owed.size > 0 && walk.length - 1 === owed.size;
  return {
    blockedBy: owed.size,
    frontier,
    longestChain,
    line: straight ? walk.slice(0, LINE_CAP).reverse() : null,
    clipped: straight && walk.length > LINE_CAP,
  };
}
