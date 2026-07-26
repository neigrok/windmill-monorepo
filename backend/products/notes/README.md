# notes (product scaffold)

A future Windmill product on the shared modular-monolith backend. Nothing is built here yet — this
directory is the reserved insertion point.

When `notes` gains code, it mirrors the `roadmap` product's shape:

```
products/notes/
  domain/        pure notes logic (no framework, no I/O)
  application/   services that load via ports and call the domain
  ports/         the interfaces notes owns (repositories, etc.)
  adapters/      http / postgres / … the messy edges
  routes.{h,cpp} the composition seam — notes::registerRoutes(app, NotesDeps&)
```

It depends on `windmill_platform` (auth, oauth, billing, the MCP transport engine, the vendor
edges) and never the other way round. To wire it up: add a `windmill_notes` library in
`backend/CMakeLists.txt` linking `windmill_platform`, and have `platform/infra/main.cpp` build the
notes singletons and call `notes::registerRoutes(app, deps)` beside the roadmap one.
