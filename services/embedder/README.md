# Embedder sidecar

Turns journal passages into 384-dimension unit vectors for **echoes**, and nothing else.

The C++ backend calls it over HTTP through `Embedder`
(`backend/products/journal/ports/Embedder.h`, implemented by `adapters/llm/HttpEmbedder`). One call
per page, carrying that page's passages.

## Why a Node service and not C++

The vectors this service produces are compared against vectors **the browser** produced: the same
`Xenova/bge-small-en-v1.5` runs on-device for journal search, and one index seeds the other. Getting
the tokenizer, mean pooling and L2 normalisation subtly wrong in C++ would raise no error, fail no
test, and make retrieval quietly worse forever. Running the same library over the same model files
makes that identity structural — and `check/browser.mjs` measures it rather than asserting it.

## Run it

```sh
cd services/embedder
npm ci
node ../../web/scripts/fetch-model.mjs   # once — 34MB of weights, a no-op once they are there
npm start                                # :8081, model from ../../web/public/models
```

The default `MODEL_DIR` is the web app's own `public/models`. The weights are **not** in the repo:
`web/.gitignore` ignores `public/models/`, and `web/scripts/fetch-model.mjs` pulls them from
HuggingFace. It is wired as web's `prebuild`, so an `npm run build` over there fills the same
directory and this service needs nothing further. Point it elsewhere with `MODEL_DIR`, and change
the port with `PORT`.

Wire the backend to it:

```sh
JOURNAL_EMBEDDER_URL=http://127.0.0.1:8081
```

Unset, `HttpEmbedder::configured()` is false and the echo sweep is a quiet no-op — the resting
state, not a failure.

### The two doors

```
GET  /health   → 200 {"status":"ready", "version":…, "dim":384}
                 503 {"status":"loading"|"failed", …}   while the weights load (~200ms measured, more on a cold page cache), or after they didn't
POST /embed    → {"passages":["…","…"]}
                 200 {"version":"bge-small-en-v1.5.q8.mean.l2", "vectors":[[…],[…]]}
                 400 empty batch, >512 passages, a passage over 20k chars, non-strings, bad JSON
                 413 body over 2MB
                 503 the model never loaded
```

`/health` refuses readiness until the model can actually answer, but reports `version` throughout —
the stamp is a property of the configuration, not of readiness, which is what lets the backend learn
it during a cold start. An `/embed` that arrives mid-warmup waits rather than failing.

An **empty batch is refused**, not answered with `[]`: the port reads an empty result as failure, so
a legitimate "nothing to embed" and a broken call must not look alike.

## Checks

```sh
node check/fixture.mjs       # five pinned sentences vs the committed vectors
node check/server.mjs        # spawns the server: warmup, dimensions, determinism, refusals, floods
node check/browser.mjs       # the shipped web worker in real headless Chrome, vs this sidecar
```

`check/fixture.json` is the artifact: five sentences, their vectors, the sha256 of the weights that
produced them, and the platform they were produced on. `node check/fixture.mjs --write` regenerates
it — only ever deliberately, alongside a new `VERSION`. (The sha256 is provenance, written on
`--write` and read by a human; what a check run compares is the vectors, which is the stronger
statement anyway — the same weights through a different library still produce different numbers.)

`.github/workflows/embedder.yml` runs the first two on every push and PR that touches this directory,
`web/src/products/journal/search/neural/`, or the script that fetches the weights.

**`check/browser.mjs` is deliberately not in CI.** It needs a real browser, and installing Chrome on
every push to re-measure a number that only three things can move — the transformers version, the
model files, the worker — is not worth the minutes. It is also the check that measures the claim this
whole service exists to make, so run it by hand when any of those three change, and update the table
below with what it says. The omission is a choice, written down here rather than left to be found.

### What is measured, and what is true

| | worst cosine | worst component \|Δ\| |
|---|---|---|
| **browser (onnxruntime-web, wasm) vs sidecar (onnxruntime-node)** — the claim this service exists to make | **0.999978** | 1.0e-3 |
| same passage batched with four others vs embedded alone | 0.9956 | 1.5e-2 |
| sidecar on linux/arm64 vs sidecar on darwin/arm64, same batch | 0.9972 | 1.4e-2 |
| sidecar on linux/x64 vs the committed fixture — **the bar CI holds**, floor 0.995 | 0.9974 | 1.2e-2 |
| a float32 unit vector against itself (the ceiling all of these are read against) | 0.9999995 | — |
| node → JSON → C++ `std::vector<float>` | exact | 0 |

Read the top row against the two below it: the server and the browser agree **two hundred times more
closely** than the same passage agrees with itself when you batch it differently. The runtime is not
where this feature's numerical risk lives.

Two consequences worth carrying:

- **A vector depends on its batch.** The q8 model quantizes activations dynamically, deriving one
  scale from the whole padded batch tensor, so co-batched sentences nudge each other. The browser
  batches too (32 at a time), so its index carries the same wobble. Re-deriving a page after an edit
  therefore moves *every* vector on it by ~0.003 cosine. Retrieval thresholds sit at 0.80 / 0.85 /
  0.97 (`backend/products/journal/ECHOES.md`) — the 0.97 restatement cut is the one close enough to
  a wobble of that size for a borderline pair to flip between nights.
- **A vector depends on the machine.** onnxruntime-node's macOS and Linux builds do not agree to the
  bit, and threading has nothing to do with it (pinning `intraOpNumThreads: 1` on both sides changes
  nothing; within one platform the result is already bit-identical run to run). The `VERSION` stamp
  deliberately does **not** name the platform: adding it would invalidate an entire corpus on a
  server migration, over a difference smaller than the batching wobble the space already tolerates.

`check/fixture.mjs` holds both bars honestly — bit equality on the platform the fixture was built
on, a 0.995 cosine floor everywhere else.

## The image

```sh
docker build -t windmill-embedder services/embedder
```

492MB, of which 130MB is `node_modules`. `node:20-slim`, not alpine: onnxruntime-node's prebuilt
binaries are glibc. The build prunes `onnxruntime-web` (the node entry point never imports it) and
every ORT binary for a platform that isn't the target — **in the same layer as `npm ci`**, because a
`rm` in a later layer only writes a whiteout and ships the bytes anyway. It was 1.12GB before that.

This image IS what production runs, since 2026-08-15: `.github/workflows/backend.yml` builds it
beside the server image, under the same GHCR package, tagged `embedder-<sha>`, and
`backend/deploy/docker-compose.yml` pulls both by one `IMAGE_TAG`. (Before that the compose file
took a stock `node:22-slim` and bind-mounted this directory from the host — a directory the deploy
workflow never shipped, so on any host nobody had hand-provisioned the sidecar could not start.
Found 2026-08-05, fixed by going to the image the README had described all along.)

### The model files are mounted, not copied

**Decision: bind mount for the weights, an image for the code.** No weights travel in an image.

```yaml
  embedder:
    image: ghcr.io/neigrok/windmill-monorepo:embedder-${IMAGE_TAG:-latest}
    restart: unless-stopped
    volumes:
      - ./web/models:/models:ro         # the deployed site's own models/ directory
```

and on the `server` service:

```yaml
      JOURNAL_EMBEDDER_URL: http://embedder:8081
```

On the VPS, `~/windmill/web/` is the built web app that Caddy serves (rsynced by
`.github/workflows/web.yml`), and `web/models/Xenova/bge-small-en-v1.5/` is inside it because Vite
copies `public/` verbatim. So the mount hands this service **the exact bytes the browser downloads**
— not a copy that can drift from them. A `COPY` would put a second 34MB copy in the image, on its
own release cadence, and the first symptom of them diverging would be worse retrieval that nothing
reports.

The price, which an operator must know:

- **The web deploy must land before the backend deploy** on a fresh host, or the mount is an empty
  directory. `docker compose config` will not catch this.
- A missing or wrong mount surfaces as `/health` reporting `{"status":"failed"}` with the path it
  looked in, and the container stays up saying so. It does not crash-loop, and it does not lie.
- **A rollback to a sha before 2026-08-15 has no `embedder-<sha>` image**, and `docker compose pull`
  fails loudly rather than starting a stale sidecar. Dispatch the deploy with a newer tag.
- Prove a deployment rather than trusting it: `docker compose exec embedder node check/fixture.mjs`
  re-embeds the five pinned sentences against the mounted weights and compares them to the vectors
  committed in this repo.

## Pins nobody should change casually

| Pin | Why |
|---|---|
| `@huggingface/transformers` **3.8.1**, exact | The two must move together or the server and the browser stop sharing a space. `web/package.json` pins the same exact version — it declared `^3` until 2026-08-05 and agreed only because the lockfile happened to; the rule now lives where npm enforces it rather than in this sentence. |
| `package-lock.json` committed | It pins `onnxruntime-node`/`onnxruntime-common` **1.21.0**, which is what makes the fixture reproducible. `npm ci`, never `npm install`, in the image. |
| `Xenova/bge-small-en-v1.5`, dtype `q8` | Matches `web/src/products/journal/search/neural/embedder.worker.js` exactly. |
| `pooling: 'mean'`, `normalize: true` | Same. Both are named in `VERSION`. |
| No query prefix | The browser prefixes *queries* only (`Represent this sentence for searching relevant passages: `) and leaves passages bare. This service embeds passages. |

If any of those change, `VERSION` changes with them, and every stored vector's `embed_version` stops
matching — which is the point. Cosine between two embedding spaces is not degraded, it is
meaningless, and nothing about it looks like an error.
