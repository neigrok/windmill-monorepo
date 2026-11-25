# Roadmap sync binding

Roadmap's registry (`packages/api-contract/sync/roadmap.registry.json`, engine.md Appendix A.1) bound to the
engine, as [Roadmap on the sync engine](../../../../docs/foundation/roadmap-on-the-engine.md) §4 and §7 state it.
The JavaScript reference's rules (`packages/api-contract/sync/reference/roadmap/product.js`) are the executable
statement this binding follows; `roadmap/admit.json` holds the two to the same answers, over the fakes and over
Postgres. `roadmap/client.json` belongs to the client role.

- `RoadmapRules` reads nothing: where a roadmap sits among its owner's `tree` records (`Roadmaps`), the reach each
  subtree of a branch takes, and the genesis kinds a subtree is born with.
- `RoadmapProduct` binds all fourteen types under one rules object and the five product commands
  (`roadmap.createSubtree`, `roadmap.recolourKind`, `roadmap.undoCreateRoadmap`, `roadmap.undoCreateSubtree`,
  `roadmap.redoCreateSubtree`); the engine binds the capture and restore commands. Discovery declares every scope a
  consequence reaches before anything runs, and the consequences are A.1's: a step's or kind's revival when a change
  carrying an alive life joins dead, the owner-only overlay types, `not-a-root`, `guideInherited` cleared by the
  owner's guide, a roadmap's death ending its subtrees and a root's the steps whose pointers open it, a root's
  visibility writing its branch's `reach`, a step's presence writing the `reach` of the subtrees it owns, and Coach's
  records ending with their conversation. Nothing refuses a loop, two kinds of one hue or a pointer on a step that
  owns a subtree.
- `RoadmapDeeds` is the roadmap's activity (§7): `deedOf` tells what one intent did in a roadmap from its records as the
  intent found them and leaves them, in the commands the activity feed reads (`application/ActivityFeed`), and the
  rules record each deed through `Deeds` once their consequences are known. A roadmap's genesis kinds, the links of a step made with it and the
  steps a kind's recolour repaints are no deed of their own; an annotation, a move, a title and what only the server
  writes are none.
- `PgRoadmap` stores each type in a `roadmap_*` table of `db/schema.sql` through the engine's `PgTableType`, beside
  `trees`, `tree_nodes`, `tree_edges`, `tree_kinds` and `node_progress`, the tables of roadmap's own sync, from which
  the cutover (§8.1) adopted these. Each row goes with its `sync_scopes` row, so an account's erasure takes it. It keeps the
  deeds in `tree_ops`, inside the admitting transaction: one row a gesture leaves a deed in a roadmap, made by the
  intent's account (the roadmap's owner, the only writer of a tree scope) at the roadmap's seq as the gesture's latest
  intent there committed it. A later intent of the gesture folds its deed into the row and moves it to its own seq, so a
  cursor past the earlier seq meets the whole deed again under the same `op_id`. A row already at that seq, a roadmap
  whose seq did not continue above its old head, keeps its deed and the intent lands; the lost deed is reported as
  `roadmap.activity.record` `seq-taken`.

`platform/infra/SyncProducts` composes roadmap beside gym and journal at schema 15 / minimum 15. `windmill_server`
serves roadmap's scopes only where `ROADMAP_ENGINE_ENABLED` is `true` or `1`; otherwise the catalog withholds the
product (`SyncCatalog::withhold`): hello says it holds nothing, `self/roadmap` pulls empty, its trees and overlays are
not found, and an intent is refused `forbidden` in `self/roadmap` and `not-found` elsewhere. Production reads it only from
the host's `roadmap-engine.env`, which holds `ROADMAP_ENGINE_ENABLED=1` and every deploy keeps, so production serves
roadmap's scopes (`backend/deploy/README.md`; `test/deploy/deploy_production_test.py` holds deploys to it).

Every admission logs its one `sync.admit` line and each command its `sync.command.<name>` line, with product
`roadmap`, door, outcome or refusal code and duration, and reports an unexpected failure to Sentry under those static
names (`platform/application/WriteObservation`). Neither names an id or a text.

Where `ROADMAP_ENGINE_ENABLED` serves roadmap's scopes, every server write for a person goes through roadmap's door
(`application/RoadmapDoor`) into this binding as server-origin intents: MCP's write tools (`adapters/mcp/RoadmapDoorTools`),
tending through them, the fork and the fork at sign-up (`application/DoorForks`). Elsewhere they write through roadmap's
own sync.
