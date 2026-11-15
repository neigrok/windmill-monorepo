import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('CLI caps actual worker overlap, executes every case and rejects invalid settings before execution', { timeout: 90000 }, async (t) => {
  const scratch = fileURLToPath(new URL('../../../.claude/scratch/concurrency/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'runner-'));
  const trace = join(directory, 'events.ndjson');
  const children = new Set();
  t.after(async () => {
    for (const child of children) process.kill(-child.pid, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
  });

  for (const stage of ['ordinary', 'performance']) {
    for (let file = 0; file < (stage === 'ordinary' ? 4 : 2); file += 1) {
      await writeFile(join(directory, `${stage}-${file}${stage === 'performance' ? '.perf' : ''}.test.mjs`), `
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

for (let index = 0; index < 2; index += 1) {
  const name = '${stage}-${file}-' + index;
  test(name, async () => {
    const event = (phase) => appendFileSync(process.env.WM_RUNNER_TRACE,
      JSON.stringify({ stage: '${stage}', name, phase, pid: process.pid }) + '\\n');
    event('start');
    try {
      if ('${stage}' === 'ordinary') {
        const deadline = Date.now() + 2500;
        while ((readFileSync(process.env.WM_RUNNER_TRACE, 'utf8').match(/"phase":"start"/g) ?? []).length < Number(process.env.WM_RUNNER_STARTS)) {
          assert.ok(Date.now() < deadline, 'synthetic expected workers did not overlap');
          await setTimeout(10);
        }
      }
      await setTimeout(60);
      if (process.env.WM_RUNNER_FAIL === '1' && name === 'ordinary-0-1') assert.fail('synthetic runner failure');
    } finally {
      event('end');
    }
  });
}
`);
    }
  }

  const run = async (setting, fail = false) => {
    await writeFile(trace, '');
    const expected = Math.min(Number(setting ?? 4), Math.max(1, availableParallelism() - 1));
    const env = { ...process.env, WM_RUNNER_TRACE: trace, WM_RUNNER_STARTS: String(expected), WM_RUNNER_FAIL: fail ? '1' : '0' };
    delete env.NODE_TEST_CONTEXT;
    delete env.WM_TEST_CONCURRENCY;
    if (setting !== undefined) env.WM_TEST_CONCURRENCY = setting;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/test.mjs', import.meta.url)), directory],
      { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      process.kill(-child.pid, 'SIGKILL');
    }, 15000);
    try {
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(expired, false, `test runner child exceeded 15 seconds\n${output}`);
      const events = (await readFile(trace, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
      return { ...result, output, events, expected };
    } finally {
      clearTimeout(timer);
      children.delete(child);
    }
  };

  for (const setting of ['1', '2', '3', '4', undefined]) {
    const result = await run(setting);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.signal, null);
    const active = new Set();
    const peak = { ordinary: 0, performance: 0 };
    for (const event of result.events) {
      if (event.phase === 'start') {
        active.add(event.pid);
        peak[event.stage] = Math.max(peak[event.stage], active.size);
      } else {
        active.delete(event.pid);
      }
    }
    assert.deepEqual(peak, { ordinary: result.expected, performance: 1 });
    assert.deepEqual([...active], []);
    for (const phase of ['start', 'end']) {
      assert.deepEqual(result.events.filter((event) => event.phase === phase).map((event) => event.name).sort(), [
        'ordinary-0-0', 'ordinary-0-1', 'ordinary-1-0', 'ordinary-1-1',
        'ordinary-2-0', 'ordinary-2-1', 'ordinary-3-0', 'ordinary-3-1',
        'performance-0-0', 'performance-0-1', 'performance-1-0', 'performance-1-1',
      ]);
    }
  }

  const failure = await run('2', true);
  assert.equal(failure.code, 1, failure.output);
  assert.equal(failure.signal, null);
  assert.match(failure.output, /synthetic runner failure/);
  assert.deepEqual(failure.events.filter((event) => event.phase === 'end').map((event) => event.name).sort(), [
    'ordinary-0-0', 'ordinary-0-1', 'ordinary-1-0', 'ordinary-1-1',
    'ordinary-2-0', 'ordinary-2-1', 'ordinary-3-0', 'ordinary-3-1',
    'performance-0-0', 'performance-0-1', 'performance-1-0', 'performance-1-1',
  ]);

  for (const setting of ['', '0', '5', '01', '1.0', '+1', ' 1', '1 ', '2\n', 'NaN']) {
    const result = await run(setting);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(result.output, 'WM_TEST_CONCURRENCY must be exactly 1, 2, 3, or 4\n');
    assert.deepEqual(result.events, []);
  }
});
