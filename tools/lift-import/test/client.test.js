import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GymClient, GymRefusal } from '../client.js';

function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function clientOver(replies) {
  const calls = [];
  const client = new GymClient({
    baseUrl: 'http://localhost:8080/',
    token: 'secret',
    backoffMs: 0,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { client, calls };
}

describe('the conversation', () => {
  it('sends the credential and the json body, and unwraps the reply', async () => {
    const { client, calls } = clientOver([reply(200, { id: 'ses_x', startedAt: 7 })]);
    deepStrictEqual(await client.startSession('ses_x', 7), { id: 'ses_x', startedAt: 7 });
    strictEqual(calls.length, 1);
    strictEqual(calls[0].url, 'http://localhost:8080/v1/gym/sessions');
    strictEqual(calls[0].method, 'POST');
    strictEqual(calls[0].headers.authorization, 'Bearer secret');
    strictEqual(calls[0].body, '{"id":"ses_x","startedAt":7}');
  });

  it('unwraps the catalog', async () => {
    const { client } = clientOver([reply(200, { exercises: [{ id: 'dip', name: 'Dip' }] })]);
    deepStrictEqual(await client.exercises(), [{ id: 'dip', name: 'Dip' }]);
  });
});

describe('the retry rule', () => {
  it('treats 400 as terminal — retrying never makes a body readable', async () => {
    const { client, calls } = clientOver([reply(400, { error: 'no such exercise', code: 'unknown-exercise' })]);
    const failure = await client.appendSet('ses_x', {}).catch((error) => error);
    strictEqual(failure instanceof GymRefusal, true);
    strictEqual(failure.status, 400);
    strictEqual(failure.code, 'unknown-exercise');
    strictEqual(failure.sentence, 'no such exercise');
    strictEqual(calls.length, 1);
  });

  it('treats 409 as terminal, and carries the machine word rather than the sentence', async () => {
    const { client, calls } = clientOver([reply(409, { error: 'that session is finished', code: 'session-finished' })]);
    const failure = await client.appendSet('ses_x', {}).catch((error) => error);
    strictEqual(failure.status, 409);
    strictEqual(failure.code, 'session-finished');
    strictEqual(calls.length, 1);
  });

  it('retries a 500 and lands the write', async () => {
    const { client, calls } = clientOver([
      reply(500, { error: 'internal error' }),
      reply(500, { error: 'internal error' }),
      reply(200, { id: 'set_x' }),
    ]);
    deepStrictEqual(await client.appendSet('ses_x', {}), { id: 'set_x' });
    strictEqual(calls.length, 3);
  });

  it('retries a dropped connection and lands the write', async () => {
    const { client, calls } = clientOver([new Error('ECONNREFUSED'), reply(200, { id: 'set_x' })]);
    deepStrictEqual(await client.appendSet('ses_x', {}), { id: 'set_x' });
    strictEqual(calls.length, 2);
  });

  it('gives up after the last attempt rather than looping forever', async () => {
    const { client, calls } = clientOver([
      reply(500, {}), reply(500, {}), reply(500, {}), reply(500, {}),
    ]);
    await rejects(() => client.finishSession('ses_x', 7), GymRefusal);
    strictEqual(calls.length, 4);
  });
});
