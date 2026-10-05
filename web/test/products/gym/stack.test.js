import assert from 'node:assert/strict';
import test from 'node:test';
import { stopOwnedServer, waitUntil } from './stack.mjs';

test('local stack readiness accepts a late answer without reading process output', async () => {
  let attempts = 0;
  await waitUntil(() => ++attempts === 3, { timeout: 1000, interval: 1 });
  assert.equal(attempts, 3);
});

test('local stack readiness refuses a server that never answers', async () => {
  await assert.rejects(waitUntil(() => false, { timeout: 10, interval: 1, label: 'server readiness' }), /server readiness: timed out/);
});

test('local stack readiness bounds a stalled request', async () => {
  await assert.rejects(waitUntil(() => new Promise(() => {}), { timeout: 10, label: 'stalled request' }), /stalled request: timed out/);
});

test('local stack readiness refuses early clean exits and crashes', async () => {
  for (const process of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: 'SIGSEGV' }]) {
    await assert.rejects(waitUntil(() => true, { processes: [process] }), /process exited before readiness/);
  }
});

test('local stack readiness exposes startup failures', async () => {
  const error = new Error('ENOENT');
  await assert.rejects(waitUntil(() => true, { processes: [{ startError: error, exitCode: null, signalCode: null }] }),
    (failure) => failure.message.endsWith('process could not start') && failure.cause === error);
});

test('local stack shutdown stops only the process listening on its owned port', async () => {
  const signals = [];
  const child = { pid: 123, exitCode: null, signalCode: null };
  await stopOwnedServer({ child, port: 8094 }, () => child.signalCode ? '' : '123', { kill: (pid, signal) => {
    signals.push([pid, signal]); child.signalCode = signal;
  } });
  assert.deepEqual(signals, [[123, 'SIGTERM']]);
});

test('local stack shutdown accepts a process that already crashed', async () => {
  await stopOwnedServer({ child: { pid: 123, exitCode: null, signalCode: 'SIGSEGV' }, port: 8094 }, () => '',
    { kill: () => assert.fail('a dead process must not be signaled') });
});

test('local stack shutdown refuses an unrelated listener', async () => {
  await assert.rejects(stopOwnedServer({ child: { pid: 123, exitCode: null, signalCode: null }, port: 8094 }, () => '456',
    { kill: () => assert.fail('an unrelated listener must not be signaled') }), /refusing to stop unrelated port 8094 listener/);
});

test('local stack shutdown reports a hang while still force-cleaning its process', async () => {
  const signals = [];
  const child = { pid: 123, exitCode: null, signalCode: null, kill: (signal) => {
    signals.push(signal); child.signalCode = signal;
  } };
  await assert.rejects(stopOwnedServer({ child, port: 8094 }, () => child.signalCode ? '' : '123',
    { timeout: 10, kill: (_pid, signal) => signals.push(signal) }), /port 8094 shutdown: timed out/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
