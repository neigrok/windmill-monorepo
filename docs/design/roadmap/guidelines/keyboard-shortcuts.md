# Windmill Keyboard-shortcuts overlay

A discoverable reference for the editor's real shortcuts. Not aspirational —
every row maps to a shipped gesture from the editing spec. Live specimens:
`explorations/shortcuts-overlay.html`.

## Trigger & modal
- **Two triggers, one panel:** `?` (`shift + /`) whenever the canvas has focus,
  or the **keyboard button** in the ControlBar (after zoom + fit).
- **On the shared Dialog** — same `--surface-overlay` scrim, `--radius-xl` card,
  `--shadow-lg`, `wm-pop-in` entrance — but wider than the 420 confirm dialog
  because its one job is scanning: **600px, two columns**.
- **Closes four ways:** `esc`, the ×, a backdrop click, or `?` again. Focus traps
  inside while open and returns to the canvas on close. It never edits anything.

## The kbd chip & tokens
- **Keycap** — a single key: mono, warm-white cap with a 2.5px bottom border.
  A combo sets caps adjacent with a hair gap (modifiers lead, letter lands).
- **Gesture token** — a soft sunken pill, body font, no cap depth: a thing you
  *do* with the pointer, not a key. Alternatives join with a muted `or`.
- The keycap-vs-gesture distinction is the point: a glance tells you whether a
  row is a key or a pointer move (marquee = `⇧` + `Drag`, honestly both).

## Platform & content
- **Platform-aware:** detects the OS — `⌘ ⌥ ⌫ ⏎` on Mac, `Ctrl Alt Delete Enter`
  on Windows — with a Mac / Windows toggle to check the other map.
- **Groups:** Navigate / Select / Edit / History / View (move → choose → change →
  time-travel → look).
- **Read-only trees** (X5) show less: editing is absent, so Edit / Select /
  History drop out — only Navigate + View list. Never advertise a missing verb.
- **The map is data** — one list feeds this panel and the ControlBar button
  tooltips, so a new shortcut is added once.
- **Reduced motion:** no pop-in or backdrop fade; the modal appears in place,
  scrim at full opacity. Focus handling unchanged.

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
| History | Undo | `⌘ Z` |
| History | Redo | `⇧ ⌘ Z` |
| View | Keyboard shortcuts | `?` |
| View | Activity feed | `A` |
