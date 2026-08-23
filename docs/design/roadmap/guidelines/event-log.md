# Windmill Event log — the activity feed

The canonical spec for the log of recent tree activity: where it lives, what
logs, and how rows link back to the canvas. Graduated from
`explorations/event-log-options.html` (its ★ verdict — option A″). Motion
physics come from `motion-language.md`; toast + pulse behavior on arrival
cites the beats, never reinvents them. Live specimens:
`explorations/event-log-options.html`.

> **Principle: the moment lives on the graph; the log is the receipt.** The
> canvas runs full-bleed by default — the feed is summoned, never squatting.

---

## 1. Placement — summoned is the default, pinned is the preference

- **A labeled chip in the canvas toolbar** (top-right, by the zoom controls).
  *Label amended by `whats-next.md`:* **"Next · N"** (ready count) with an
  unseen-activity dot; at 0 ready it falls back to "Activity · N". The badge
  counts **only events since your last open** — never a nagging persistent dot.
- **Open = a zero-reflow overlay** sliding over the canvas's right edge: the
  tree never reflows, no camera jump, closing costs nothing. × or any canvas
  click closes it; the chip stays put, so re-summoning is one click.
  *Amended by `whats-next.md`:* the dock now stacks two tenants — **NEXT UP
  leads, ACTIVITY follows** — one scroll, same grammar.
- **A pin in the panel header docks it persistently** — pinned mode is the
  old "option A", for wide screens and heavy shared sessions.
- **Editor surfaces only.** Read-only/hosted pages (X5) have no toolbars —
  the feed never mounts there.
- **Keyboard:** one shortcut toggles it (`a`); esc closes. Focus moves into
  the panel on open, back to the canvas on close.

## 2. What logs — and what never does

| Logs | Never logs |
|---|---|
| step started · step completed (+ the unlocks it causes) · step added / renamed / removed | pans, hovers, selections, readout recalcs |

- **Object = a node.** The step name carries its kind-hue dot — the same hue
  the fruit wears. Removed steps lose their dot, mute, and strike through.
- **Time, tertiary:** relative, abbreviated, mono — "2h", "1d", no "ago".
  Day separators (Today / Yesterday) carry the calendar.

## 3. Row ↔ fruit linkage

- **Hover a row** → its node + branches light; the rest of the tree dims to
  ~30% (150ms, feedback-class).
- **Click a row** → the camera glides to the node (motion doc's camera ease,
  480ms `--ease-soft`) + a terracotta focus ring. The log never edits — it
  points.

## 4. Arrivals — closed ≠ deaf

- **While closed:** the moment plays on the graph — the toast speaks and the
  fruit pulses in its kind glow (motion §crown/pulse); the badge counts what
  you haven't seen. Nothing is missed.
- **While open:** new rows slide in at the top with a brand-soft flash fading
  over ~1.4s; the node still pulses. Arrival is felt on the graph first,
  receipted in the list second.
- **Opening replays unread rows** with the same flash (catch-up).
- **With the step panel:** selecting a fruit while the feed is open swaps the
  overlay to step details; closing details returns to the feed only if it was
  open before — otherwise everything closes and the canvas is clean.

## 5. Held / skipped (from the exploration's verdict)

- **On-graph event chips (F):** delightful but unaccountable — revisit as an
  optional ambient toggle once real usage shows how noisy shared trees get.
- **Console strip (D): skipped.** It answers audit questions this audience
  isn't asking, in a register that fights the garden. A true audit need would
  be a "History" view behind the chip, not a permanent dock.

## 6. Constants — copy into the build

```
CHIP      canvas toolbar, top-right · "Activity · N" · badge = unseen only
PANEL     overlay over right edge · zero reflow · pin → docked (wide screens)
ROWS      kind dot + step name · mono relative time ("2h") · day separators
LINK      hover row → node+branches lit, rest dims ~30% · click → camera 480ms
ARRIVAL   toast + kind pulse on graph · row flash ~1.4s · badge while closed
KEYS      `a` toggles · esc closes · focus in on open, back on close
NEVER     read-only surfaces · logging pans/hovers/selections · edits from rows
```

## 7. Ownership map

| Concern | Owner |
|---|---|
| Beat physics (camera ease, pulse, toast) | `motion-language.md` |
| Step panel interplay, selection rules | editing spec v2 (`explorations/dag-editing-interactions-v2.html`) |
| Absence on hosted/read-only pages | `responsive.md` (X5) |
| Chip, panel, rows, linkage, arrival conduct | **this doc** |

## Phone (X8)

There is no canvas toolbar on a phone (X5 §2 — five pieces, no toolbars), so the
Activity chip has no home there. **Activity shares the return-visit sheet with
Next up**, segmented *Next · Activity* (`whats-next.md` §6). Two consequences:

- **Rows carry "Undo this"** for as long as the session's history holds them —
  this sheet is the phone's ⌘Z stack (`mobile.md` §8).
- **Row → fruit linkage still works**: tapping a row selects the step and
  retargets the sheet in place (150ms), the same beat as tapping the node.
