// A node's `color` field is its kind; the legend names and orders those hues, and legend order
// is generation priority. Every op returns a new legend. Hue is unique, at most six.

import { NODE_COLOR_NAMES, DEFAULT_NODE_COLOR } from '../theme.js';
import { GENESIS_STAMP, DEFAULT_KINDS } from '../../../../../packages/api-contract/genesis.js';

const LABEL_MAX = 24;
const DESCRIPTION_MAX = 80;

// A local-born tree's claim converges only while web and backend seed byte-equal legends at
// the same stamp.
export { GENESIS_STAMP, DEFAULT_KINDS };

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

export function withCounts(legend, nodes) {
  const tally = new Map();
  for (const node of nodes) {
    const hue = node.color ?? DEFAULT_NODE_COLOR;
    tally.set(hue, (tally.get(hue) ?? 0) + 1);
  }
  return legend.map((kind) => ({ ...kind, count: tally.get(kind.hue) ?? 0 }));
}

export function inUseCount(legend, nodes) {
  return withCounts(legend, nodes).filter((kind) => kind.count > 0).length;
}

// null once all six palette hues are taken.
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

// `id` is passed through when applying an op whose id the server or a collaborator already chose.
export function addKind(legend, hue, id) {
  if (!hue) return legend;
  if (legend.some((kind) => kind.hue === hue)) return legend;
  return [...legend, unlabeledKind(hue, id)];
}

// Callers must only remove kinds no node wears.
export function removeKind(legend, id) {
  return legend.filter((kind) => kind.id !== id);
}

// Returns the old and new hues for the caller to repaint; both null when nothing changed.
export function recolorKind(legend, id, newHue) {
  const target = legend.find((kind) => kind.id === id);
  if (!target || !newHue || legend.some((kind) => kind.hue === newHue)) {
    return { legend, oldHue: null, newHue: null };
  }
  const next = legend.map((kind) => (kind.id === id ? { ...kind, hue: newHue } : kind));
  return { legend: next, oldHue: target.hue, newHue };
}

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
