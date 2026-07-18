// The canonical map of every editor shortcut — the one source that feeds both the
// ShortcutsDialog reference panel and the ControlBar button tooltips. Every row maps
// to a shipped gesture (SkillTreeView's keydown/paste handlers, the scene tools). A row
// carries alternatives (chords), and each chord is an ordered list of tokens: a keycap
// (a key you press) or a gesture (a thing you do with the pointer). Modifiers lead, the
// letter lands. Nothing here fires an action; it only names what already exists.

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

// The map is authored Mac-style; Windows swaps only the four keys that differ by platform.
const WINDOWS_KEYS = { '⌘': 'Ctrl', '⌥': 'Alt', '⌫': 'Delete', '⏎': 'Enter' };

export function keyLabel(label, platform) {
  if (platform !== 'windows') return label;
  return WINDOWS_KEYS[label] ?? label;
}

// Mac-first: only a detected Windows box swaps the map; everything else defaults to Mac.
export function detectPlatform() {
  if (typeof navigator === 'undefined') return 'mac';
  const raw = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (/win/i.test(raw)) return 'windows';
  return 'mac';
}

// Read-only trees (X5) can't edit or select, so those groups drop out — only the two
// pointer/view groups survive.
export function visibleGroups(readOnly) {
  if (!readOnly) return SHORTCUT_GROUPS;
  return SHORTCUT_GROUPS.filter((group) => group.title === 'Navigate' || group.title === 'View');
}

// The compact key hint a ControlBar tooltip appends, e.g. "?" or "A" — read from the same
// map so a shortcut is defined once and its label can never drift out of sync.
export function keyHint(rowLabel) {
  for (const group of SHORTCUT_GROUPS) {
    const row = group.rows.find((candidate) => candidate.label === rowLabel);
    if (row) return row.chords[0].map((token) => token.label).join('');
  }
  return '';
}
