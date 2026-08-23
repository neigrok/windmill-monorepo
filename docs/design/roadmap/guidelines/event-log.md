# Event log — the activity feed

The spec for the log of recent tree activity: where it lives, what logs, and how rows
link back to the canvas. Motion physics come from `motion-language.md`.

> **Principle: the moment lives on the graph; the log is the receipt.** The canvas runs
> full-bleed by default — the feed is summoned, never squatting.

## 1. Placement

- **A labeled chip in the canvas toolbar** (top-right, by the zoom controls), reading
  **"Next · N"** (ready count) with an unseen-activity dot; at 0 ready it falls back to
  "Activity · N". The badge counts only events since your last open.
- **Open = a zero-reflow overlay** sliding over the canvas's right edge: the tree never
  reflows, no camera jump. × or any canvas click closes it; the chip stays put. The dock
  stacks two tenants — **NEXT UP leads, ACTIVITY follows** — one scroll, same grammar
  (`whats-next.md`).
- **A pin in the panel header docks it persistently**, for wide screens and heavy shared
  sessions.
- **Editor surfaces only.** Read-only and hosted pages have no toolbars; the feed never
  mounts there.
- **Keyboard:** `a` toggles, esc closes. Focus moves into the panel on open, back to the
  canvas on close.

## 2. What logs

| Logs | Never logs |
|---|---|
| step started · step completed (+ the unlocks it causes) · step added / renamed / removed | pans, hovers, selections, readout recalcs |

- **Object = a node.** The step name carries its kind-hue dot — the same hue the fruit
  wears. Removed steps lose their dot, mute, and strike through.
- **Time, tertiary:** relative, abbreviated, mono — "2h", "1d", no "ago". Day separators
  (Today / Yesterday) carry the calendar.

## 3. Row ↔ fruit linkage

- **Hover a row** → its node + branches light; the rest of the tree dims to ~30% (150ms).
- **Click a row** → the camera glides to the node (480ms `--ease-soft`) + a terracotta
  focus ring. The log never edits — it points.

## 4. Arrivals

- **While closed:** the moment plays on the graph — the toast speaks and the fruit pulses
  in its kind glow; the badge counts what you haven't seen.
- **While open:** new rows slide in at the top with a brand-soft flash fading over ~1.4s;
  the node still pulses.
- **Opening replays unread rows** with the same flash.
- **With the step panel:** selecting a fruit while the feed is open swaps the overlay to
  step details; closing details returns to the feed only if it was open before — otherwise
  everything closes and the canvas is clean.

## 5. Phone

There is no canvas toolbar on a phone, so the Activity chip has no home there. **Activity
shares the return-visit sheet with Next up**, segmented *Next · Activity*
(`whats-next.md` §6).

- **Rows carry "Undo this"** for as long as the session's history holds them — this sheet
  is the phone's ⌘Z stack (`mobile.md` §8).
- **Row → fruit linkage still works:** tapping a row selects the step and retargets the
  sheet in place (150ms), the same beat as tapping the node.

## 6. Ownership map

| Concern | Owner |
|---|---|
| Beat physics (camera ease, pulse, toast) | `motion-language.md` |
| Absence on hosted/read-only pages | `responsive.md` |
| Chip, panel, rows, linkage, arrival conduct | **this doc** |
