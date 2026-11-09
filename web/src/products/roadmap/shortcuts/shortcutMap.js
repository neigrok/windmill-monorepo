// The canonical map of roadmap shortcuts behind the ShortcutsDialog. A chord is an ordered token list: modifiers lead, the letter lands.

import { t } from '../i18n/index.js';

const key = (label) => ({ kind: 'key', label });
const gesture = (label) => ({ kind: 'gesture', label });

const HISTORY_GROUP = {
  id: 'history',
  title: t('roadmap.shortcuts.history'),
  rows: [
    { label: t('roadmap.shortcuts.undo'), chords: [[key('⌘'), key('Z')]] },
    { label: t('roadmap.shortcuts.redo'), chords: [[key('⇧'), key('⌘'), key('Z')]] },
  ],
};

export const GRAPH_SHORTCUT_GROUPS = [
  {
    id: 'navigate',
    title: t('roadmap.shortcuts.navigate'),
    rows: [
      { label: t('roadmap.shortcuts.pan'), chords: [[gesture(t('roadmap.shortcuts.drag'))], [gesture(t('roadmap.shortcuts.spaceDrag'))]] },
      { label: t('roadmap.shortcuts.zoom'), chords: [[gesture(t('roadmap.shortcuts.scroll'))], [key('⌘'), key('=')], [key('⌘'), key('−')]] },
      { label: t('roadmap.shortcuts.zoomToPoint'), chords: [[gesture(t('roadmap.shortcuts.doubleClick'))]] },
      { label: t('roadmap.shortcuts.focusStep'), chords: [[key('F')]] },
      { label: t('roadmap.shortcuts.allSteps'), chords: [[key('0')]] },
      { label: t('roadmap.shortcuts.findStep'), chords: [[key('/')]] },
    ],
  },
  {
    id: 'select',
    title: t('roadmap.shortcuts.select'),
    rows: [
      { label: t('roadmap.shortcuts.selectStep'), chords: [[gesture(t('roadmap.shortcuts.click'))]] },
      { label: t('roadmap.shortcuts.toggleInSet'), chords: [[key('⇧'), gesture(t('roadmap.shortcuts.click'))]] },
      { label: t('roadmap.shortcuts.selectAll'), chords: [[key('⌘'), key('A')]] },
      { label: t('roadmap.shortcuts.marquee'), chords: [[key('⇧'), gesture(t('roadmap.shortcuts.drag'))]] },
      { label: t('roadmap.shortcuts.deselect'), chords: [[key(t('roadmap.shortcuts.keyEsc'))]] },
    ],
  },
  {
    id: 'edit',
    title: t('roadmap.shortcuts.edit'),
    rows: [
      { label: t('roadmap.shortcuts.renameStep'), chords: [[key('⏎')]] },
      { label: t('roadmap.shortcuts.deleteStep'), chords: [[key('⌫')]] },
      { label: t('roadmap.shortcuts.pastePlanAppend'), chords: [[key('⌘'), key('V')]] },
      { label: t('roadmap.shortcuts.askAI'), chords: [[key('⌘'), key('K')]] },
    ],
  },
  HISTORY_GROUP,
  {
    id: 'view',
    title: t('roadmap.shortcuts.view'),
    rows: [
      { label: t('roadmap.shortcuts.keyboardShortcuts'), chords: [[key('?')]] },
      { label: t('roadmap.shortcuts.activityFeed'), chords: [[key('A')]], owner: true },
    ],
  },
];

export const BOARD_SHORTCUT_GROUPS = [
  {
    id: 'board',
    title: t('roadmap.shortcuts.board'),
    rows: [
      { label: t('roadmap.shortcuts.findStep'), chords: [[key('/')]] },
      { label: t('roadmap.shortcuts.moveSteps'), chords: [[key('↑'), key('↓')]] },
      { label: t('roadmap.shortcuts.moveColumns'), chords: [[key('←'), key('→')]] },
      { label: t('roadmap.shortcuts.openStep'), chords: [[key('⏎')]] },
      { label: t('roadmap.shortcuts.closeStep'), chords: [[key(t('roadmap.shortcuts.keyEsc'))]] },
      { label: t('roadmap.shortcuts.completeStep'), chords: [[key('C')]], owner: true },
      { label: t('roadmap.shortcuts.deleteStep'), chords: [[key('⌫')]], owner: true },
      { label: t('roadmap.shortcuts.switchView'), graph: true, chords: [[key('G')]] },
    ],
  },
  {
    id: 'edit',
    title: t('roadmap.shortcuts.edit'),
    rows: [
      { label: t('roadmap.shortcuts.askAI'), chords: [[key('⌘'), key('K')]] },
      { label: t('roadmap.shortcuts.pastePlan'), chords: [[key('⌘'), key('V')]] },
    ],
  },
  HISTORY_GROUP,
  {
    id: 'view',
    title: t('roadmap.shortcuts.view'),
    rows: [{ label: t('roadmap.shortcuts.keyboardShortcuts'), chords: [[key('?')]] }],
  },
];

// Authored Mac-style; Windows swaps only these keys.
const WINDOWS_KEYS = { '⌘': t('roadmap.shortcuts.keyCtrl'), '⌥': t('roadmap.shortcuts.keyAlt'), '⌫': t('roadmap.shortcuts.keyDelete'), '⏎': t('roadmap.shortcuts.keyEnter') };

export function keyLabel(label, platform) {
  if (platform !== 'windows') return label;
  return WINDOWS_KEYS[label] ?? label;
}

export function detectPlatform() {
  if (typeof navigator === 'undefined') return 'mac';
  const raw = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (/win/i.test(raw)) return 'windows';
  return 'mac';
}

// Without the desktop editor only navigation and help remain, and a row marked for owners shows to owners alone.
export function visibleGroups(readOnly, view = 'graph', owner = !readOnly, graphAvailable = true) {
  const available = view === 'board' ? BOARD_SHORTCUT_GROUPS : GRAPH_SHORTCUT_GROUPS;
  const groups = graphAvailable ? available : available.map((group) => ({ ...group, rows: group.rows.filter((row) => !row.graph) }));
  if (!readOnly) return groups;
  const reading = view === 'board' ? 'board' : 'navigate';
  return groups
    .filter((group) => group.id === reading || group.id === 'view')
    .map((group) => ({ ...group, rows: group.rows.filter((row) => owner || !row.owner) }));
}

// The Graph's own keys, which the Board ignores once the shared Activity key is resolved.
export function graphOnlyKey({ key, metaKey = false, ctrlKey = false, altKey = false }) {
  if (key === 'Backspace' || key === 'Delete') return true;
  if (metaKey || ctrlKey) return key.toLowerCase() === 'a';
  return !altKey && (key === 'a' || key.toLowerCase() === 'f' || key === '0');
}

// The Board's own keys, unmodified, never while typing in a field and never while a modal layer covers the Board (a step
// open over it, a dialog, the composer): / for Find a step, G for Board ⇄ Graph, A for Activity, C for Complete, ⌫ for held delete.
export function boardKey({ key, metaKey = false, ctrlKey = false, altKey = false }, { typing = false, covered = false } = {}) {
  if (metaKey || ctrlKey || altKey || typing || covered) return null;
  if (key === '/') return 'find';
  if (key.toLowerCase() === 'a') return 'activity';
  if (key.toLowerCase() === 'g') return 'switch';
  if (key.toLowerCase() === 'c') return 'complete';
  if (key === 'Backspace' || key === 'Delete') return 'delete';
  return null;
}
