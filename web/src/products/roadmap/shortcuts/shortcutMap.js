// The canonical map of roadmap shortcuts behind the ShortcutsDialog. A chord is an ordered token list: modifiers lead, the letter lands.

const key = (label) => ({ kind: 'key', label });
const gesture = (label) => ({ kind: 'gesture', label });

const HISTORY_GROUP = {
  title: 'History',
  rows: [
    { label: 'Undo', chords: [[key('⌘'), key('Z')]] },
    { label: 'Redo', chords: [[key('⇧'), key('⌘'), key('Z')]] },
  ],
};

export const GRAPH_SHORTCUT_GROUPS = [
  {
    title: 'Navigate',
    rows: [
      { label: 'Pan the canvas', chords: [[gesture('Drag')], [gesture('Space+Drag')]] },
      { label: 'Zoom in / out', chords: [[gesture('Scroll')], [key('⌘'), key('=')], [key('⌘'), key('−')]] },
      { label: 'Zoom to a point', chords: [[gesture('Double-click')]] },
      { label: 'Focus on a step', chords: [[key('F')]] },
      { label: 'All steps', chords: [[key('0')]] },
      { label: 'Find a step', chords: [[key('/')]] },
    ],
  },
  {
    title: 'Select',
    rows: [
      { label: 'Select a step', chords: [[gesture('Click')]] },
      { label: 'Add / remove from set', chords: [[key('⇧'), gesture('Click')]] },
      { label: 'Select all steps', chords: [[key('⌘'), key('A')]] },
      { label: 'Marquee select', chords: [[key('⇧'), gesture('Drag')]] },
      { label: 'Deselect', chords: [[key('esc')]] },
    ],
  },
  {
    title: 'Edit',
    rows: [
      { label: 'Rename step', chords: [[key('⏎')]] },
      { label: 'Delete step', chords: [[key('⌫')]] },
      { label: 'Paste a plan (append)', chords: [[key('⌘'), key('V')]] },
      { label: 'Ask AI', chords: [[key('⌘'), key('K')]] },
    ],
  },
  HISTORY_GROUP,
  {
    title: 'View',
    rows: [
      { label: 'Keyboard shortcuts', chords: [[key('?')]] },
      { label: 'Activity feed', chords: [[key('A')]], owner: true },
    ],
  },
];

export const BOARD_SHORTCUT_GROUPS = [
  {
    title: 'Board',
    rows: [
      { label: 'Find a step', chords: [[key('/')]] },
      { label: 'Move between steps', chords: [[key('↑'), key('↓')]] },
      { label: 'Move between columns', chords: [[key('←'), key('→')]] },
      { label: 'Open step', chords: [[key('⏎')]] },
      { label: 'Close step', chords: [[key('esc')]] },
      { label: 'Complete step', chords: [[key('C')]], owner: true },
      { label: 'Delete step', chords: [[key('⌫')]], owner: true },
      { label: 'Board / Graph', chords: [[key('G')]] },
    ],
  },
  {
    title: 'Edit',
    rows: [
      { label: 'Ask AI', chords: [[key('⌘'), key('K')]] },
      { label: 'Paste a plan', chords: [[key('⌘'), key('V')]] },
    ],
  },
  HISTORY_GROUP,
  {
    title: 'View',
    rows: [{ label: 'Keyboard shortcuts', chords: [[key('?')]] }],
  },
];

// Authored Mac-style; Windows swaps only these keys.
const WINDOWS_KEYS = { '⌘': 'Ctrl', '⌥': 'Alt', '⌫': 'Delete', '⏎': 'Enter' };

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
export function visibleGroups(readOnly, view = 'graph', owner = !readOnly) {
  const groups = view === 'board' ? BOARD_SHORTCUT_GROUPS : GRAPH_SHORTCUT_GROUPS;
  if (!readOnly) return groups;
  const reading = view === 'board' ? 'Board' : 'Navigate';
  return groups
    .filter((group) => group.title === reading || group.title === 'View')
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
