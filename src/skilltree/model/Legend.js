// The color legend (F6 — Custom color legend): a tree's ordered list of kinds,
// naming and describing the hues its steps are painted in. A pure domain module —
// every op takes a legend and returns a NEW one, so callers stay immutable and the
// persistence layer + the render always read a fresh value. No I/O lives here.
//
//   kind:   { id, hue, label, description }  (+ derived `count` from withCounts)
//   legend: an ordered array of kinds; hue unique, at most six (the palette).
//
// A node's `color` field IS its kind — it holds the hue. The legend names and
// orders those hues; there is no separate node→kind link. Legend order is
// generation priority: the first kind is the fallback (see F6 §data model).

import { NODE_COLOR_NAMES, DEFAULT_NODE_COLOR } from '../theme.js';

const LABEL_MAX = 24; // one or two words, sentence-case (F6 §data model)
const DESCRIPTION_MAX = 80; // a plain-text sorting brief, optional

// A new/empty tree is born with these three, in order — never all six (F6 §2).
export const DEFAULT_KINDS = [
  { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
  { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
  { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
];

// The tree's legend: saved kinds when we have them (reconciled so every in-use hue
// still has an entry), else derived from the hues actually in use, else the defaults.
export function deriveLegend(nodes, saved) {
  const used = inUseHues(nodes);
  if (saved) {
    const kinds = saved.map((kind) => ({
      id: kind.id,
      hue: kind.hue,
      label: kind.label ?? '',
      description: kind.description ?? '',
    }));
    const present = new Set(kinds.map((kind) => kind.hue));
    const appended = used.filter((hue) => !present.has(hue)).map((hue) => unlabeledKind(hue));
    return [...kinds, ...appended];
  }
  if (nodes.length === 0) return DEFAULT_KINDS;
  return used.map((hue) => unlabeledKind(hue));
}

// Each kind annotated with how many nodes currently wear its hue.
export function withCounts(legend, nodes) {
  const tally = new Map();
  for (const node of nodes) {
    const hue = node.color ?? DEFAULT_NODE_COLOR;
    tally.set(hue, (tally.get(hue) ?? 0) + 1);
  }
  return legend.map((kind) => ({ ...kind, count: tally.get(kind.hue) ?? 0 }));
}

// How many kinds are actually worn by a node — the key appears at two (F6 §4).
export function inUseCount(legend, nodes) {
  return withCounts(legend, nodes).filter((kind) => kind.count > 0).length;
}

// The next unused hue in palette order, or null once all six are taken.
export function freeHue(legend) {
  const taken = new Set(legend.map((kind) => kind.hue));
  return NODE_COLOR_NAMES.find((hue) => !taken.has(hue)) ?? null;
}

export function renameKind(legend, id, label) {
  const clean = label.slice(0, LABEL_MAX);
  return legend.map((kind) => (kind.id === id ? { ...kind, label: clean } : kind));
}

export function describeKind(legend, id, description) {
  const clean = description.slice(0, DESCRIPTION_MAX);
  return legend.map((kind) => (kind.id === id ? { ...kind, description: clean } : kind));
}

// Append an unlabeled kind for a free hue (count 0 until steps use it). A no-op if
// the hue is already taken or the palette is full (hue null). `id` is minted locally
// for a fresh add, or passed through when applying an authoritative AddKind op whose
// id the server (or a collaborator) already chose.
export function addKind(legend, hue, id) {
  if (!hue) return legend;
  if (legend.some((kind) => kind.hue === hue)) return legend;
  return [...legend, unlabeledKind(hue, id)];
}

// Drop a kind from the legend. Callers only remove kinds no node wears (count 0);
// the count guard lives at the call site, which knows the current nodes.
export function removeKind(legend, id) {
  return legend.filter((kind) => kind.id !== id);
}

// Reorder the legend to match `order` (a list of kind ids). Ids absent from `order`
// keep their relative position at the end. Legend order is generation priority.
export function reorderKinds(legend, order) {
  const byId = new Map(legend.map((kind) => [kind.id, kind]));
  const seen = new Set();
  const ordered = [];
  for (const id of order) {
    const kind = byId.get(id);
    if (kind && !seen.has(id)) {
      ordered.push(kind);
      seen.add(id);
    }
  }
  for (const kind of legend) if (!seen.has(kind.id)) ordered.push(kind);
  return ordered;
}

// Swap a kind's hue to a free one, returning the old and new hues so the caller can
// repaint every node of the old hue to the new. A no-op ({ oldHue, newHue } null) if
// the kind is missing or the target hue is already taken by another kind.
export function recolorKind(legend, id, newHue) {
  const target = legend.find((kind) => kind.id === id);
  if (!target || !newHue || legend.some((kind) => kind.hue === newHue)) {
    return { legend, oldHue: null, newHue: null };
  }
  const next = legend.map((kind) => (kind.id === id ? { ...kind, hue: newHue } : kind));
  return { legend: next, oldHue: target.hue, newHue };
}

// The hues a node actually wears, in palette order.
function inUseHues(nodes) {
  const used = new Set(nodes.map((node) => node.color ?? DEFAULT_NODE_COLOR));
  return NODE_COLOR_NAMES.filter((hue) => used.has(hue));
}

function unlabeledKind(hue, id = newId()) {
  return { id, hue, label: '', description: '' };
}

function newId() {
  return crypto.randomUUID?.() ?? `kind-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}
