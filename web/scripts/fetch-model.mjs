import { mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const BASE = 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main';
const OUT_DIR = path.join(import.meta.dirname, '..', 'public', 'models', 'Xenova', 'bge-small-en-v1.5');

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
  for (const file of FILES) {
    const destPath = path.join(OUT_DIR, file);
    if (await existsNonEmpty(destPath)) {
      console.log(`present, skipping ${file}`);
      continue;
    }
    await mkdir(path.dirname(destPath), { recursive: true });
    await download(`${BASE}/${file}`, destPath);
    const { size } = await stat(destPath);
    console.log(`fetched ${file} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
