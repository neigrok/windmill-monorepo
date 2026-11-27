// A node's `color` field is its kind; the legend names and orders those hues, and legend order
// is generation priority. Every op returns a new legend. Hue is unique, at most six.

import { readLegend } from './domainReads.js';
import { t } from '../i18n/settings/index.js';
import { GENESIS_STAMP, DEFAULT_KINDS } from '../../../../../packages/api-contract/genesis.js';

const LABEL_MAX = 24;
const DESCRIPTION_MAX = 80;

// A local-born tree's claim converges only while web and backend seed byte-equal legends at
// the same stamp.
export { GENESIS_STAMP, DEFAULT_KINDS };

// The room's legend: the kinds it was given, in their order, then each hue a step wears that none claims, as the domain
// shows its legend; with none given, the genesis kinds of an empty roadmap, or the hues its steps wear.
export function deriveLegend(nodes, saved) {
  if (!saved && nodes.length === 0) return DEFAULT_KINDS;
  const kinds = (saved ?? []).map((kind) => ({ id: kind.id, hue: kind.hue, label: kind.label ?? '', description: kind.description ?? '' }));
  return [...kinds, ...readLegend(kinds, nodes).shown.filter((entry) => entry.kind === null).map((entry) => unlabeledKind(entry.hue))];
}

// Each kind with how many steps wear its hue and whether it may be removed, as the domain reads its legend.
export function withCounts(legend, nodes) {
  const read = readLegend(legend, nodes);
  const steps = new Map(read.shown.map((entry) => [entry.hue, entry.steps]));
  const removable = new Set(read.removable.map((kind) => kind.id));
  return legend.map((kind) => ({ ...kind, count: steps.get(kind.hue) ?? 0, removable: removable.has(kind.id ?? kind.hue) }));
}

export function inUseCount(legend, nodes) {
  return withCounts(legend, nodes).filter((kind) => kind.count > 0).length;
}

const HUE_NAMES = {
  terracotta: t('roadmap.hue.terracotta'),
  olive: t('roadmap.hue.olive'),
  gold: t('roadmap.hue.gold'),
  brick: t('roadmap.hue.brick'),
  sky: t('roadmap.hue.sky'),
  plum: t('roadmap.hue.plum'),
};

// An unnamed kind is called by its hue; a hue outside the palette shows its own id.
export function hueName(hue) {
  return HUE_NAMES[hue] ?? `${hue[0].toUpperCase()}${hue.slice(1)}`;
}

export function kindName(kind) {
  return kind.label || hueName(kind.hue);
}

// A hue the domain lists with the kind that owns it, as a control names it: the kind's name, or the hue's own.
const asOption = ({ hue, kind }) => ({ id: kind?.id ?? hue, hue, label: kind?.label || hueName(hue) });

// The kind filter's options: the domain's (`LegendRead.filters`), the hues steps wear, none where they wear one alone.
export function kindOptions(tree, legend = []) {
  return readLegend(legend ?? [], tree.nodes).filters.map(asOption);
}

// Every surface's six choices: the domain's (`LegendRead.choices`), the named kinds, then the unnamed hues in palette
// order, so a save never reorders them under the pointer.
export function kindChoices(legend = []) {
  return readLegend(legend ?? []).choices.map(asOption);
}

// The domain's free hue: null once all six palette hues are taken.
export function freeHue(legend) {
  return readLegend(legend).free;
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

function unlabeledKind(hue, id = newId()) {
  return { id, hue, label: '', description: '' };
}

function newId() {
  return crypto.randomUUID?.() ?? `kind-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}
