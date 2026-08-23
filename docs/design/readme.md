# Design canon — the written half

Guidelines, briefs, and the drift ledger. This is **what should be, and why**.

The **drawings** live in five Figma files — what IS, rebuilt from the shipped stylesheets
rather than from a mockup:

| File | Key |
|---|---|
| Windmill · Design System (the published library) | `qoOwNbWOYE1GFi0yR5uGY2` |
| Windmill · Roadmap | `HM4d8YWzJZg5clVRJKNuDr` |
| Windmill · Journal | `pC6ciOUnfLmI42oMihd7l3` |
| Windmill · Gym (web · iOS · Android) | `vdmdiKWrmZoS1FtcvJRf6O` |
| Windmill · Marketing | `uWLMdVmzTcobOh8hbeem81` |

**The split is the rule: Figma records what IS; these docs record what should be and why.**
A screen is drawn in Figma. A decision, a constraint, an open question, or the reason behind
either is written here. Neither is the other's backup.

## Where this came from

Until 2026-08-23 both halves lived in a claude.ai Design project (`a8e8995c…`). The drawings
moved to Figma; the writing moved here; the project is **retired** — do not go back to it, and
do not stand up a third home.

Two things did not come with it, by owner decision on the day: the ~36 **explorations** (the
alternatives considered and rejected) and the `uploads/` folder (photos and sketches behind
some decisions). They were **dropped deliberately, not lost** — worth knowing if you go looking
for the reasoning behind a call and find only the call.

## What is here

| Path | Holds |
|---|---|
| `consistency.md` | **The drift ledger — start here for consistency work.** F1–F36 open, plus a long closed history. |
| `guidelines/` | Brand-wide: the motion language, the superapp shell and journey, the four-layer system architecture, thumb reach. |
| `roadmap/` | 20 feature guidelines + the open-asks briefs. The largest set — roadmap is the oldest product. |
| `journal/` | The product canon and the first-run canon. |
| `gym/briefs/` | `00-README` plus context and G1–G8. Creation briefs — gym had no canon to reconcile against. |
| `marketing/` | The landing-family briefs (00–03), the pricing story, the transactional-email spec. |
| `AUTHORING.md` | Two rules that bind anyone drawing a Windmill screen: phone reach, and entering a product room by scope rather than by value. |
| `brand-identity-brief.html` | The logo brief. **No logo has ever been drawn** — every mark is still the Baloo wordmark. |

## Read a brief for intent, not for status

**A brief's own "Status:" line lies**, and this has cost real time. `gym/briefs/02-G1-set-logger.md`
still opens "no canon exists. This is the brief that matters most" — the surface it asks for was
fully designed and shipping when that line was read and believed. A designer who ships canon does
not go back and edit the brief that asked for it.

So: **the repo and the Figma file say what exists; a brief says what was intended.** Several files
here are months old and some of their claims are known to be stale — `docs/DESIGN_BRIEFS.md`
records the ones we know about.

## The convention these docs are written to

Where canon leans on a mechanism that already exists, it says **"this must be true"**, never
"this is true." The second phrasing reads as a description, and a description nobody checks can
be false for a whole release without anyone noticing — `roadmap/guidelines/gallery.md` §6 once
asserted that ranking handled abandoned trees while the column it ranked on ignored progress
marks entirely. Requirement phrasing is what tells the build side a line is load-bearing.

The same rule carries the standing one from the root `CLAUDE.md`: **a line that stops being true
is fixed in the wave that made it false.** That is why moving these files also meant correcting
twelve pointers across nine other files in the repo.
