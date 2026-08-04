// The embedding boundary the C++ backend calls (backend/products/journal/adapters/llm/HttpEmbedder).
// Two doors: POST /embed turns a page's passages into unit vectors, GET /health says whether the
// model is up. Nothing else, no framework, no state — the model is the only thing this process owns.
//
// It never logs a passage. The bytes crossing this seam are somebody's journal, and a request log
// with the text in it is the same leak as a database dump, arriving one line at a time.

import http from 'node:http';

import { DIM, VERSION, embedPassages, loadExtractor, modelRoot, weightsPath } from './embedder.js';

const PORT = Number(process.env.PORT || 8081);

// Bounds, so a malformed or hostile call is a 4xx rather than an OOM. A journal page segments into
// tens of passages of a sentence or three; these ceilings are an order of magnitude above that and
// still nowhere near the memory a batch would need to hurt.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PASSAGES = 512;
const MAX_PASSAGE_CHARS = 20_000;

const reply = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

// A cold start reads 34MB of weights — measured around 200ms warm, longer on a cold page cache, and
// the port is open the whole time. So the state is reported rather than guessed at: /health answers
// 503 until the model can actually answer, and an /embed that arrives first waits for it.
const model = { status: 'loading', error: null };

const bootedAt = Date.now();
const ready = loadExtractor()
  .then((extractor) => {
    model.status = 'ready';
    console.log(`ready model=${VERSION} dim=${DIM} in ${Date.now() - bootedAt}ms root=${modelRoot()}`);
    return extractor;
  })
  .catch((error) => {
    model.status = 'failed';
    model.error = String(error);
    console.error(`model failed to load: ${model.error}`);
    throw error;
  });
ready.catch(() => {}); // the rejection is carried to each request; an unhandled one would kill the process

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading rather than swallowing the rest: the refusal goes out, then the socket is
        // hung up (below), so a flood costs this process one buffer and not one gigabyte.
        req.pause();
        reject(Object.assign(new Error(`body over ${MAX_BODY_BYTES} bytes`), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleEmbed(req, res) {
  const started = Date.now();

  const raw = await readBody(req);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reply(res, 400, { error: 'body is not JSON' });
  }

  const passages = parsed?.passages;
  if (!Array.isArray(passages)) return reply(res, 400, { error: 'passages must be an array' });
  // Asking for nothing is a caller bug, and answering it with an empty array would be indistinguishable
  // from a failure on the C++ side, where an empty result means the page must be retried.
  if (passages.length === 0) return reply(res, 400, { error: 'passages is empty' });
  if (passages.length > MAX_PASSAGES) return reply(res, 400, { error: `over ${MAX_PASSAGES} passages` });
  if (!passages.every((p) => typeof p === 'string')) return reply(res, 400, { error: 'passages must be strings' });
  if (passages.some((p) => p.length > MAX_PASSAGE_CHARS)) {
    return reply(res, 400, { error: `a passage is over ${MAX_PASSAGE_CHARS} characters` });
  }

  const extractor = await ready.catch(() => null);
  if (!extractor) return reply(res, 503, { error: 'model unavailable', detail: model.error });

  const vectors = await embedPassages(extractor, passages);
  const chars = passages.reduce((total, p) => total + p.length, 0);
  console.log(`embed passages=${passages.length} chars=${chars} ${Date.now() - started}ms`);
  reply(res, 200, { version: VERSION, vectors });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    // The version is a property of the configuration, not of readiness, so it is reported while
    // warming too — the backend can learn the stamp it will write before the first vector exists.
    const status = model.status === 'ready' ? 200 : 503;
    return reply(res, status, { status: model.status, version: VERSION, dim: DIM, error: model.error });
  }

  if (req.method === 'POST' && req.url === '/embed') {
    return handleEmbed(req, res).catch((error) => {
      const status = error.status || 500;
      console.error(`embed failed status=${status}: ${error}`);
      if (res.headersSent) return;
      if (status === 413) res.on('finish', () => req.socket?.destroy());
      reply(res, status, { error: String(error.message || error) });
    });
  }

  reply(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`listening on ${PORT} weights=${weightsPath()}`));
