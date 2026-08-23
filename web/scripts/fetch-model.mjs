import { mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

// Two models, one directory, because deploy bind-mounts the directory whole
// (services/embedder/README.md) and each side loads only the repo it names: the browser worker
// bge-small-en-v1.5 for journal search, the embedder sidecar the multilingual MiniLM for echoes.
const REPOS = ['Xenova/bge-small-en-v1.5', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'];

const MODELS_DIR = path.join(import.meta.dirname, '..', 'public', 'models');

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
];

async function existsNonEmpty(filePath) {
  try {
    const s = await stat(filePath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function downloadOnce(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch failed: ${url} -> ${res.status} ${res.statusText}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

async function download(url, destPath) {
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await downloadOnce(url, destPath);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.warn(`retrying (${attempt}/${attempts}) after error: ${err.message}`);
    }
  }
}

async function main() {
  for (const repo of REPOS) {
    for (const file of FILES) {
      const destPath = path.join(MODELS_DIR, repo, file);
      if (await existsNonEmpty(destPath)) {
        console.log(`present, skipping ${repo}/${file}`);
        continue;
      }
      await mkdir(path.dirname(destPath), { recursive: true });
      await download(`https://huggingface.co/${repo}/resolve/main/${file}`, destPath);
      const { size } = await stat(destPath);
      console.log(`fetched ${repo}/${file} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
