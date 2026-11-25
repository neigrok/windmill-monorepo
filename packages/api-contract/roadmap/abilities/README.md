# Roadmap Coach's ability vectors

An ability is a pure function of the roadmaps a device holds and an input, which answers what it read, the writes to
make, or a refusal ([Roadmap Coach](../../../../docs/foundation/roadmap-coach.md) §3). A file here is one ability of
`../catalog.json`, named `<ability>.json`, or the context Coach is told at the start of a turn, `context.json`
([The context](#the-context)), and holds an array of cases, each giving the function both and what it must answer:

```json
{"case": "…", "about": "t_…", "given": {"trees": […], "held": […], "ids": […]}, "call": {"name": "…", "input": {…}}, "expect": {…}}
```

- `case` says what the case shows.
- `about` is what the conversation is about (D-7): the id of a roadmap the case gives, or null for all of the person's
  roadmaps. A direct write names that roadmap (§6, rule 3).
- `given.trees` is every roadmap the device holds, and so the whole list of the person's: a `treeId` none of them has
  is `unknown-roadmap`. Each is the standing roadmap of D-2 as plain data: a normalized tree as the domain's pure reads
  take it ([../domain/README.md](../domain/README.md), Pure reads), every field spelled.
  - It keeps what only the copy knows: a removed step whose record the device holds, as `present: false`, links to
    steps that are gone, and links from a step to itself.
  - `read: "unread"` is a roadmap the device has not finished bringing (§10), and `own` says whether the person owns it
    (§6, rule 2).
  - For a roadmap the person only reads, `marks` are the owner's, as the room shows them. On a step that owns a subtree
    the device does not hold, a mark says what the server told the room of that subtree: `complete`, or `none` where it
    is not; the step is `unknown` where it carries none.
- `given.held`, which a case may leave out, lists the steps under a delete the person can still undo, as
  `{tree, step}`. Each is `present: false` in its tree (§6, rule 1).
- `given.ids`, which a case may leave out, are the ids the tool host's random source gives, in the order it draws them:
  for `create_node`, the new step's; for a proposal, the proposal's own and then one for each ref, in the order the
  changes give them (§7).
- `call` names the file's ability and gives its input. The input stands inside the ability's `input` schema, but in a
  case that expects `invalid-input`.
- `expect` is one of:
  - `{"result": …}` for a read: its answer, inside the ability's `result` schema, whose canonical text is at most its
    `result.maxBytes`;
  - `{"writes": [{"action", "input"}, …], "result": …}` for a direct write: the room's own actions the tool host
    carries out, in order, and the answer. Each action is one §6 gives the ability, named and shaped as the domain
    corpus's cases in `../domain/*-actions.json` name and shape it, whose vectors pin what it writes. An ability has no
    door of its own (INV-2), so a write is never anything else;
  - `{"result": …, "proposal": {"changes": […]}, "folded"?: …}` for `propose_roadmap_change`: its answer, whose
    `proposalId` is the first of `given.ids`, and the changes the minted record holds, each ref under its id. A case
    with a `recolor_kind` also pins `folded`, `{kinds: [{id, hue}], steps: [{id, color}]}`: the kinds and the present
    steps' colours once every change has folded, in the room's order, which the record alone does not show;
  - `{"refused": {"code", "id"?, "at"?}}`: a code of §6.1, the id §6.1 says the refusal names, and, for a proposal,
    `at` as §7 says.

## Canonical text

A page of a read is measured, in bytes, on its canonical text, the same on every device: JCS (RFC 8785), as
`../../sync/reference/core/jcs.js` writes it.

- Members are in key order by UTF-16 code units, with no white space between tokens.
- Numbers are integers, written as decimal digits.
- A string escapes `"` and `\`, writes `\b`, `\f`, `\n`, `\r` and `\t` as those, and every other control character as
  `\u00xx` in lower-case hexadecimal; it writes `/` and every other character as itself, in UTF-8.
- No string holds a lone surrogate: stored text is well formed, and a page cuts text only between Unicode scalars.

How a read fills its pages, splits an object too long for one, and writes `nextCursor` is the spec's §5.2. A later page
is a case of its own, whose `cursor` is the `nextCursor` of the case before.

## The context

`context.json` holds the context (D-8, §5): what Coach is told at the start of a turn, before it calls anything. Its
bounds are `../limits.json`'s `context`, which §5's table states; below, a bound is named as it is there. A case gives
the roadmaps as an ability's case does, and the conversation in place of a call:

```json
{"case": "…", "about": "t_…", "step": "…", "given": {"trees": […], "held": […]}, "expect": {…}}
```

- `about` is what the conversation is about, as above, and `step` the step it started from, or null.
- A roadmap of more than 250 steps may give its `nodes`, `edges` and `marks` as a table, `{"columns": [...], "rows":
  [[...], ...]}`: each row is one record, its values in the columns' order, and a reader spells it back as those records
  before it reads the case. The table only drops the keys every record repeats; what it gives is the same records.
- `expect` is `{"result": …}`, or `{"refused": {"code", "id"}}` where a read of `about` would be refused:
  `roadmap-unavailable` or `unknown-roadmap`, naming `about`.
- About all of the person's roadmaps, the result is `{trees, omitted}`: the rows `list_trees` answers, in its order, each
  never paged and with the first `frontier` titles of its `frontier`, and `frontierOmitted` beside them counting the rest where
  there are more, taken while the context stays within `CONTEXT_BYTES`; and how many rows are left off, which the
  measure counts with its digits.
- About one roadmap, the result holds:
  - `tree`: `{id, title, kinds, guides}`, the roadmap's id, its title and kinds as `get_tree`'s header gives them, and
    its guides as the server's `get_tree` gives them to an outside assistant, `{treeId, title, text, yours}`: on a
    roadmap the person owns, the domain's `guides` read (those of their roadmaps above it, then its own, farthest first,
    at most eight), `yours` where the words are not inherited; on one they only read, its own alone, `yours: false`.
    Where the roadmap is given around where the person stands and its context with no line taken (`omitted` counting
    every line) would pass `CONTEXT_BYTES`, guides give way from the first, the farthest, until it does not, and
    `guidesOmitted`, beside them, counts them; it is there only where one gave way;
  - `diagnostics`: `get_diagnostics`' report in summary: for each of its lists, how many entries it holds, those left
    off counted in; and `smells` as the report gives them, each without its `nodes`;
  - `recent`: the `recent` newest completions that carry a date, `{id, label, at}`, newest first and in id byte order at one
    date;
  - then, where the roadmap has at most `steps` steps and the context given so comes to at most `bytes`, `CONTEXT_BYTES`
    (§8), in canonical text, `step` counted, the roadmap whole: `steps`, every step's line, §5.1's default fields,
    in `get_tree`'s order, and `completed`, what `get_progress` answers;
  - or else the roadmap around where the person stands: `counts`, the counts `list_trees` gives with `byKind`, the same
    counts for each kind in the room's order and, where a step wears a hue no kind owns, for `kind: null`; `steps`, the
    lines in the order they are taken, while the whole context stays within `CONTEXT_BYTES`: every available step, then
    every step of the kind `milestone`, then every step within two links of an available one, a link read both ways,
    each group in `get_tree`'s order and a step in its first group alone; and `omitted`, how many of those lines are left
    off, which the measure counts with its digits;
  - `step`, in a conversation started from a step the roadmap shows: that step with every field of §5.1 but `summary`,
    its `prerequisites` their first `prerequisites` ids and `prerequisitesOmitted` beside them counting the rest where
    there are more. It counts toward `CONTEXT_BYTES` in either form and stays whole: lines give way to it first, in the
    order they are taken, and guides as the context with no line taken requires. A step the roadmap does not show, as
    one under a delete the person can still undo, adds nothing.

## The rules a case leans on

A rule the server keeps too is pinned where the server already holds it, and a case here leans on it rather than state it
again: a cap in `../limits.json`; how a step's state follows its prerequisites, what it follows and what it unlocks in
`../domain/graph.json`; which kind owns a hue in `../domain/legend.json`; `find_nodes`' order in `../domain/search.json`;
and what `get_diagnostics` reports in `../domain/diagnostics.json` and `../domain/pointers.json`. The server's read domain
claims those files.

`../check.py` holds every file to this format in the Coach contracts workflow. It checks what can be checked without
running an ability:

- the file names an ability of the catalog, and each case calls it with an input inside its schema, or expects
  `invalid-input`;
- the given trees are spelled whole, `about` and each held step name what the case gives, and the ids minted are as
  many as the call mints;
- each case expects the form its ability's kind takes, and its answer stands inside the ability's `result` schema;
- a read's page stays inside its `maxBytes`, its `nextCursor` is of §5.2's form and names a position inside the
  read's sequence, an object in parts starts its page, a part before the last takes its page alone, and a later part carries only `id`, `part`, `parts` and long fields; a
  step's label, description, summary and web links, whole or as a part's piece, are the given step's, and a header's
  title and step count the given roadmap's;
- a write is an action §6 gives the ability, its input of the shape the domain's cases give that action, and
  `create_node`'s answer the id minted;
- a proposal's record is the call's changes with each ref under the id minted for it, in order; its `removes` name the
  steps its changes remove, each as the given roadmap holds it until a change names it; and a recolour pins `folded`;
- a refusal's code is one of §6.1, and holds to what the case gives: `unknown-roadmap` for a roadmap not given,
  `roadmap-unavailable` for one unread, `not-owner` for one the person does not own, `out-of-scope` for a write outside
  `about`, `roadmap-not-ready` naming a held step, and `over-limit` for a call that passes a cap. An input that passes a
  cap must be refused as `over-limit`. `at` is on a proposal's refusal of a change alone, and where §7 fixes it, as for
  the count of changes, the Shape rule's `changes[k]` and the first value past a cap, it is that;
- a context's tables hold a value for each column, and its step and its refusal name what the case gives; a roadmap's
  context holds the parts its form holds, each line with §5.1's default fields and of a given step, guides that end
  with the roadmap's own and, on a roadmap the person only reads, are its own alone, at most eight with those left off,
  a `guidesOmitted` from one and only around the frontier, a roadmap given whole only within both bounds and with every
  step's line, one given around its frontier within `CONTEXT_BYTES` with its lines and `omitted` no more than its steps,
  counts that add up to the roadmap's steps, at most `recent` newest completions in their order, and a step in full exactly
  where the conversation started from a step the roadmap shows, counted in the bound, its prerequisites at most
  `prerequisites` and a `prerequisitesOmitted` from one only beside that many; `limits.json`'s `context` is §5's table; and a context about
  all roadmaps holds rows of
  `list_trees`' shape within `CONTEXT_BYTES`, each with at most `frontier` titles and a `frontierOmitted` from one only
  beside that many, the two together its available steps, with `omitted` no more than the person's roadmaps the case gives.

It does not run an ability, so it does not check what only running one shows: the order of a read, a step's state,
prerequisites and unlock count, a cursor's digest or where a page is cut, a fold's colours, which code a refusal is,
which steps lie around the frontier and in what order they are taken, or which guides lie above a roadmap. Those are
the executors' to claim. `../check_test.py` holds a broken case for each
refusal `check.py` makes. The web's runner, `web/test/products/roadmap/domain/abilities/corpus.test.js`, claims the read
abilities' files and `context.json` and compares each answer whole by canonical text; no executor claims the direct
writes' files or the proposal's yet. The format holds no register stamps, so no case shows §7's `roadmap-changed` over a
register.
