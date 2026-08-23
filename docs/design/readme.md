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
| `design-system-readme.md` | The Design System project's own readme, carried whole. Its brand foundations (voice, colour behaviour, type, iconography, the no-invented-logo policy) are canon; its *layout* sections describe the retired project and are history. |

## Reading a citation — these files point at a project that is gone

**These 54 files were carried verbatim, so their internal citations were not rewritten.** There
are ~174 of them and they name paths that exist nowhere in this repo. That is deliberate —
editing canon while moving it is how you lose it — but it means you have to know how to resolve
a reference. Use this table.

| A doc says | It means | Resolves to |
|---|---|---|
| `templates/…/X.dc.html` · `journal/…dc.html` | a design board | the matching page in that product's **Figma file** |
| `guidelines/*.card.html` | a token/type/motion specimen card | the **Foundations** page of the Figma library |
| `explorations/*.html` | an exploration | **gone** — dropped on purpose (see above). The citation is dead; the ruling it produced is usually in the `guidelines/` doc beside it |
| `tokens/*.css` · `../tokens/` | the token source | `web/src/styles/tokens/` |
| `themes/brands.css` | the per-product brand blocks | `web/src/styles/tokens/palettes.css` |
| `components/…` · `../components/` | the component kit | `web/src/design-system/` |
| `roadmap/components/tree/…` | the tree components | `web/src/products/roadmap/ui/tree/` |
| `ui_kits/marketing/*.html` | the shipped static pages | `web/public/` |
| `ui_kits/email/*` | the mail templates | `web/emails/` |
| `_ds_kit.js` · `_ds_bundle.js` · `MOVED.md` | project plumbing | **gone**, and nothing replaces them |
| `19f67675…` `99259a8c…` `7f9591c1…` `5b6ff5b3…` | the four pre-2026-07-31 satellite projects | dead, and dead before this move |

**In every case the repo is the truth and Figma is the picture.** A citation is a pointer to
intent, not evidence that something exists.

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
fourteen pointers across eleven other files in the repo — including two the first sweep missed,
because it only searched `.md` and `.txt` and the stragglers were in a `.css` and a `.swift`.
