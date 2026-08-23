# Embedder sidecar

Turns journal passages into 384-dimension unit vectors for echoes. The C++ backend calls it over
HTTP through `Embedder` (`backend/products/journal/ports/Embedder.h`, implemented by
`adapters/llm/HttpEmbedder`), one call per page.

It is Node so it runs the same library the browser's journal search runs — but not the same model.
This side loads `Xenova/paraphrase-multilingual-MiniLM-L12-v2`; the browser keeps
`Xenova/bge-small-en-v1.5`. That divergence is deliberate. Nothing serves a vector from one to the
other — the browser embeds page bodies on-device into an index of its own, and these vectors never
leave the server — so neither owes the other anything but its own consistency. What the split buys:
the server reads the languages the writer actually writes in, and no phone downloads 135MB to get it.

## Run it

```sh
cd services/embedder
npm ci
node ../../web/scripts/fetch-model.mjs   # once — 170MB for both models, a no-op once they are there
npm start                                # :8081, model from ../../web/public/models
```

The weights are not in the repo: `web/.gitignore` ignores `public/models/`, and
`web/scripts/fetch-model.mjs` (web's `prebuild`) pulls both models from HuggingFace into one
directory, each under its own repo id. `MODEL_DIR` points elsewhere; `PORT` changes the port.

Wire the backend to it with `JOURNAL_EMBEDDER_URL=http://127.0.0.1:8081`. Unset,
`HttpEmbedder::configured()` is false and the echo sweep is a no-op.

## The two doors

```
GET  /health   → 200 {"status":"ready", "version":…, "dim":384}
                 503 {"status":"loading"|"failed", …}
POST /embed    → {"passages":["…","…"]}
                 200 {"version":"paraphrase-multilingual-MiniLM-L12-v2.q8.mean.l2", "vectors":[[…],[…]]}
                 400 empty batch, >512 passages, a passage over 20k chars or over 512 tokenizer
                     pieces, non-strings, bad JSON
                 413 body over 2MB
                 503 the model never loaded
```

`/health` reports `version` while still loading, so the backend can learn the stamp during a cold
start. An `/embed` arriving mid-warmup waits. An empty batch is refused, not answered with `[]`:
the port reads an empty result as failure.

The piece count is the refusal no character count can stand in for. The model reads 512 positions
and transformers.js drops the rest without a word, so an over-long passage would come back a
normal-looking 384-dimension unit vector standing for only its opening — nothing downstream could
tell. The whole batch is refused instead, naming the offending index and its piece count and never a
byte of the passage. Characters are a poor proxy for pieces and the exchange rate is per language:
measured on the same two sentences, bge spends 0.88 pieces per character of Russian against 0.27 of
English, while this model spends 0.29 against 0.28. The limit is therefore hard to reach here — a
reason the guard is cheap, not a reason to drop it.

## Checks

```sh
node check/fixture.mjs       # six pinned sentences vs the committed vectors
node check/server.mjs        # spawns the server: warmup, dimensions, determinism, refusals, floods
node check/browser.mjs       # the shipped web worker in real headless Chrome, vs node — one model,
                             # the BROWSER's, since the two halves do not share a space
```

`check/fixture.json` holds six sentences, their vectors, the sha256 of the weights that produced
them, and the platform they were produced on. `node check/fixture.mjs --write` regenerates it — only
alongside a new `VERSION`. Two bars: bit equality on the platform the fixture was built on, a 0.995
cosine floor everywhere else, because onnxruntime-node's macOS and Linux builds do not agree to the
bit. Then a third, on meaning rather than bits, because `--write` will happily pin whatever a broken
build produces: the two C++ lines must sit closer to each other than to the tired one, and the
Russian twin of the first must sit closer still — that last is what catches a fixture regenerated
against a model that cannot read the writer.

`.github/workflows/embedder.yml` runs the first two on every push and PR touching this directory or
the script that fetches the weights. `check/browser.mjs` needs a real browser and is not in CI — run
it by hand when the transformers version, the browser's model files or the worker change.

A vector is not independent of its batch: q8 derives one activation scale from the whole padded
batch tensor, so re-deriving a page moves every vector on it by up to about 0.008 cosine (measured
on the six-passage fixture, darwin/arm64), against retrieval thresholds at 0.80 / 0.85 / 0.97.

## The image

```sh
docker build -t windmill-embedder services/embedder
```

`node:20-slim`, not alpine: onnxruntime-node's prebuilt binaries are glibc. The build prunes
`onnxruntime-web` and every ORT binary for a non-target platform in the same layer as `npm ci`,
because a `rm` in a later layer only writes a whiteout and ships the bytes anyway.

`.github/workflows/backend.yml` builds this image beside the server image, under the same GHCR
package, tagged `embedder-<sha>`; `backend/deploy/docker-compose.yml` pulls both by one `IMAGE_TAG`.

### The model files are mounted, not copied

No weights travel in an image. On the VPS, `~/windmill/web/` is the built web app Caddy serves
(rsynced by `.github/workflows/web.yml`) and Vite copies `public/` verbatim, so
`./web/models:/models:ro` hands this service a directory holding both models — it loads the one
`MODEL` names, the browser fetches the one the worker names, and neither is aware of the other.

- The web deploy must land before the backend deploy on a fresh host, or the mount is an empty
  directory. `docker compose config` will not catch this.
- **It costs RAM, and this is the number to check before deploying.** Measured on darwin/arm64 under
  node 20 through the same `loadExtractor` + `embedPassages` path: resident memory goes from ~78MB at
  rest and ~213MB with the model up under `bge-small-en-v1.5`, to ~75MB / **~665MB up, ~690MB after
  one 32-passage batch** under this one — a 250k-token vocabulary is most of it. The compose service
  declares no memory limit, and this box also runs Postgres, the backend and Caddy. Check the VPS has
  the headroom, or give the service one: an OOM here does not degrade echoes, it stops them, and
  `HttpEmbedder::configured()` only asks whether a URL is set, so a dead sidecar still arms the sweep.
- It carries both models now: `dist/models/` is 170MB, of which 135MB is the sidecar's and no
  browser ever asks for it. That is the price of one bind-mounted directory, paid in web rsync time
  and VPS disk, not in anybody's phone data.
- A missing or wrong mount surfaces as `/health` reporting `{"status":"failed"}` with the path it
  looked in, and the container stays up saying so.
- A rollback to a sha with no `embedder-<sha>` image fails `docker compose pull` rather than
  starting a stale sidecar. Dispatch the deploy with a newer tag.
- `docker compose exec embedder node check/fixture.mjs` re-embeds the six pinned sentences against
  the mounted weights.

## Pins

| Pin | |
|---|---|
| `@huggingface/transformers` **3.8.1**, exact | `web/package.json` pins the same exact version; the two must move together. |
| `package-lock.json` committed | It pins `onnxruntime-node`/`onnxruntime-common` **1.21.0**, which makes the fixture reproducible. `npm ci`, never `npm install`, in the image. |
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, dtype `q8` | Measured on the owner's own 40 stored passages: bge separated a real paraphrase from a word-sharing impostor 9% of the time — worse than chance — and ranked his true reach-back 5th behind three unrelated lines. This model: 76%, and 1st at 0.610 against 0.394 for the runner-up. fp32 moves neither, so the quantisation is not what was wrong. |
| `pooling: 'mean'`, `normalize: true` | Named in `VERSION`, like the two above. |
| No query prefix, either side | This model is symmetric: a query and a passage are embedded the same way. (The browser's bge is asymmetric and prefixes its queries — the browser's business, not this one's.) |

Change any of those and `VERSION` changes with them, so every stored vector's `embed_version` stops
matching. Cosine between two embedding spaces is meaningless and looks like nothing is wrong.
