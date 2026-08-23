// Never log a passage: the bytes crossing this seam are somebody's journal.

import http from 'node:http';

import { DIM, VERSION, embedPassages, loadExtractor, modelRoot, weightsPath } from './embedder.js';

const PORT = Number(process.env.PORT || 8081);

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PASSAGES = 512;
const MAX_PASSAGE_CHARS = 20_000;

const reply = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

// The port is open while the weights load: /health answers 503 until ready, and an /embed arriving
// first waits for the model.
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
ready.catch(() => {}); // the rejection is carried to each request; unhandled it would kill the process

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
  // An empty array back is indistinguishable from a failure on the C++ side, which retries.
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
