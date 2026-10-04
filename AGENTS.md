# Agent instructions

This project's instructions live in `CLAUDE.md`: read the root `CLAUDE.md`, then the `CLAUDE.md` of each tree you
touch (`backend/CLAUDE.md`, `web/CLAUDE.md`), and follow them. `STRUCTURE.md` maps the monorepo.

Working rules for every task:
- Prefer the smallest design that meets the brief; add no abstraction, option or file nobody asked for.
- Before finishing, search the whole repository, not only your territory, for consumers of anything whose shape you
  changed (formats, routes, registration calls, paths, tool output). Update them, or list the ones outside your territory.
- Anything you add must build and run in CI the way it runs for you (CMake lists, Dockerfile targets, workflow steps).
- For I/O, concurrency, retries and shutdown, test the failure paths (stalled output, exit, crash, timeout), not only
  the happy path.
- Report what you could not verify and why, rather than working around a blocked gate.
