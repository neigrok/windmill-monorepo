import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { APP_LOCALE, createTranslator, resolveLocale } from '../../../src/platform/i18n/index.js';

test('the app locale resolves the browser languages against the available set, so it is English under any of them', () => {
  assert.equal(APP_LOCALE, 'en');
  assert.deepEqual([[], ['de-DE', 'ru'], ['ar'], ['EN-gb'], ['en-US', 'de']].map((requested) => resolveLocale(requested)), ['en', 'en', 'en', 'en', 'en']);
  assert.deepEqual([['de-AT'], ['pt-BR', 'de'], ['fr']].map((requested) => resolveLocale(requested, ['en', 'de'])), ['de', 'de', 'en']);
});

test('t reads a key from the locale catalog and the plural category from that locale', () => {
  const message = '{count, plural, one {# step} two {# steps (two)} other {# steps}}';
  const english = createTranslator({ en: { 'x.steps': message, 'x.hi': 'Hi, {name}' } });
  const arabic = createTranslator({ en: { 'x.steps': message }, ar: { 'x.steps': message } }, { locale: 'ar' });
  assert.deepEqual([english('x.hi', { name: 'Ada' }), english('x.steps', { count: 2 }), arabic('x.steps', { count: 2 })], ['Hi, Ada', '2 steps', '2 steps (two)']);
});

test('an element argument makes t return one fragment that renders in place', () => {
  const t = createTranslator({ en: { 'x.trained': 'Last trained {when} · {count, plural, one {# set} other {# sets}}' } });
  const line = createElement('p', null, t('x.trained', { when: createElement('strong', null, 'Monday'), count: 3 }));
  assert.equal(renderToStaticMarkup(line), '<p>Last trained <strong>Monday</strong> · 3 sets</p>');
});

test('outside production a missing key or argument throws, naming the key', () => {
  const t = createTranslator({ en: { 'x.hi': 'Hi, {name}' } });
  const failures = [() => t('x.nope'), () => t('x.hi')].map((call) => { try { call(); return null; } catch (error) { return error.message; } });
  assert.deepEqual(failures, [
    'i18n: "x.nope" cannot be shown: the en catalog has no "x.nope"',
    'i18n: "x.hi" cannot be shown: message needs the argument "name"',
  ]);
});

test('in production a missing key or argument renders the key and reports it once per key', () => {
  const reported = [];
  const t = createTranslator({ en: { 'x.hi': 'Hi, {name}', 'x.ok': 'Fine' } }, { strict: false, onMissing: (key) => reported.push(key) });
  const shown = [t('x.nope'), t('x.nope'), t('x.hi'), t('x.hi', {}), t('x.ok'), t('x.nope')];
  assert.deepEqual(shown, ['x.nope', 'x.nope', 'x.hi', 'x.hi', 'Fine', 'x.nope']);
  assert.deepEqual(reported, ['x.nope', 'x.hi']);
});

test('the production build reports a missing message to Sentry under i18n-missing-message, tagged with the key alone', async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/platform/i18n/index.js', import.meta.url))],
    bundle: true, write: false, format: 'iife', globalName: 'i18n', logLevel: 'silent',
    define: { 'import.meta.env': JSON.stringify({ PROD: true, VITE_SENTRY_DSN: 'https://abc@errors.example/42' }), 'process.env.NODE_ENV': '"production"' },
  });
  const sent = [];
  const { createTranslator: productionTranslator } = runInNewContext(`${outputFiles[0].text}\ni18n`, {
    window: { location: { hostname: 'windmill.works', hash: '#/gym/log', pathname: '/app' }, addEventListener() {} },
    navigator: { languages: ['ru-RU', 'de'] },
    crypto: { randomUUID: () => '00000000-0000-0000-0000-000000000001' },
    fetch: (url, request) => { sent.push({ url, body: request.body }); return Promise.resolve(); },
  });
  const t = productionTranslator({ en: { 'gym.title': 'Gym' } });
  assert.deepEqual([t('gym.title'), t('gym.nope'), t('gym.nope')], ['Gym', 'gym.nope', 'gym.nope']);
  const events = sent.map(({ body }) => JSON.parse(body.split('\n')[2]));
  assert.deepEqual(events.map(({ tags, request, exception }) => ({ tags, request, type: exception.values[0].type, value: exception.values[0].value, frames: exception.values[0].stacktrace.frames })), [
    { tags: { key: 'gym.nope', kind: 'i18n' }, request: { url: '/app/gym' }, type: 'i18n', value: 'i18n-missing-message', frames: [] },
  ]);
  assert.deepEqual(sent.map(({ url }) => url), ['https://errors.example/api/42/envelope/']);
});
