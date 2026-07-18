// The keyboard-shortcuts reference (editor-only). A plain read-only card over the
// shared Dialog — every row is a genuine editor shortcut or canvas gesture that
// lives in the keydown handler (SkillTreeView), the paste handler, or the scene
// tools (NavigateTool / InputController / ConnectGesture / EdgeChrome). Nothing
// here fires an action; it only names what already exists so it's discoverable.

import React from 'react';
import { Dialog } from '../../components';

const GROUPS = [
  {
    title: 'Navigate',
    shortcuts: [
      { keys: ['Drag'], label: 'Pan the canvas' },
      { keys: ['Scroll'], label: 'Zoom in and out' },
    ],
  },
  {
    title: 'Select',
    shortcuts: [
      { keys: ['Click'], label: 'Select a step or link' },
      { keys: ['⇧', 'Click'], label: 'Add or remove one from the selection' },
      { keys: ['⇧', 'Drag'], label: 'Marquee-select a region' },
      { keys: ['⌘', 'A'], label: 'Select all steps' },
      { keys: ['Esc'], label: 'Clear the selection' },
    ],
  },
  {
    title: 'Edit',
    shortcuts: [
      { keys: ['Drag'], label: 'From a step’s edge — draw a new link' },
      { keys: ['Drag'], label: 'A link’s end handle — re-aim the link' },
      { keys: ['⌫'], label: 'Delete the selection' },
      { keys: ['⌘', 'V'], label: 'Paste an outline to add steps' },
    ],
  },
  {
    title: 'History',
    shortcuts: [
      { keys: ['⌘', 'Z'], label: 'Undo' },
      { keys: ['⇧', '⌘', 'Z'], label: 'Redo' },
    ],
  },
  {
    title: 'View',
    shortcuts: [
      { keys: ['A'], label: 'Activity / What’s next' },
      { keys: ['?'], label: 'Show this help' },
    ],
  },
];

export function ShortcutsDialog({ open, onClose }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width={480}>
      <div className="st-shortcuts">
        {GROUPS.map((group) => (
          <section className="st-shortcuts-group" key={group.title}>
            <h3 className="st-shortcuts-heading">{group.title}</h3>
            <ul className="st-shortcuts-list">
              {group.shortcuts.map((shortcut) => (
                <li className="st-shortcuts-row" key={shortcut.label}>
                  <span className="st-shortcuts-label">{shortcut.label}</span>
                  <span className="st-shortcuts-keys">
                    {shortcut.keys.map((key, index) => (
                      <kbd className="st-kbd" key={index}>{key}</kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
