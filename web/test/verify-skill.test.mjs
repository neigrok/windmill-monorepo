import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const skill = readFileSync(new URL('../../.claude/skills/verify/SKILL.md', import.meta.url), 'utf8');
const section = skill.split('## Backend suites\n')[1].split('\n## ')[0];
const recipes = [...section.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]);

function execute(recipe, failure = '') {
  const directory = mkdtempSync(join(tmpdir(), 'verify-recipe-'));
  try {
    const log = join(directory, 'calls.jsonl');
    for (const program of ['cmake', 'ctest', 'createdb', 'psql', 'dropdb']) {
      const path = join(directory, program);
      writeFileSync(path, `#!${process.execPath}\n` + `
        const fs = require('node:fs');
        fs.appendFileSync(process.env.RECIPE_LOG, JSON.stringify({
          program: ${JSON.stringify(program)}, args: process.argv.slice(2),
          postgres: process.env.WM_PG_TEST ?? null,
          rest: process.env.DATABASE_URL ?? null, sync: process.env.WM_SYNC_DATABASE_URL ?? null,
        }) + '\\n');
        if (process.env.RECIPE_FAILURE === ${JSON.stringify(program)}) process.exitCode = 1;
      `);
      chmodSync(path, 0o755);
    }
    const result = spawnSync('sh', ['-eu', '-c', recipe], { encoding: 'utf8', env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, RECIPE_LOG: log,
      WM_VERIFY_DB_PREFIX: 'cf_recipe', WM_PG_TEST: '', DATABASE_URL: '', WM_SYNC_DATABASE_URL: '',
      CTEST_PARALLEL_LEVEL: '8',
      RECIPE_FAILURE: failure,
    } });
    assert.equal(result.status, failure ? 1 : 0, result.stderr);
    return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('verify skill configures and runs the complete non-Postgres gate explicitly', () => {
  const calls = execute(recipes[0]);
  assert.deepEqual(calls.filter(({ program }) => program === 'cmake').map(({ args }) => args), [
    ['-S', 'backend', '-B', 'backend/build'], ['--build', 'backend/build', '-j8'],
  ]);
  assert.deepEqual(calls.filter(({ program }) => program === 'ctest'), [{
    program: 'ctest', args: ['--test-dir', 'backend/build', '--parallel', '1', '-V'],
    postgres: null, rest: null, sync: null,
  }]);
});

test('verify skill drops both isolated databases when a suite fails', () => {
  const calls = execute(recipes[1], 'ctest');
  assert.deepEqual(calls.filter(({ program }) => program === 'dropdb').map(({ args }) => args),
    calls.filter(({ program }) => program === 'createdb').map(({ args }) => args));
});

test('verify skill gives every Postgres suite two initialized databases and cleans both', () => {
  const calls = execute(recipes[1]);
  const databases = calls.filter(({ program }) => program === 'createdb').map(({ args }) => args.at(-1));
  assert.equal(databases.length, 2);
  assert.notEqual(databases[0], databases[1]);
  const urls = databases.map((database) => `postgresql:///${database}?host=/tmp`);
  assert.deepEqual(calls.filter(({ program }) => program === 'psql').map(({ args }) => args), [
    [urls[0], '-v', 'ON_ERROR_STOP=1', '-f', 'backend/db/schema.sql'],
    [urls[1], '-v', 'ON_ERROR_STOP=1', '-f', 'backend/db/schema.sql', '-f', 'backend/db/probe.sql'],
  ]);
  assert.deepEqual(calls.filter(({ program }) => program === 'ctest'), [{
    program: 'ctest', args: ['--test-dir', 'backend/build', '--parallel', '1', '-V'],
    postgres: '1', rest: urls[0], sync: urls[1],
  }]);
  assert.deepEqual(calls.filter(({ program }) => program === 'dropdb').map(({ args }) => args),
    databases.map((database) => ['-h', '/tmp', database]));
});
