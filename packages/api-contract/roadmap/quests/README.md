# Roadmap quest roster

`roster.json` is the roster: the nine quests, ready-made roadmaps a person starts from, as an array in the
order a shelf shows them. The file is the source. It is written by hand, nothing generates it, and the web
keeps no quest of its own: its shelf reads this file (`web/src/products/roadmap/quests/roster.js`). Every
value is plain, so nothing a quest plants is left for its reader to work out.

## A quest

| Field | Holds |
| --- | --- |
| `id` | The quest's stable name, a kebab-case slug. It is never shown; the web's `birth` event names the quest by it |
| `group` | `dev` or `life`: the shelf's row, *For developers* or *For everything else*. Each row keeps the roster's order |
| `estimate` | How long the quest takes, in the words shown beside its size |
| `source` | The community map the quest is adapted from, with its licence, or `null` |
| `plants` | The input of the domain's `CreateRoadmap` ([Actions](../domain/README.md#actions)), whole |

`plants` is `{title, kinds, steps: {steps, links}}`, and the rest of a quest lives there alone:

- `title` is the quest's name, on its card and on the roadmap it plants.
- `kinds` is its legend in order, each `{hue, label, description}`.
- `steps.steps` are its steps in authored order, each `{key, label, icon, color, description}`, with
  `links: [{url, label}]` where the step has web links. A `key` names the step within the quest, `color` is
  the hue of one of `kinds`, and `icon` is `sparkles` on the first step and `""` on every other. A web link
  is named by its address alone: its `label` is `""`.
- `steps.links` are pairs `[fromKey, toKey]`: the step `toKey` follows the step `fromKey`. They stand in the
  order of the step they lead to, and one step's in the order it follows them, as the domain places a step
  after the first it follows.
- The size shown beside a quest is the count of `steps.steps`. The file holds no other size.

A quest is planted by running `CreateRoadmap` with `plants` as it stands. The web does so where its room
reads the device's copy (`web/src/products/roadmap/room/ReplicaBirth.js`). Its two other roads,
`POST /v1/trees` and the device's lattice, take the same steps, links and kinds in the room's shape, each
kind under an id the web keeps beside its reading of the file (`KIND_IDS`).

## What every quest keeps

- One step follows nothing, and it is the first. Completing it opens at least two steps.
- Two to five kinds, no two of one hue, each hue one of `terracotta`, `olive`, `gold`, `brick`, `sky` and
  `plum`. Every kind is worn by a step, every step wears a kind's hue, and the first kind is the first
  step's.
- A step's `key` is a kebab-case slug no other step of the quest has, its `label` is 1 to 40 characters, and
  it has a `description`.
- The `estimate` names no hours or minutes.
- A quest, its kinds and its steps carry no field but those above.

## Words

Every string a person reads here is the English text itself, shown as it stands: a quest's `title` and
`estimate`, a kind's `label` and `description`, a step's `label` and `description`. None is a key and none
is in a catalog; the web shows them as data, as it shows a person's own step titles. A surface shows the
same words by showing these strings.

The words around a quest are each surface's own. On the web they are `roadmap.quests.*` in its catalogs:
the two row headings, the size sentence (`{count} steps · {estimate}`), the label of a card's button and the
line that credits the quests with a `source`.

## Who is held to it

`web/test/products/roadmap/quests/roster.test.js` names every file of this folder, holds the shelf to the
nine in order, compares each quest the shelf offers and the `CreateRoadmap` its birth makes
(`ReplicaBirth.creation`) with the file's quest, whole, and checks what every quest keeps.

Run from `web`: `node --test test/products/roadmap/quests/`.
