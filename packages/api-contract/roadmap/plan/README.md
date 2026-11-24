# Roadmap plan cases

Each JSON file holds `{name,input,expect}` cases of the plan grammar: a pasted text read to a plan, a plan turned into
the input of the domain's `CreateRoadmap` and `ImportSteps` ([the domain corpus](../domain/README.md#actions)), and a
roadmap written as Markdown and read back. The web's grammar (`web/src/products/roadmap/paste/planGrammar.js` and
`graftPlan.js`) is its one implementation; the web corpus (`web/test/products/roadmap/paste/corpus.test.js`) claims
every file by name and compares complete outputs. No operation reads storage, time, randomness or localization, and no
result holds a sentence: a surface words the values a case names. A rule changes here as a case first.

| File | Operation | Input | Complete result |
|---|---|---|---|
| `read.json` | A text read for a new roadmap | `{text, kinds}`, `kinds` the legend the plan starts from | the plan |
| `read-into.json` | A text read into a roadmap | `{text, kinds}`, `kinds` the roadmap's own | the plan, with no kind of the roadmap renamed |
| `create-roadmap.json` | A text and a typed name to a creation | `{text, kinds, name}` | `{CreateRoadmap: {title, steps: {steps, links}, kinds}, Complete: [key]}`, or `null` |
| `import-steps.json` | A text into a roadmap under a step | `{text, kinds, under, held}` | `{ImportSteps: {imported: {steps, links}, under, done?}, CreateKind: [{hue, label, description}]}`, or `null` |
| `write.json` | A roadmap written, and the text read back | `{title, guide?, kinds, nodes, done, readOver}` | `{text, readBack}` |

A kind is `{id, hue, label, description}`. A hue is one of `terracotta`, `olive`, `gold`, `brick`, `sky`, `plum`: the
palette, in its order. A key written with `?` is absent where it has nothing to say, never `null`.

Run from `web`: `node --test test/products/roadmap/paste/corpus.test.js`.

## Text

These six rules hold everywhere below. They are written out so that no platform's own string functions are needed, or
trusted, to reproduce them.

- **Equality.** Two texts are equal when their Unicode scalar values are equal, one by one. Nothing is normalized:
  `é` (U+00E9) and `e` with U+0301 are different names, on a line, among the names of a plan and against a kind's label.
  The cases hold no unpaired surrogate, and what the grammar makes of one is not specified.
- **Clip.** A bound counts UTF-16 code units. A text over its bound keeps the bound's units, or one fewer where the
  last unit kept would be the first half of a surrogate pair. The bounds are 200 for a plan's name, 24 for a kind's
  label and 40 for an id.
- **Whitespace** is exactly the set of [the domain kit](../../../../docs/foundation/domain-kit.md) §4.3: U+0009–U+000D,
  U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. To trim is to remove it
  from both ends. U+0085, U+180E and U+200B are not whitespace.
- **Digits** are the ten ASCII digits. A number is never read as a number: only its digits are recognised.
- **Lowercase** is `String.prototype.toLowerCase`: Unicode's default lowercase of each scalar by its full mapping, with
  no locale, so U+0130 becomes U+0069 U+0307; and a capital sigma with a cased letter before it and none after it
  (Unicode's `Final_Sigma`) becomes the final sigma U+03C2.
- **Order.** Nothing is sorted. Every list is in the order of the text's lines, or of the input it was made from.

## Lines

A text is cut into lines at each CRLF, CR or LF, a CRLF being one cut and an LF followed by a CR two. Nothing else ends
a line. A text with no cut is one line, the empty text included, and a text that ends with a cut has an empty last line.

A line's indent is the run of spaces and tabs at its start, counted in columns: a space is one, a tab two. Its body is
what follows the indent. A line is the first of these its body fits:

| Line | Body | It gives |
|---|---|---|
| blank | empty, or whitespace alone | nothing |
| heading | one to six `#`, then whitespace, then a content that, trimmed, is not empty and holds neither U+2028 nor U+2029 | its depth, the count of `#`, and that content |
| item | a marker, then whitespace as far as it runs, then a rest that holds neither U+2028 nor U+2029 | whether it is numbered, whether it is done, and its name |
| text | anything else | its body, trimmed |

An item's marker is `-`, `*`, `•` (U+2022), or one or more digits followed by `.` or `)`; the last two are numbered.
Where its rest begins with `[`, then a space, `x` or `X`, then `]`, that box is taken off: the item is done where the
box holds `x` or `X`, and its name is what follows the box, trimmed. Otherwise its name is its rest, trimmed. A name
may be empty.

The indent unit is the column count of the first item or text line whose indent is not zero, or 2 where there is none;
headings and blank lines never set it. A line's level is its columns divided by the unit, rounded down, and the line is
ragged where the division leaves a remainder.

## Reading

`read` and `read-into` give the plan: `{title, missingRoot, nodes, kinds, gutter, readout, imperfections}`.

**The name.** The first line that is not blank names the plan where it is a heading of depth 1 or a text line: `title`
is its content, clipped at 200, and `missingRoot` is false. Any other first line, or none, leaves the plan unnamed:
`title` is empty and `missingRoot` true. The plan's first node stands for the name: its label is the title, it follows
nothing, and no line of the gutter is its own where the plan is unnamed.

**Kinds.** The plan's kinds begin as the input's, in their order, each with `source: existing`. The current hue begins
as the first kind's, or `terracotta` where there is none, and the first node wears it. A heading claims a kind by its
content, trimmed, and the kind's hue becomes the current hue:

1. It binds the first kind whose label is not empty and, trimmed and lowercased, equals the heading lowercased.
2. Otherwise, in `read` only, it takes over the first kind that is still `existing` and that no heading has yet bound
   or taken over: the kind's label becomes the heading clipped at 24, its description empty and its source `relabeled`.
3. Otherwise it adds a kind in the first hue of the palette no kind wears: `source: added`, the heading clipped at 24,
   an empty description, and for its id the heading's id form (below) or `kind` where that is empty, counted up
   (`-2`, `-3`, …) past the ids the kinds hold.
4. Otherwise, every hue being worn, it uses the kinds in their order, one for each such heading, round again from the
   first, and changes none.

A label is compared as it stands in the kind, so a heading longer than 24 units does not bind the kind it made.

**Steps.** After the name's line, each line that is not blank is read in order:

- A heading claims its kind, adds a node (a branch) whose label is its content and which follows the first node, and
  closes every open step. Its depth and its indent change nothing.
- An item adds a node (a step) wearing the current hue. Where it is ragged it takes the liberty `{type: clamp,
  indent: ragged}`. Its level is at most one more than the level of the last open step, or 0 where none is open; a
  deeper one is brought down to that and takes `{type: clamp, indent: jump}`. Every open step at its level or deeper
  is closed. It then stands under the last open step, or the last branch, or the first node where there is no branch,
  and follows it; except that a numbered item follows the step just closed at its own level where that step was
  numbered and stood under the same node. The item is then the last open step.
- A text line belongs to the node made last. Where it is `http://` or `https://`, in lower case, followed by one or
  more characters of which none is whitespace, it is one of that node's links; otherwise one of its notes. Either way
  it takes the liberty `{type: note}`.

**Names and ids.** In node order, a node whose label is not empty and equals the label an earlier node ended with is
renamed `label (2)`, or `(3)` and on until no node has that label, and takes `{type: rename, label}` with its new
label. A node's id is its label's id form: the label lowercased, each run of characters other than `a` to `z` and `0`
to `9` made one `-`, a `-` at either end dropped, the result clipped at 40, and a `-` at its end dropped again. Where
that is empty the id is `root` for the first node and `step` for any other, and an id a node already has is counted up
(`-2`, `-3`, …).

**The plan.**

| Field | Holds |
|---|---|
| `nodes` | each node as `{id, label, color, prerequisites, icon?, status?, description?, links?}`: `color` its hue, `prerequisites` a list of the id of the node it follows, or empty, `icon` `sparkles` on the first node alone, `status` `complete` on a done item alone, `description` its notes joined by LF, `links` its addresses |
| `kinds` | each kind as `{id, hue, label, description, source}` |
| `gutter` | one entry for each line, `{mark, nodeId, liberties}`: `mark` is `root` for the name's line, `branch`, `step`, `done` for a done item, or `note`; `nodeId` the node the line made or belongs to; `liberties` what was taken on it, in the order clamp ragged, clamp jump, rename. A line that made nothing is `{mark: null, nodeId: null, liberties: []}` |
| `readout` | `steps`, the count of nodes, the unnamed first node included; `branches`; `done`, the count of done nodes |
| `imperfections` | the count of liberties by type: `notes`, `clamps`, `renames`. An address counts among the notes |

**A marked file.** A named plan whose first line after the name that is not blank has the content
`<!-- windmill:roadmap -->` is a file the grammar wrote. That line is read as blank, and:

- No node stands for the name, so the first step is the first node, and a step under no open step follows nothing.
  Where the name's line is a text line whose content is `#`, the title is empty. Text before the first step belongs to
  no node and is dropped.
- A guide is read past: where the first line after the marker that is not blank has the content
  `<!-- windmill:guide -->` and a later line the content `<!-- /windmill:guide -->`, those two lines and every line
  between them are blank.
- A heading adds no node. Where its content ends with `<!-- windmill:kind HUE -->`, alone or after a label and one
  space, the current hue becomes `HUE`, claimed with that label where there is one. Any other heading claims its kind
  as above.
- An item's name ends at the first ` <!-- windmill:kind HUE` that is followed to the end of the line by ` -->`, or by
  a space, a label and ` -->`. The current hue becomes `HUE`, claimed with the label where there is one, the label's
  entities read first; a heading's label is taken as it stands. A name that is empty has no such marker read.
- A kind claimed with a hue binds only a kind of that hue (rule 1). Failing that, in `read` it takes over the first
  kind wearing the hue, whatever its source, and adds one in that hue where none wears it; in `read-into` it is
  claimed by its label alone where a kind wears the hue, and added in that hue where none does.
- Each item's name then has its entities read: `&#38;` `&#60;` `&#62;` `&#13;` `&#10;` `&#45;` are `&`, `<`, `>`, CR,
  LF and `-`, and no other entity is read.
- No label is renamed, so duplicate names stand.

## Creating

`create-roadmap` reads the text as `read` does and names the roadmap. A plan with a name of its own keeps it, and the
typed `name` is not used. A plan with none takes the typed name, trimmed and clipped at 200, for its title and for the
label of its first node; where that is empty the result is `null`, and nothing is created. A marked file is a named
plan, whatever its title.

`CreateRoadmap` is the action's input: `title`; in `steps.steps`, each node as `{key, label, icon, color,
description?, links?}`, `key` its id, `icon` empty on every node but the first, and each address as
`{url, label: ""}`; in `steps.links`, `[the key it follows, its key]` for each node that follows one; and `kinds`, the
plan's kinds as `{hue, label, description}`, or `null` where they are none or exactly the genesis kinds (`terracotta`
*Build* "Things you make", `olive` *Learn* "Things you figure out", `gold` *Milestone* "Moments that matter", in that
order). `Complete` is the key of each done node, in node order: a surface runs `Complete {tree, step}` for each, with
the id the creation gave that key. The grammar clips a plan's name and a kind's label and no other value, so the
domain can refuse what a text derives: a step name over its bound refuses the whole creation.

A surface decides when a plan may be created. The web's composer offers it only while the text holds something other
than whitespace, and shows its name field only for a plan with no name.

## Importing

`import-steps` reads the text as `read-into` does. The steps that land are every node of a named plan or of a marked
file, and every node but the first of an unnamed plan. Where none lands the result is `null`: neither action is run,
and no kind is made.

`ImportSteps` is the action's input without its `tree`: each landing step as `{key, label, icon: "", color,
description?, links?}`; in `imported.links`, each link between two landing steps; `under`, the step given; and `done`,
the key of each landing step the plan brings done, in node order, where there is one. The domain puts every imported
step that follows no other under `under`, so the first node of a named plan, each first step of a marked file and each
step that followed the unnamed first node all follow it, and marks each step of `done` complete in the same act, so
the steps arrive done as a roadmap planted from the plan has them, and one Undo takes back the steps and their marks.
`held` is the id of every step the roadmap holds, deleted ones included. A key is the node's id, counted up (`-2`,
`-3`, …) past the held ids and the keys given before it: the domain mints each step's own id, and a key that never
equals a held id can stand in one list with them, as the web's gesture lists both. `CreateKind` is each kind the plan
added, as `{hue, label, description}`, in the plan's order.

## Writing

`write` gives `text`, lines joined by LF with none after the last, and `readBack`, that text read as `read` reads it
over `readOver`. `nodes` are the roadmap's steps as `{id, label, color, prerequisites, description?, links?}` in the
order to write them, `links` each `{url, label}`; `done` is the id of each step to mark.

1. `# ` and the title, as it is.
2. `<!-- windmill:roadmap -->`.
3. Where the guide holds a character that is not whitespace: `<!-- windmill:guide -->`; each of its lines, cut as a
   text's are, as `> ` and the line, or `>` alone for an empty one; then `<!-- /windmill:guide -->`.
4. The steps. A step whose first prerequisite the roadmap holds is written under that step; any other is a first step.
   First steps are written in their order, each followed by the steps under it in their order, and so on down, two
   spaces deeper each level. A step under a step that is never reached this way, as on a loop, is not written.

A step's line is `- `, then `[x] ` where `done` holds its id, then its label, then its kind marker where its colour is
not that of the step written before it, the first step always: ` <!-- windmill:kind COLOUR -->`, or
` <!-- windmill:kind COLOUR LABEL -->` where the last kind of `kinds` wearing that colour has a label. Under the
step's line, one level deeper, come the lines of its description, cut at LF alone and written as they are; then
`needs also: ` and, joined by `, `, the label of every prerequisite but the first, and of the first too where the
roadmap does not hold it, a prerequisite it does not hold being named by its id; then the address of each link that
has one. In a label `&`, `<`, `>`, CR and LF are written as the entities above, and in a kind's label `-` too.

A file holds what the grammar reads back, so the read is not always the roadmap written: a label that begins like a
box is read as a mark, a description's line is read as the line it looks like, an empty label at a change of kind
keeps the marker as its name, an address that is not `http` or `https` is read as a note, and a title with a line
break ends the first line early. `write.json` holds each.

## What Swift's strings answer differently

A port takes each rule from this page. Each row is one Swift's standard library or Foundation answers otherwise by
default, and the case that holds it.

| Rule | Swift's default | Case |
|---|---|---|
| CRLF is one cut, CR alone a cut | a CRLF is one `Character`, which a split at LF does not find, and a split at every newline cuts it twice | `read.json` *LF, CRLF and CR each end a line, and LF then CR ends two* |
| Names compare by scalar value | canonically equivalent strings are equal, and one member of a `Set` | `read.json` *Names that differ in case, or in how an accent is composed, are different names*; `read-into.json` *A heading whose accent is composed differently from the kind's does not bind it* |
| A bound counts UTF-16 units, and no pair is split | `count` counts characters as a person sees them | `read.json` *The clip counts UTF-16 units, so 150 emoji keep 100*, *A name is never clipped inside a surrogate pair: it keeps one unit fewer*, *A kind label is never clipped inside a surrogate pair*; `create-roadmap.json` *A typed name is clipped at 200 UTF-16 units after trimming, never inside a pair* |
| Whitespace is the kit's set | `.whitespacesAndNewlines` leaves U+FEFF and takes U+0085 | `read.json` *A byte order mark is whitespace: it is trimmed from a name, and before a hash it leaves the line text*, *U+0085, U+200B and U+180E are not whitespace*, *A no-break space and an ideographic space are whitespace: after a marker, after hashes, around a name* |
| Only ASCII digits number a line | a regular expression's digit class takes every script's digits | `read.json` *Only the ten ASCII digits number a line* |
| U+2028 and U+2029 end no line, and a line's text stops at nothing else | they are newlines; a regular expression's any-character also stops at U+000B, U+000C and U+0085 | `read.json` *U+2028 and U+2029 end no line and are whitespace: one after an item's first character, or inside a heading's text, makes the line text*, *A vertical tab and a form feed are whitespace around text and part of the text inside it* |
| Lowercase knows the final sigma | `lowercased()` maps each scalar alone | `read-into.json` *Lowercasing is Unicode's: a final sigma, a dotted capital I and a Cyrillic capital bind; a sharp s does not bind SS* |
| A number's digits are never a number | a parsed integer overflows | `read.json` *A number is never read as a number: any digits chain, in the order of the lines* |
| An address is `http` or `https` in lower case, then no whitespace | a URL parser takes other schemes and other cases | `read.json` *An address is http or https in lower case, then anything with no whitespace, alone on its line* |
| Nothing is sorted | a `Set` and a `Dictionary` keep no order | `write.json` *Steps are written in the order given, each under the first step it follows, wherever that step stands in the order* |

A file a person picks is decoded before the grammar reads it. The web decodes one with `File.text()`, which drops a
leading byte order mark, so its grammar is handed none from a file.
