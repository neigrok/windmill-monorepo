import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { API_BASE } from '../../../../src/shell/apiBase.js';
import { AUDIO_CAP_BYTES, TRANSCRIBE_DEADLINE_MS, TalkError, talkApi } from '../../../../src/products/journal/talk/talkApi.js';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

function serve(...answers) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return calls;
}

const answer = (status, body) => ({
  ok: status < 400,
  status,
  json: async () => { if (body === undefined) throw new SyntaxError('no body'); return body; },
});

test('a take goes up as its own bytes and type, with the session, and its transcript comes back', async () => {
  const calls = serve(answer(200, { text: 'rain all morning' }));
  const audio = new Blob(['opus-bytes'], { type: 'audio/webm' });

  assert.equal(await talkApi.transcribe(audio), 'rain all morning');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API_BASE}/v1/journal/transcribe`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'include');
  assert.deepEqual(calls[0].options.headers, { 'content-type': 'audio/webm' });
  assert.equal(calls[0].options.body, audio);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('a refused take throws what the server said, and a body that is not JSON reads as nothing said', async () => {
  const body = { code: 'voice_ration_spent', error: 'talk has had its turn for now', retryAtMs: 1_799_000_000_000 };
  serve(answer(429, body), answer(524, undefined));

  await assert.rejects(talkApi.transcribe(new Blob(['a'])), (error) => error instanceof TalkError && error.status === 429
    && JSON.stringify(error.body) === JSON.stringify(body));
  await assert.rejects(talkApi.transcribe(new Blob(['a'])), (error) => error instanceof TalkError && error.status === 524
    && JSON.stringify(error.body) === '{}');
});

test('a success that carries no transcript is not a transcript: it throws, so the take is kept', async () => {
  serve(answer(200, undefined), answer(200, { words: 'not the field' }));

  for (let call = 0; call < 2; call += 1) {
    await assert.rejects(talkApi.transcribe(new Blob(['a'])), (error) => error instanceof TalkError && error.status === 200
      && JSON.stringify(error.body) === '{}');
  }
});

test('a take with no answer throws the fetch’s own error, so the sheet can tell the network from a refusal', async () => {
  const lost = new TypeError('Failed to fetch');
  serve(lost);

  await assert.rejects(talkApi.transcribe(new Blob(['a'])), (error) => error === lost);
});

// The client gives up only after the server would have: its wait for the vendor plus the largest take's upload.
test('the client waits out the server’s own bound on a take, and the recorder stops under the server’s cap', async () => {
  const replyWait = await readFile(new URL('../../../../../backend/platform/adapters/http/ReplyWait.h', import.meta.url), 'utf8');
  const voiceApi = await readFile(new URL('../../../../../backend/products/journal/adapters/http/VoiceApi.h', import.meta.url), 'utf8');
  const idleSeconds = Number(/kIdleConnectionLimit\{(\d+)\}/.exec(replyWait)[1]);
  const [, mebibytes] = /kMaxAudioBytes = (\d+) \* 1024 \* 1024;/.exec(voiceApi);

  assert.equal(AUDIO_CAP_BYTES, Number(mebibytes) * 1024 * 1024);
  assert.equal(TRANSCRIBE_DEADLINE_MS, idleSeconds * 1000 + 60_000);
});

test('the allowance read hands back the ledger’s object, and nothing when the ledger is off or silent', async () => {
  const read = { code: 'subject_exhausted', remaining: '0.000000000', reserved: '0.000000000', resetsAtMs: 1, status: 'exhausted' };
  const calls = serve(answer(200, read), answer(503, { code: 'ai_allowance_disabled', error: 'AI allowances are not enabled.' }),
    new TypeError('Failed to fetch'));

  assert.deepEqual(await talkApi.allowance(), read);
  assert.equal(await talkApi.allowance(), null);
  assert.equal(await talkApi.allowance(), null);
  assert.deepEqual(calls.map(({ url, options }) => [url, options.method ?? 'GET', options.credentials]),
    Array(3).fill([`${API_BASE}/v1/ai/allowance`, 'GET', 'include']));
});

// Every SubscriptionResponse the contract names, as Talk reads it: a date only where Windmill One goes on past it.
test('the plan renews only where the subscription contract says Windmill One will charge again', async () => {
  const contract = JSON.parse(await readFile(
    new URL('../../../../../packages/api-contract/subscriptions/subscription.json', import.meta.url), 'utf8'));
  const renews = {};
  for (const { name, body } of contract.examples) {
    serve(answer(200, body));
    renews[name] = await talkApi.renews();
  }

  assert.deepEqual(renews, {
    active: true,
    cancelled_access_continues: false,
    grace: true,
    on_hold: false,
    expired_line_open: false,
    revoked_line_open: false,
    never_subscribed_line_open: false,
    allowlisted_never_subscribed_line_open: false,
    never_subscribed_line_closed: false,
    owner_line_open: false,
    charged_twice: true,
    sandbox_allowlisted: true,
    sandbox_not_allowlisted_line_open: false,
  });
});

test('a subscription read that cannot say, in any shape, renews nothing', async () => {
  const calls = serve(answer(200, { status: 'active', active: true, subscriptionId: 'sub_1' }), answer(401, { error: 'sign in first' }),
    new TypeError('Failed to fetch'));

  assert.deepEqual([await talkApi.renews(), await talkApi.renews(), await talkApi.renews()], [false, false, false]);
  assert.deepEqual(calls.map(({ url }) => url), Array(3).fill(`${API_BASE}/v1/subscription`));
});
