# Roadmap Coach's ability vectors

An ability is a pure function of the roadmaps a device holds and an input, which answers what it read, the writes to
make, or a refusal ([Roadmap Coach](../../../../docs/foundation/roadmap-coach.md) §3). A file here is one ability of
`../catalog.json`, named `<ability>.json`, and holds an array of cases, each giving the function both and what it must
answer:

```json
{"case": "…", "about": "t_…", "given": {"trees": […], "held": […]}, "call": {"name": "…", "input": {…}}, "expect": {…}}
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
- `call` names the file's ability and gives its input, which stands inside the ability's `input` schema.
- `expect` is one of:
  - `{"result": …}` for a read: its answer, at most the ability's `result.maxBytes` as UTF-8 JSON text;
  - `{"writes": [{"action", "input"}, …]}` for any other ability: the room's own actions the tool host carries out, in
    order. Each is an action of the domain corpus, named and shaped as its cases in `../domain/*-actions.json` are,
    whose vectors pin what it writes. An ability has no door of its own (INV-2), so a write is never anything else, and a
    new step's id is the action's to mint;
  - `{"refused": "<code>"}`: the code the ability refuses with. The spec names `roadmap-not-ready` and `over-limit`
    (§6), `roadmap-changed` (§7) and `roadmap-unavailable` (§10).

A rule the server keeps too is pinned where the server already holds it, and a case here leans on it rather than state it
again: a cap in `../limits.json`, which `../check.py` holds to the backend's constant and to roadmap's sync registry,
and how a step's state follows its prerequisites in `../domain/graph.json`, which the server's read domain claims.

`../check.py` holds every file to this format in the Coach contracts workflow: the file names an ability of the
catalog, each case calls that ability with an input inside its schema and expects one of the three, a read's result
stays inside its `maxBytes`, and each write is an action of the domain corpus. `../check_test.py` breaks each rule once.
No executor claims these files yet.
