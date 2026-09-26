# Embedder sidecar

The journal backend calls this Node service through `HttpEmbedder` to turn passages into
384-dimensional unit vectors. It uses `Xenova/paraphrase-multilingual-MiniLM-L12-v2` with q8 weights,
mean pooling and L2 normalization. Browser search uses a separate `bge-small-en-v1.5` index;
vectors never cross between them.

## Run

```sh
cd services/embedder
npm ci
node ../../web/scripts/fetch-model.mjs
npm start
```

The default port is 8081; `PORT` overrides it. Models load from `../../web/public/models`, or
`MODEL_DIR`. The fetch script downloads both models into that ignored directory and reuses existing
files. It is also web's `prebuild` step.

Set `JOURNAL_EMBEDDER_URL=http://127.0.0.1:8081` on the backend to enable this boundary. Without it,
the echo sweep is disabled.

## HTTP contract

| Route | Result |
|---|---|
| `GET /health` | 200 with `status: ready`, `version` and `dim`; 503 while loading or after a load failure |
| `POST /embed` | `{passages:[...]}` → `{version, vectors}` |

`/embed` waits during warmup. It refuses malformed JSON, empty batches, more than 512 passages,
non-string entries, passages over 20,000 characters or over 512 tokenizer pieces with 400. Bodies
over 2 MB receive 413; a failed model load receives 503. The tokenizer limit prevents silent
truncation. Tokenizer-limit errors name the offending index and size without passage contents.

## Checks

```sh
node check/fixture.mjs
node check/server.mjs
node check/browser.mjs
```

The fixture checks six pinned sentences against committed vectors: exact equality on the fixture's
platform and a 0.995 cosine floor elsewhere. Semantic assertions also compare related, unrelated
and translated sentences. Regenerate with `node check/fixture.mjs --write` only alongside a new
`VERSION`; the fixture records weight hash and platform.

The server check exercises the real process, including warmup, dimensions, determinism, limits and
concurrent requests. `.github/workflows/embedder.yml` runs both checks. The browser check requires
headless Chrome and validates the separate web worker; run it when that worker, its model or the
transformers version changes.

## Deployment

```sh
docker build -t windmill-embedder services/embedder
```

The image uses `node:20-slim` because the native runtime needs glibc. Installation prunes browser
runtime packages and non-target native binaries within the same image layer.

Backend CI publishes the image as `embedder-<sha>` beside the server image. Compose selects both
with `IMAGE_TAG` and mounts `./web/models:/models:ro` from the deployed web directory. The web deploy
must land first on a fresh host; compose validation does not detect missing model files. A wrong
mount produces a failed health response while the container remains running.

The service has no compose memory limit. Check host capacity for the model before deployment;
Postgres, the backend and Caddy share that host. The backend's configured check only tests whether
a URL exists, so monitor the sidecar's health separately.

A rollback needs both the server and matching `embedder-<sha>` images. To verify mounted weights:

```sh
docker compose exec embedder node check/fixture.mjs
```

## Version contract

`package.json` and the committed lockfile pin the transformer and native runtime versions. Keep
the transformer's version aligned with `web/package.json` and install through `npm ci`.

Model, dtype, pooling, normalization and query-prefix behavior determine the embedding space.
Change `VERSION` when any changes. The model is symmetric and receives no query prefix. Stored
vectors are reusable only with the same version; comparing vectors from different spaces is invalid.
Quantized vectors can also vary with batch composition, so fixture comparisons use a fixed batch.
