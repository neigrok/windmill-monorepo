# gym (product scaffold)

A future Windmill product on the shared modular-monolith backend. Nothing is built here yet — this
directory is the reserved insertion point.

When `gym` gains code, it mirrors the `roadmap` product's shape:

```
products/gym/
  domain/        pure gym logic (no framework, no I/O)
  application/   services that load via ports and call the domain
  ports/         the interfaces gym owns (repositories, etc.)
  adapters/      http / postgres / … the messy edges
  routes.{h,cpp} the composition seam — gym::registerRoutes(app, GymDeps&)
```

It depends on `windmill_platform` (auth, oauth, billing, the MCP transport engine, the vendor
edges) and never the other way round. To wire it up: add a `windmill_gym` library in
`backend/CMakeLists.txt` linking `windmill_platform`, and have `platform/infra/main.cpp` build the
gym singletons and call `gym::registerRoutes(app, deps)` beside the roadmap one.
