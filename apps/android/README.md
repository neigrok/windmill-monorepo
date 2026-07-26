# Windmill Android

One Kotlin superapp for the whole brand. `roadmap`, `notes`, and `gym` are module groups
inside a single app, behind one sign-in and one subscription — mirroring `web/` and `apps/ios`.
Modules stay independently mountable.

Talks to the shared backend over the same single-origin API as the web app; shared wire
types live in `packages/api-contract`, shared visual scales in `packages/design-tokens`.

Status: **scaffold** — structure only. Gradle project and module targets land in a later wave.
