# System architecture — what travels to the next product

Windmill was the first product built on this system; two more are coming in
almost the same style. This doc separates **the family** from **the product**, so
a sibling starts from a foundation instead of a fork. Live proof:
`explorations/system-layers.html`.

> **The test for every rule below:** if two products break it differently, do
> they still look like the same company? If yes, it belongs to the product. If
> no, it belongs to the family.

## 1. Four layers

| Layer | What's in it | Travels? |
|---|---|---|
| **L1 · Foundation** | the warm neutral ramp *by day* · surfaces, borders, text roles · type (Baloo 2 / Nunito / JetBrains Mono) · spacing 4→128 · radii 8→32 + pill · warm shadows · motion easings, durations, ceilings · voice & casing | **verbatim by day; at night each product owns its ground** (§4a, rewritten 2026-08-07). Everything else here is what makes a product stop being family. |
| **L2 · Kit** | Button · IconButton · Badge · Tag · Avatar · Card · Input · Select · Checkbox · Radio · Switch · Tooltip · Dialog · Toast · Tabs · ProgressBar, and their interaction laws | **verbatim, extendable.** New components must be authored to the same laws (§3). |
| **L3 · Patterns** | one docked home per concern · sheet / panel / dock by breakpoint · toast-with-one-action · two-tier undo · the mobile priority ladder · empty-loading-offline grammar · auth (one door, magic link) · transactional email shell · the share-artifact family · pricing conduct | **as shapes.** The structure travels; the content is re-written per product. |
| **L4 · Product vocabulary** | the skill tree (radial + dagre), SkillNode / SkillConnector, kind × tier, the crown, halo & ember, TreePortrait, quests, tending, fork & lineage, bark & leaf tokens, the plant/grow/unlock verbs | **never.** This is what makes Windmill *Windmill*. A sibling authors its own L4 and inherits L1–L3 whole. |

**The commonest mistake will be smuggling L4 into L2.** `SkillNode` looks like a
component and is really a product metaphor; `--kind-*` and `--color-bark/leaf`
look like tokens and are really Windmill's nouns. A sibling that has no
categories must not ship `--kind-*`.

## 2. The colour contract

**Keep, always:** the neutral ramp (this is the single loudest family signal —
warm cream to warm near-black, never a cold gray), every surface / border / text
token that reads from it, the shadow tints, and the semantic bindings:

```
olive = success   gold = warning   brick = danger   sky = info
```

**Choose, once per product:** the brand hue — `--color-brand`, its hover/active,
`--color-brand-soft`, and the two link tokens. Six declarations, scoped as
`[data-brand="<name>"]` in `themes/brands.css` (the scope mirrors
`[data-theme="dark"]`, and the two compose). And its **ground**, per skin, to §4a.

**The brand hue may never double as a semantic hue.** An olive-branded product
makes its primary button indistinguishable from its success state. So the brand
comes from a non-semantic hue (terracotta, plum) or from one new hue authored to
the recipe below. `themes/brands.css` ships `clay` (Windmill's default), `plum`
(built from a hue the palette already holds) and `iris` (the worked example of a
new one).

**One grandfathered exception, stated so nobody copies it:** white on
`terracotta-500` measures **3.92:1**, under the gate below. It is the shipped
brand and it stays; a *new* hue must clear 4.5 or darken its 500 until it does
(plum measures 5.87, iris 6.29). Where brand text sits on a light surface, use
the **600** step — that is what the 600 is for.

**Never:** a cold gray neutral by day (nights are §4a's, and two of them are grey now) · a vivid or
"chemical" hue · a gradient as a background · a second brand hue in one product ·
re-hued semantics · a surface tint past §4b's budget.

## 3. Interaction laws (L2's real content)

These are why the kit feels like one kit, and they are cheaper to keep than to
re-decide:

- **Hover shifts the surface** (`--surface-hover` or the brand-soft tint) — never
  an opacity fade on a solid fill.
- **Press compresses to 0.97** — soft, never a bounce.
- **Borders are 1–1.5px warm neutral.** Never pure black, never a coloured
  left-border accent on a card.
- **Focus is the brand ring, and keyboard-only** (`:focus-visible`). Every
  control is operable from a keyboard — a consent control that needs a mouse is
  not shippable.
- **Blur/translucency exists only on the modal overlay.**
- **One infinite loop per screen, at most** (`motion-language.md`'s calm ceiling);
  everything else resolves.
- **No spinners.** Waits are skeletons at the real height, or nothing at all
  below 400ms.
- **Sentence case everywhere · no emoji · second person · one idea per sentence.**

## 4. Authoring a new hue

Only when the product's brand can't come from the existing set.

```
STEPS   50 · 100 · 200 · 400 · 500 · 600 · 700   (500 = base, 200 = soft fill,
        600 = ink on its own 50, 700 = pressed)
CHROMA  muted toward earth — sit it beside terracotta and olive; if it looks
        brighter than both, it is wrong
HUE     ≥40° from every existing accent, and clear of sky (200°) and brick (15°)
        so it can never be read as "info" or "danger"
PROOF   600 on its own 50 ≥ 4.5:1 (the hue as text on a light surface)
        white on 500 ≥ 4.5:1 — CTA labels here are 12–14px bold, which WCAG
        still counts as body text, so 3:1 is not enough
        dark brand = the LIGHTEST ramp step that clears 4.5:1 against
        --text-on-accent (#1B1408): clay 400 · plum 300 · iris 300
```

## 4a. Grounds — each product names a place

**Rewritten twice on 2026-08-07**, which is itself the useful record. It began as "exactly one
product may re-point the neutral ramp, and only under its dark scope" (journal, the night
exception). It became "each product owns its ground at night". It is now this, and the reason
for the last move is the one that matters: **the products that failed were the ones given a hue
instead of a place.**

Two palettes were designed before this doc existed and neither was ever in question:

- **Roadmap · Tuscany at midday** — the family cream with terracotta, brick, plum, gold, sky and
  olive on it. This is the palette the whole system was derived from.
- **Journal · night and candles** — the cool dusk ramp with one warm lamp on it.

The other four were never thought through, and it showed: gym went through warm soil, a
steel-tinted soil, graphite and cement in a single day, and roadmap through forest, before
anyone asked what *place* either room was in. The rule both good palettes were already keeping,
written down at last:

```
TEMPERATURE   a cool ground carries a warm light, or a warm ground carries a cool
              one. NEVER two temperatures agreeing — that is what made cement and
              graphite mud, and it is the whole reason journal's night works.
PLACE         name the place before the hue. A ground with no place behind it has
              no way to be judged and no way to be defended: "not brown" is not a
              design. Roadmap is Tuscany at noon and the embers after it; journal
              is paper in north light and dusk with one candle; gym is pietra in
              the sun and basalt at night.
SHADOW        the ground is not only the canvas. Journal's day took three tries
              because the first two tinted the SHEET; what makes paper look like
              paper in north light is a near-white sheet with cool shadows, mids
              and ink. Put the hue where the light would actually leave it.
BOTH SKINS    a room is one room at any hour. The same place, lit differently —
              not a warm day bolted onto a cool night.
WHOLE         the entire ramp, in luminance order — every surface / border / text
              role reads through var(--neutral-*), so they move together. Plus the
              two surfaces colors.css states as literals: --surface-sunken and
              --surface-overlay.
NEVER         the semantics. olive = success, gold = warning, brick = danger,
              sky = info, in every room, on every ground. They are the last shared
              colour language, and they are why a Done chip means the same thing
              in a quarry as in a garden.
GATES         §4's contrast gates hold on the new ground: primary text ≥ 12:1,
              tertiary ≥ 4.5:1, brand-as-fill ≥ 4.5:1 against its own on-accent
              ink, brand-as-TEXT ≥ 4.5:1 on the ground (use the 600 step, §2).
              Measured, not assumed — the palette card reads them from pixels.
              TWO GRANDFATHERED TERTIARIES, stated so nobody copies them: see below.
DEFAULT       clay keeps the family cream and the family night, and is what every
              surface belonging to no product stands on: the brand root, marketing,
              every specimen. It never moves when a product's room does.
```

What this costs, stated plainly: **the warm ramp is no longer what the products have in
common.** The family is now type, spacing, radii, shadows, motion, voice, the semantic bindings,
and this section's rules. That is a real loss, taken deliberately, because three rooms in one
shell have to be tellable apart on sight and a hue you only meet on a button cannot do it.

### The two grandfathered tertiaries

Four of the six shipped grounds clear the tertiary gate (5.25–5.35). **Two do not, and both are
in the palettes that predate this section** — the ones that were right and were deliberately not
re-tuned:

| ramp | `--text-tertiary` | on canvas | measured |
|---|---|---|---|
| family cream (`:root`, clay) | `#92805F` | `#F9F5EB` | **3.52:1** |
| journal's dusk | `#4D6472` | `#040D19` | **3.14:1** |

They stay, for the same reason §2 keeps white-on-terracotta at 3.92: they are shipped, they are
load-bearing, and re-authoring a tuned ramp to win half a point is a worse trade than naming the
exception. What comes with them is a **usage rule, and it is not optional**: at these two values
`--text-tertiary` is *non-essential ink only* — timestamps, units, meta, disabled states. It may
not carry navigation, labels, or anything a person has to read to use the room. That is why the
/app shell's nav and tab labels moved to `--text-secondary`, and why the palette card no longer
paints tertiary at all.

**A new ground gets no such licence.** 4.5 is the gate, measured on the real pixels.

## 4b. Room tint — retired the day it was written

Recorded rather than deleted, because it is the kind of idea that gets re-invented. §4b let a
product mix its brand hue into its four surface roles at ≤6% while the ramp stayed put — a way
to differentiate rooms without giving any of them a ground. Two tints shipped under it (journal's
parchment, gym's daylight rack) and both are gone within the day: once a room names a place, the
place authors the whole ramp and a 6% cast on the family cream is neither one thing nor the
other. **If a room needs to look different, give it a ground (§4a). If it doesn't, give it
nothing.** The half-measure is what produced cement.

## 5. Starting a sibling — the order that works

1. **Name the brand** and add a `[data-brand="…"]` block to `themes/brands.css`
   (six declarations, plus a dark pairing). Set `data-brand` on `<html>`.
2. **Write the product's nouns and verbs** before any screen — Windmill's are
   plant / grow / unlock / step / tree. This is L4 and it drives every string.
3. **Inherit L1–L3 without editing them.** If a pattern doesn't fit, that's a
   finding for this doc, not a local override.
4. **Build the one screen the product is about** — the equivalent of the tree
   canvas — and only then the chrome around it.
5. **Mobile from the priority ladder** (`mobile.md` §1): list the jobs by how
   often they happen on a phone, decide which surface is primary, *then* lay out.
6. **Empty, loading and offline states before the happy path is polished** —
   X3's grammar makes them cheap and they are where a new product feels unfinished.
7. **One verb per page.** If a screen has two primary actions, one of them is a
   different screen.
8. **Voice pass:** read every string aloud; cut it to one idea; check no default
   is being sold back to the user.
9. **Register what's new** — a sibling's L4 goes in its own `guidelines/` doc with
   its own spec code, never inside an existing one.
10. **Report back what didn't fit.** Two products disagreeing about the same
    pattern is the signal to promote or split it here.

## 6. What Windmill owns (the worked example)

| Inherited (L1–L3) | Windmill's own (L4) |
|---|---|
| Neutrals, type, spacing, radii, shadows, motion, voice | The skill-tree metaphor and its layout contract |
| The whole component kit | SkillNode · SkillConnector · KindLegend · Checklist |
| Sheet/panel/dock, toasts, undo, empty & loading states | Kinds as user vocabulary; kind × tier decoupling |
| Auth, email shell, pricing conduct | The share family (portrait · video · diff poster) |
| The mobile priority ladder and gesture registry | Tending, quests, forking, the crown and the halo |

A sibling should be able to read the left column and build; the right column is
a case study, not a requirement.
