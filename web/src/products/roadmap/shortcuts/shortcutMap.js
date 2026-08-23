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
      { label: 'Fit tree to screen', chords: [[key('F')]] },
      { label: 'Reset zoom', chords: [[key('0')]] },
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
      { label: 'Tend the tree', chords: [[key('⌘'), key('K')], [key('/')]] },
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

export function visibleGroups(readOnly) {
  if (!readOnly) return SHORTCUT_GROUPS;
  return SHORTCUT_GROUPS.filter((group) => group.title === 'Navigate' || group.title === 'View');
}

export function keyHint(rowLabel) {
  for (const group of SHORTCUT_GROUPS) {
    const row = group.rows.find((candidate) => candidate.label === rowLabel);
    if (row) return row.chords[0].map((token) => token.label).join('');
  }
  return '';
}
