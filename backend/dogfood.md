# Dogfooding: our deeds live in the roadmap DAG

We track what we've built as nodes in the `windmill-roadmap` tree — the same tree the
app renders. A **deed** is a node; its **prerequisites** are the deeds it built on. The
graph stays a DAG (no cycles), so the roadmap reads as an honest dependency history of
the project. This file is how you append a deed and persist it on the server.

Prereqs: the server is running and the DB is up (see `RUNNING.md`). Examples assume
`localhost:8088`.

## A deed node

```jsonc
{
  "id": "phase-2-live-collab",        // stable, unique, kebab-case
  "label": "Live collaboration",       // what was done
  "icon": "radio",                     // any lucide icon name
  "color": "brick",                    // terracotta|olive|gold|brick|sky|plum (groups a branch)
  "prerequisites": ["command-layer"],  // ids of existing deeds this built on (the edges)
  "status": "complete"                 // authoring seed: complete|active (drives first paint)
}
```

Rules the server enforces as **diagnostics** (it never rejects — it reports):
- `id` unique within the tree; `prerequisites` must reference nodes that exist.
- no cycles. Check with `GET /v1/trees/:id/diagnostics` after writing.

## Add a deed over HTTP (durable, shows up on GET)

`PUT /v1/trees/:id` is a **whole-document** write, so fetch the tree, append your node,
and put it back. Copy-paste:

```sh
python3 - <<'PY'
import json, urllib.request
base, tree = "http://localhost:8088", "windmill-roadmap"
data = json.load(urllib.request.urlopen(f"{base}/v1/trees/{tree}"))["data"]
data["nodes"].append({
    "id": "phase-2-live-collab",
    "label": "Live collaboration (Phase 2)",
    "icon": "radio",
    "color": "brick",
    "prerequisites": ["command-layer"],
    "status": "complete",
})
req = urllib.request.Request(f"{base}/v1/trees/{tree}",
    data=json.dumps(data).encode(), headers={"content-type": "application/json"}, method="PUT")
print("PUT", urllib.request.urlopen(req).status)
PY

curl -s localhost:8088/v1/trees/windmill-roadmap/diagnostics    # expect all-empty (clean DAG)
```

The `jq` equivalent, if you prefer:

```sh
curl -s localhost:8088/v1/trees/windmill-roadmap | jq '.data' \
  | jq '.nodes += [{"id":"my-deed","label":"My deed","icon":"check","color":"brick","prerequisites":["command-layer"],"status":"complete"}]' \
  | curl -s -X PUT localhost:8088/v1/trees/windmill-roadmap -H 'content-type: application/json' -d @- -o /dev/null -w '%{http_code}\n'
```

## Add a deed over the socket (live, logged to `tree_ops`)

Connect to `ws://localhost:8088/v1/socket`, then:

```jsonc
{ "t": "subscribe", "treeId": "windmill-roadmap", "lastSeq": 0 }
{ "t": "cmd", "treeId": "windmill-roadmap", "opId": "<uuid>",
  "kind": "CreateNode",
  "payload": { "id": "my-deed", "label": "My deed", "icon": "check", "color": "brick",
               "parentId": "command-layer" } }
```

`CreateNode` with `parentId` also adds the prerequisite edge. This appends to `tree_ops`
and broadcasts to every subscriber live — but note the current gap: the `trees.document`
snapshot only refreshes on room eviction, so an HTTP `GET` may lag the socket until then.
**For a deed you want durable and visible immediately, use the HTTP path above.**

## Conventions

- One deed = one node. Keep labels short; the label is the headline.
- Wire `prerequisites` to the deeds you actually built on — that's what makes the DAG a
  real history rather than a flat list.
- `color` groups a branch (e.g. `brick` for backend/domain work, `sky` for the renderer).
- `status: "complete"` for finished deeds; `"active"` for in-flight.
