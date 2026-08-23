// The same shape as LexicalEmbedder (embedAll / embedQuery / floor), over the Web Worker that runs the
// model. `ready` resolves once the model is up and rejects if it never loads.

const BATCH = 32;   // passages per worker round-trip — bounds model memory on a large corpus

export class NeuralEmbedder {
  floor = 0.45;

  constructor() {
    this.worker = new Worker(new URL('./embedder.worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (event) => {
        const data = event.data;
        if (data.ready) return resolve();
        if (data.failed) return reject(new Error(data.error));
        const settle = this.pending.get(data.id);
        if (!settle) return undefined;
        this.pending.delete(data.id);
        return data.ok ? settle.resolve(data.vectors) : settle.reject(new Error(data.error));
      };
      this.worker.onerror = (event) => reject(new Error(event.message || 'worker error'));
    });
  }

  send(kind, texts) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, kind, texts });
    });
  }

  async embedAll(texts) {
    const out = [];
    for (let start = 0; start < texts.length; start += BATCH) {
      const vectors = await this.send('passages', texts.slice(start, start + BATCH));
      out.push(...vectors);
    }
    return out;
  }

  async embedQuery(text) {
    const [vector] = await this.send('query', [text]);
    return vector;
  }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
  }
}
