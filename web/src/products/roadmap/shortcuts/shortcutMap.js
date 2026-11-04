// The canonical map of editor shortcuts, feeding both the ShortcutsDialog and the ControlBar tooltips. A chord is an ordered token list: modifiers lead, the letter lands.

const key = (label) => ({ kind: 'key', label });
const gesture = (label) => ({ kind: 'gesture', label });

export const SHORTCUT_GROUPS = [
  {
    title: 'Navigate',
    rows: [
      { label: 'Pan the canvas', chords: [[gesture('Drag')], [gesture('Space+Drag')]] },
      { label: 'Zoom in / out', chords: [[gesture('Scroll')], [key('⌘'), key('=')], [key('⌘'), key('−')]] },
      { label: 'Zoom to a point', chords: [[gesture('Double-click')]] },
      { label: 'Focus on a step', chords: [[key('F')]] },
      { label: 'All steps', chords: [[key('0')]] },
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
      { label: 'Ask AI', chords: [[key('⌘'), key('K')], [key('/')]] },
    ],
  },
  {
    title: 'History',
    rows: [
      { label: 'Undo', chords: [[key('⌘'), key('Z')]] },
      { label: 'Redo', chords: [[key('⇧'), key('⌘'), key('Z')]] },
    ],
  },
  {
    title: 'View',
    rows: [
      { label: 'Keyboard shortcuts', chords: [[key('?')]] },
      { label: 'Activity feed', chords: [[key('A')]] },
    ],
  },
];

const GRAPH_SHORTCUT_GROUPS = SHORTCUT_GROUPS.map((group) => {
  if (group.title === 'Navigate') {
    return { ...group, rows: [...group.rows, { label: 'Find a step', chords: [[key('/')]] }] };
  }
  if (group.title === 'Edit') {
    return { ...group, rows: group.rows.map((row) => row.label === 'Ask AI'
      ? { ...row, chords: [[key('⌘'), key('K')]] }
      : row) };
  }
  return group;
});

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
  SHORTCUT_GROUPS.find((group) => group.title === 'History'),
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

export function visibleGroups(readOnly, view = 'graph', boardOpen = false) {
  if (view === 'board') {
    if (!readOnly) return BOARD_SHORTCUT_GROUPS;
    return BOARD_SHORTCUT_GROUPS
      .filter((group) => group.title === 'Board' || group.title === 'View')
      .map((group) => ({ ...group, rows: group.rows.filter((row) => !row.owner) }));
  }
  const groups = boardOpen ? GRAPH_SHORTCUT_GROUPS : SHORTCUT_GROUPS;
  if (!readOnly) return groups;
  return groups.filter((group) => group.title === 'Navigate' || group.title === 'View');
}

export function keyHint(rowLabel) {
  for (const group of SHORTCUT_GROUPS) {
    const row = group.rows.find((candidate) => candidate.label === rowLabel);
    if (row) return row.chords[0].map((token) => token.label).join('');
  }
  return '';
}

// Legacy Graph keys are ignored by the Board after the shared gated Activity key is resolved.
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
