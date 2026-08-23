# Keyboard-shortcuts overlay

A discoverable reference for the editor's real shortcuts. Every row maps to a live
gesture; the map is `products/roadmap/shortcuts/shortcutMap.js`.

## Trigger & modal
- **Two triggers, one panel:** `?` (`shift + /`) whenever the canvas has focus, or the
  keyboard button in the ControlBar (after zoom + fit).
- **On the shared Dialog** — `--surface-overlay` scrim, `--radius-xl` card, `--shadow-lg`,
  `wm-pop-in` entrance — but **600px, two columns**, because its one job is scanning.
- **Closes four ways:** `esc`, the ×, a backdrop click, or `?` again. Focus traps inside
  while open and returns to the canvas on close. It never edits anything.

## The kbd chip & tokens
- **Keycap** — a single key: mono, warm-white cap with a 2.5px bottom border. A combo sets
  caps adjacent with a hair gap (modifiers lead, letter lands).
- **Gesture token** — a soft sunken pill, body font, no cap depth: a thing you do with the
  pointer. Alternatives join with a muted `or`.
- A glance must tell whether a row is a key or a pointer move (marquee = `⇧` + `Drag`,
  honestly both).

## Platform & content
- **Platform-aware:** `⌘ ⌥ ⌫ ⏎` on Mac, `Ctrl Alt Delete Enter` on Windows, with a
  Mac / Windows toggle to check the other map.
- **Groups:** Navigate / Select / Edit / History / View.
- **Read-only trees** drop Edit / Select / History — only Navigate + View list. Never
  advertise a missing verb.
- **The map is data** — one list feeds this panel and the ControlBar button tooltips, so a
  new shortcut is added once.
- **Reduced motion:** no pop-in or backdrop fade; the modal appears in place, scrim at full
  opacity. Focus handling unchanged.

## The canonical list
| Group | Action | Keys |
|---|---|---|
| Navigate | Pan the canvas | `Drag` · `Space`+`Drag` |
| Navigate | Zoom in / out | `Scroll` · `⌘ =` / `⌘ −` |
| Navigate | Zoom to a point | `Double-click` |
| Navigate | Fit tree to screen | `F` |
| Navigate | Reset zoom | `0` |
| Select | Select a step | `Click` |
| Select | Add / remove from set | `⇧ Click` |
| Select | Select all steps | `⌘ A` |
| Select | Marquee select | `⇧ Drag` |
| Select | Deselect | `esc` |
| Edit | Rename step | `⏎` |
| Edit | Delete step | `⌫` |
| Edit | Paste a plan (append) | `⌘ V` |
| Edit | Tend the tree | `⌘ K` · `/` |
| History | Undo | `⌘ Z` |
| History | Redo | `⇧ ⌘ Z` |
| View | Keyboard shortcuts | `?` |
| View | Activity feed | `A` |
