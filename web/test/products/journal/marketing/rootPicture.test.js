import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// `node --test` speaks no JSX, so the shared loader compiles the picture on the way in.
register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { JournalPicture } = await import('../../../../src/products/journal/marketing/RootPicture.jsx');

const CSS = readFileSync(new URL('../../../../src/products/journal/marketing/journalRootPicture.css', import.meta.url), 'utf8');
const html = renderToStaticMarkup(React.createElement(JournalPicture));
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the picture is three days of the page with one echo beside it, verbatim', () => {
  assert.equal(text(html), 'Tue 08 Sep The first ten minutes were the hardest. After that, the water made sense. I stopped trying to control everything and started paying attention. Wed 09 Sep Stayed out until the light changed. The walk home was longer than it needed to be. I think that was the point. Thu 10 Sep · Today Walked the long way home. No headphones this time. The city was louder than I remembered. So was my head. By the river, both got quiet. Echo 18 April “Took the path by the river. Ten minutes without my phone and I could hear myself think again.” From your own pages Go to page');
});

test('the picture keeps the journal’s night canvas whatever the page wears', () => {
  assert.match(html, /^<div class="jnPicture" data-brand="journal" data-theme="dark">/);
  assert.ok(!/\[data-theme/.test(CSS), 'a theme rule repaints a picture its own canvas already answers for');
});

test('the picture is still, free of raw colour, and holds nothing a person could press', () => {
  assert.ok(!/<(a|button|input|details|summary)[ >]|tabindex|onclick|href=/i.test(html), 'the picture draws a control');
  assert.match(html, /<span class="jnPicture-go">Go to page<\/span>/, 'the echo’s door is a styled span, not a control');
  assert.ok(!/animation|style=/.test(html), 'the picture carries motion or an inline style');
  assert.ok(!/animation|@keyframes|#[0-9a-fA-F]{3,6}\b/.test(CSS), 'the sheet animates or names a raw colour');
});
