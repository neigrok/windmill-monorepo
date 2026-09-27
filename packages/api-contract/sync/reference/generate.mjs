#!/usr/bin/env node
// Generates the golden corpus (../corpus) from the reference model. `--check` writes nothing and exits
// 1 when any file on disk differs from what the reference generates, or is no longer generated.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSTANTS } from './core/constants.js';
import * as admitVectors from './vectors/admit.js';
import * as coalesceVectors from './vectors/coalesce.js';
import * as commitVectors from './vectors/commit.js';
import * as digestVectors from './vectors/digest.js';
import * as deriveVectors from './vectors/derive.js';
import * as fracindexVectors from './vectors/fracindex.js';
import * as hlcVectors from './vectors/hlc.js';
import * as holdVectors from './vectors/hold.js';
import * as identityVectors from './vectors/identity.js';
import * as jcsVectors from './vectors/jcs.js';
import * as joinVectors from './vectors/join.js';
import * as lineageVectors from './vectors/lineage.js';
import * as liveVectors from './vectors/live.js';
import * as machineVectors from './vectors/machine.js';
import * as pagesVectors from './vectors/pages.js';
import * as protocolVectors from './vectors/protocol.js';
import * as pushVectors from './vectors/push.js';
import * as pullVectors from './vectors/pull.js';
import * as refusalVectors from './vectors/refusal.js';
import * as stampVectors from './vectors/stamp.js';
import * as textVectors from './vectors/text.js';
import * as viewVectors from './vectors/view.js';
import * as writeVectors from './vectors/write.js';

const BUILDERS = [
  stampVectors, hlcVectors, jcsVectors, joinVectors, deriveVectors, identityVectors, fracindexVectors, digestVectors, machineVectors, textVectors, admitVectors, pushVectors, pullVectors, liveVectors, pagesVectors, viewVectors, commitVectors, coalesceVectors, holdVectors, refusalVectors, writeVectors, lineageVectors, protocolVectors,
];

export const CORPUS = fileURLToPath(new URL('../corpus/', import.meta.url));

export function generate() {
  const files = { 'constants.json': CONSTANTS };
  for (const builder of BUILDERS) {
    for (const [path, content] of Object.entries(builder.files())) {
      if (Object.hasOwn(files, path)) throw new Error(`two builders write ${path}`);
      files[path] = content;
    }
  }
  const texts = {};
  for (const [path, content] of Object.entries(files)) {
    texts[path] = path.endsWith('.jsonl') ? `${content.map((line) => JSON.stringify(line)).join('\n')}\n` : `${JSON.stringify(content, null, 2)}\n`;
  }
  return texts;
}

function onDisk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...onDisk(path));
    else if (/\.jsonl?$/.test(entry.name)) found.push(relative(CORPUS, path));
  }
  return found;
}

export function diff(texts) {
  const problems = [];
  for (const [path, text] of Object.entries(texts)) {
    let current = null;
    try {
      current = readFileSync(join(CORPUS, path), 'utf8');
    } catch {
      problems.push(`${path}: missing`);
      continue;
    }
    if (current !== text) problems.push(`${path}: differs`);
  }
  for (const path of onDisk(CORPUS)) if (!Object.hasOwn(texts, path)) problems.push(`${path}: no longer generated`);
  return problems;
}

function write(texts) {
  for (const path of onDisk(CORPUS)) if (!Object.hasOwn(texts, path)) rmSync(join(CORPUS, path));
  for (const [path, text] of Object.entries(texts)) {
    mkdirSync(dirname(join(CORPUS, path)), { recursive: true });
    writeFileSync(join(CORPUS, path), text);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const texts = generate();
  if (process.argv.includes('--check')) {
    const problems = diff(texts);
    for (const problem of problems) console.error(problem);
    process.exit(problems.length ? 1 : 0);
  }
  write(texts);
  const count = (text, path) => (path.endsWith('.jsonl') ? text.trim().split('\n').length : Array.isArray(JSON.parse(text)) ? JSON.parse(text).length : 1);
  for (const [path, text] of Object.entries(texts).sort()) console.log(`${String(count(text, path)).padStart(5)}  ${path}`);
}
