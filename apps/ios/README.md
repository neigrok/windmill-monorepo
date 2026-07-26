# Windmill iOS

One Swift superapp for the whole brand. `roadmap`, `notes`, and `gym` are module groups
inside a single app target, behind one sign-in and one subscription — mirroring `web/`.
Modules stay independently mountable, so any product can later graduate into its own
focused app without disturbing the others.

Talks to the shared backend over the same single-origin API as the web app; shared wire
types live in `packages/api-contract`, shared visual scales in `packages/design-tokens`.

Status: **scaffold** — structure only. Xcode project and module targets land in a later wave.
