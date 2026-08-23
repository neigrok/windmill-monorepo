# System architecture — what travels to the next product

This doc separates **the family** from **the product**, so a sibling starts from a foundation
instead of a fork.

> **The test for every rule below:** if two products break it differently, do they still look
> like the same company? If yes, it belongs to the product. If no, it belongs to the family.

## 1. Four layers

| Layer | What's in it | Travels? |
|---|---|---|
| **L1 · Foundation** | the neutral ramp · surfaces, borders, text roles · type (Baloo 2 / Nunito / JetBrains Mono) · spacing 4→128 · radii 8→32 + pill · warm shadows · motion easings, durations, ceilings · voice & casing | **verbatim, except the ramp: each product owns its ground** (§4a). |
| **L2 · Kit** | Button · IconButton · Badge · Tag · Avatar · Card · Input · Select · Checkbox · Radio · Switch · Tooltip · Dialog · Toast · Tabs · ProgressBar, and their interaction laws | **verbatim, extendable.** New components are authored to the same laws (§3). |
| **L3 · Patterns** | one docked home per concern · sheet / panel / dock by breakpoint · toast-with-one-action · two-tier undo · the mobile priority ladder · empty-loading-offline grammar · auth (one door, magic link) · transactional email shell · the share-artifact family · pricing conduct | **as shapes.** The structure travels; the content is re-written per product. |
| **L4 · Product vocabulary** | the skill tree (radial + dagre), SkillNode / SkillConnector, kind × tier, the crown, halo & ember, TreePortrait, quests, tending, fork & lineage, bark & leaf tokens, the plant/grow/unlock verbs | **never.** A sibling authors its own L4 and inherits L1–L3 whole. |

**The commonest mistake is smuggling L4 into L2.** `SkillNode` looks like a component and is
really a product metaphor; `--kind-*` and `--color-bark/leaf` look like tokens and are really
roadmap's nouns. A sibling that has no categories must not ship `--kind-*`.

## 2. The colour contract

**Keep, always:** every surface / border / text token that reads through the neutral ramp, the
shadow tints, and the semantic bindings:

```
olive = success   gold = warning   brick = danger   sky = info
```

**Choose, once per product:** the brand hue — `--color-brand`, its hover/active,
`--color-brand-soft`, and the two link tokens. Six declarations, scoped as
`[data-brand="<name>"]` in `tokens/palettes.css` (the scope mirrors `[data-theme="dark"]`, and
the two compose). And its **ground**, per skin, to §4a.

**The brand hue may never double as a semantic hue.** An olive-branded product makes its
primary button indistinguishable from its success state. The brand comes from a non-semantic
hue (terracotta, plum) or from one new hue authored to the recipe in §4.

**One grandfathered exception, stated so nobody copies it:** white on `terracotta-500` measures
**3.92:1**, under the gate below. It is the brand in use and it stays; a *new* hue must clear
4.5 or darken its 500 until it does (plum measures 5.87, iris 6.29). Where brand text sits on a
light surface, use the **600** step — that is what the 600 is for.

**Never:** a vivid or "chemical" hue · a gradient as a background · a second brand hue in one
product · re-hued semantics.

## 3. Interaction laws (L2's real content)

- **Hover shifts the surface** (`--surface-hover` or the brand-soft tint) — never an opacity
  fade on a solid fill.
- **Press compresses to 0.97** — soft, never a bounce.
- **Borders are 1–1.5px warm neutral.** Never pure black, never a coloured left-border accent
  on a card.
- **Focus is the brand ring, and keyboard-only** (`:focus-visible`). Every control is operable
  from a keyboard.
- **Blur/translucency exists only on the modal overlay.**
- **One infinite loop per screen, at most** (`motion-language.md`'s calm ceiling); everything
  else resolves.
- **No spinners.** Waits are skeletons at the real height, or nothing at all below 400ms.
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

Each product owns its ground, in both skins. Name the place before the hue.

- **Roadmap · Tuscany at midday** — the family cream with terracotta, brick, plum, gold, sky
  and olive on it. The palette the whole system was derived from.
- **Journal · paper in north light, dusk with one candle** — the cool dusk ramp with one warm
  lamp on it.
- **Gym · pietra in the sun, basalt at night.**

```
TEMPERATURE   a cool ground carries a warm light, or a warm ground carries a cool
              one. NEVER two temperatures agreeing.
PLACE         name the place before the hue. A ground with no place behind it has
              no way to be judged and no way to be defended.
SHADOW        the ground is not only the canvas. Put the hue where the light would
              actually leave it: paper in north light is a near-white sheet with
              cool shadows, mids and ink — the sheet itself is not tinted.
BOTH SKINS    a room is one room at any hour. The same place, lit differently —
              not a warm day bolted onto a cool night.
WHOLE         the entire ramp, in luminance order — every surface / border / text
              role reads through var(--neutral-*), so they move together. Plus the
              two surfaces colors.css states as literals: --surface-sunken and
              --surface-overlay.
NEVER         the semantics. olive = success, gold = warning, brick = danger,
              sky = info, in every room, on every ground.
GATES         §4's contrast gates hold on the new ground: primary text ≥ 12:1,
              tertiary ≥ 4.5:1, brand-as-fill ≥ 4.5:1 against its own on-accent
              ink, brand-as-TEXT ≥ 4.5:1 on the ground (use the 600 step, §2).
              Measured from pixels, not assumed.
DEFAULT       clay keeps the family cream and the family night, and is what every
              surface belonging to no product stands on: the brand root, marketing,
              every specimen. It never moves when a product's room does.
```

A room that needs to look different gets a ground. A room that doesn't gets nothing — there is
no half-measure, no brand tint mixed into the shared ramp.

The family is therefore type, spacing, radii, shadows, motion, voice, the semantic bindings,
and this section's rules — not the warm ramp.

### The two grandfathered tertiaries

Two ramps do not clear the tertiary gate:

| ramp | `--text-tertiary` | on canvas | measured |
|---|---|---|---|
| family cream (`:root`, clay) | `#92805F` | `#F9F5EB` | **3.52:1** |
| journal's dusk | `#4D6472` | `#040D19` | **3.14:1** |

They stay, and they carry a usage rule that is not optional: at these two values
`--text-tertiary` is **non-essential ink only** — timestamps, units, meta, disabled states. It
may not carry navigation, labels, or anything a person has to read to use the room. The /app
shell's nav and tab labels use `--text-secondary` for this reason.

**A new ground gets no such licence.** 4.5 is the gate, measured on the real pixels.

## 5. Starting a sibling — the order that works

1. **Name the brand** and add a `[data-brand="…"]` block to `tokens/palettes.css` (six
   declarations, plus a ground block per skin). Set `data-brand` on `<html>`.
2. **Write the product's nouns and verbs** before any screen — roadmap's are plant / grow /
   unlock / step / tree. This is L4 and it drives every string.
3. **Inherit L1–L3 without editing them.** If a pattern doesn't fit, that's a finding for this
   doc, not a local override.
4. **Build the one screen the product is about** — the equivalent of the tree canvas — and only
   then the chrome around it.
5. **Mobile from the priority ladder** (`mobile.md` §1): list the jobs by how often they happen
   on a phone, decide which surface is primary, *then* lay out.
6. **Empty, loading and offline states before the happy path is polished.**
7. **One verb per page.** If a screen has two primary actions, one of them is a different
   screen.
8. **Voice pass:** read every string aloud; cut it to one idea; check no default is being sold
   back to the user.
9. **Register what's new** — a sibling's L4 goes in its own `guidelines/` doc with its own spec
   code, never inside an existing one.
10. **Report back what didn't fit.** Two products disagreeing about the same pattern is the
    signal to promote or split it here.

## 6. What roadmap owns (the worked example)

| Inherited (L1–L3) | Roadmap's own (L4) |
|---|---|
| Neutrals, type, spacing, radii, shadows, motion, voice | The skill-tree metaphor and its layout contract |
| The whole component kit | SkillNode · SkillConnector · KindLegend · Checklist |
| Sheet/panel/dock, toasts, undo, empty & loading states | Kinds as user vocabulary; kind × tier decoupling |
| Auth, email shell, pricing conduct | The share family (portrait · video · diff poster) |
| The mobile priority ladder and gesture registry | Tending, quests, forking, the crown and the halo |

A sibling should be able to read the left column and build; the right column is a case study,
not a requirement.
