# Roadmap Coach's ability vectors

An ability is a pure function of the roadmaps a device holds and an input, which answers what it read, the writes to
make, or a refusal ([Roadmap Coach](../../../../docs/foundation/roadmap-coach.md) §3). A file here is one ability of
`../catalog.json`, named `<ability>.json`, and holds an array of cases, each giving the function both and what it must
answer:

```json
{"case": "…", "about": "t_…", "given": {"trees": […], "held": […], "ids": […]}, "call": {"name": "…", "input": {…}}, "expect": {…}}
```

- `case` says what the case shows.
- `about` is what the conversation is about (D-7): a roadmap's id, or null for all of the person's roadmaps. A direct
  write names that roadmap (§6, rule 3).
- `given.trees` is every roadmap the device holds, each the standing roadmap of D-2 as plain data: a normalized tree as
  the domain's pure reads take it ([../domain/README.md](../domain/README.md), Pure reads), every field spelled.
  - It keeps what only the copy knows: a removed step whose record the device holds, as `present: false`, links to
    steps that are gone, and links from a step to itself.
  - `read: "unread"` is a roadmap the device has not finished bringing (§10), and `own` says whether the person owns it
    (§6, rule 2).
  - For a roadmap the person only reads, `marks` are the owner's, as the room shows them.
- `given.held`, which a case may leave out, lists the steps under a delete the person can still undo, as
  `{tree, step}`. Each is `present: false` in its tree (§6, rule 1).
- `given.ids`, which a case may leave out, are the ids the tool host's random source gives, in the order it draws them:
  for a proposal, the proposal's own and then one for each ref, in the order the changes give them (§7).
- `call` names the file's ability and gives its input, which stands inside the ability's `input` schema.
- `expect` is one of:
  - `{"result": …}` for a read: its answer, which stands inside the ability's `result` schema where the catalog states
    one, and whose canonical text is at most its `result.maxBytes`;
  - `{"writes": [{"action", "input"}, …]}` for a direct write: the room's own actions the tool host carries out, in
    order. Each is an action of the domain corpus, named and shaped as its cases in `../domain/*-actions.json` are,
    whose vectors pin what it writes. An ability has no door of its own (INV-2), so a write is never anything else, and a
    new step's id is the action's to mint;
  - `{"result": …, "proposal": {"changes": […]}}` for `propose_roadmap_change`: its answer, whose `proposalId` is the
    first of `given.ids`, and the changes the minted record holds, each ref replaced by its id;
  - `{"refused": {"code", "id"?, "at"?}}`: a code of §6.1, the step, ref, kind or roadmap the refusal is about where
    it is about one, and, for a proposal, the index of the first change that fails.

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

## The rules a case leans on

A rule the server keeps too is pinned where the server already holds it, and a case here leans on it rather than state it
again: a cap in `../limits.json`, which `../check.py` holds to the backend's constant, roadmap's sync registry and the
web's spec; how a step's state follows its prerequisites, what it follows and what it unlocks in `../domain/graph.json`;
which kind owns a hue in `../domain/legend.json`; and `find_nodes`' order in `../domain/search.json`. The server's read
domain claims those three files.

`../check.py` holds every file to this format in the Coach contracts workflow:

- the file names an ability of the catalog, and each case calls that ability with an input inside its schema;
- each case expects one of the four;
- a read's result stands inside its schema and its `maxBytes`, its `nextCursor` is of §5.2's form, and an object in parts
  starts its page, a part before the last takes its page alone, and a later part carries only `id`, `part`, `parts`
  and long fields;
- a write is an action of the domain corpus;
- a proposal's id is the first minted, and its recorded changes hold no ref;
- a refusal's code is one of §6.1.

`../check_test.py` breaks each rule once. No executor claims these files yet, and the format holds no register stamps,
so no case shows §7's `roadmap-changed` over a register.
