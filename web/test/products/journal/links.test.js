import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findLinks, proseRuns } from '../../../src/products/journal/links.js';

const GOLDEN = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/journal-links.json', import.meta.url), 'utf8'));
const CANVAS = readFileSync(new URL('../../../src/products/journal/Canvas.jsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../../src/products/journal/journal.css', import.meta.url), 'utf8');

const hrefs = (text) => findLinks(text).map((link) => link.href);
const spans = (text) => findLinks(text).map((link) => text.slice(link.lo, link.hi));

// ─── the grammar iOS paints from the same file ────────────────────────────────────────────────────

test('every case in the shared golden, exactly — this is the file iOS reads too', () => {
  assert.ok(GOLDEN.cases.length >= 22, `the golden shrank to ${GOLDEN.cases.length} cases`);
  for (const one of GOLDEN.cases) {
    assert.deepEqual(findLinks(one.text), one.links, `${one.why} — ${JSON.stringify(one.text)}`);
  }
});

// ─── what counts as a link ────────────────────────────────────────────────────────────────────────

test('a scheme or a www is a link; a bare host in prose is not', () => {
  assert.deepEqual(hrefs('read https://example.com today'), ['https://example.com']);
  assert.deepEqual(hrefs('read http://example.com today'), ['http://example.com']);
  assert.deepEqual(hrefs('read www.example.com today'), ['https://www.example.com']);
  // The one that would ruin a page of writing.
  assert.deepEqual(hrefs('felt fine.Then it did not. e.g. things.Ok'), []);
  assert.deepEqual(hrefs('bought it from example.com'), []);
});

test('a scheme trusts any host; a www has to end in something that looks like a TLD', () => {
  assert.deepEqual(hrefs('http://localhost:8089/x'), ['http://localhost:8089/x']);
  assert.deepEqual(hrefs('www.'), []);
  assert.deepEqual(hrefs('www.x'), []);
  assert.deepEqual(hrefs('www.x.io'), ['https://www.x.io']);
  assert.deepEqual(hrefs('https://'), []);
});

test('a link glued to the end of a word is not a link', () => {
  assert.deepEqual(hrefs('nothttp://x.com'), []);
  assert.deepEqual(hrefs('me@www.example.com'), []);
  // but every ordinary separator still opens one
  for (const before of ['', ' ', '\n', '(', '“', '—']) {
    assert.deepEqual(hrefs(`${before}https://a.io`), ['https://a.io'], `after ${JSON.stringify(before)}`);
  }
});

test('the sentence keeps its own punctuation, and the URL keeps its own brackets', () => {
  assert.deepEqual(spans('see https://a.io/b.'), ['https://a.io/b']);
  assert.deepEqual(spans('see https://a.io/b, then'), ['https://a.io/b']);
  assert.deepEqual(spans('see https://a.io/b?q=1!'), ['https://a.io/b?q=1']);
  assert.deepEqual(spans('“https://a.io”'), ['https://a.io']);
  assert.deepEqual(spans('(see https://a.io/b)'), ['https://a.io/b']);
  assert.deepEqual(spans('https://en.wikipedia.org/wiki/Windmill_(machine)'), ['https://en.wikipedia.org/wiki/Windmill_(machine)']);
  assert.deepEqual(spans('(https://en.wikipedia.org/wiki/Windmill_(machine))'), ['https://en.wikipedia.org/wiki/Windmill_(machine)']);
});

test('a page holds as many links as it holds, in the order they were written', () => {
  const page = 'first www.a.io then https://b.io/x and last http://c.io';
  assert.deepEqual(hrefs(page), ['https://www.a.io', 'https://b.io/x', 'http://c.io']);
  assert.deepEqual(findLinks(page).map((l) => l.lo), [6, 20, 44]);
});

test('an empty page has no links, and neither has a page with no URL in it', () => {
  assert.deepEqual(findLinks(''), []);
  assert.deepEqual(findLinks('a quiet day, nothing to report'), []);
});

// ─── the runs the canvas paints ───────────────────────────────────────────────────────────────────

test('a page with no link and no hit is one plain run', () => {
  assert.deepEqual(proseRuns('a quiet day'), [
    { lo: 0, hi: 11, text: 'a quiet day', href: null, marked: false },
  ]);
});

test('a link splits the run and carries its href', () => {
  assert.deepEqual(proseRuns('see www.a.io now'), [
    { lo: 0, hi: 4, text: 'see ', href: null, marked: false },
    { lo: 4, hi: 12, text: 'www.a.io', href: 'https://www.a.io', marked: false },
    { lo: 12, hi: 16, text: ' now', href: null, marked: false },
  ]);
});

test('a search hit lights its own span and nothing either side of it', () => {
  assert.deepEqual(proseRuns('a quiet day', { highlight: { lo: 2, hi: 7 } }), [
    { lo: 0, hi: 2, text: 'a ', href: null, marked: false },
    { lo: 2, hi: 7, text: 'quiet', href: null, marked: true },
    { lo: 7, hi: 11, text: ' day', href: null, marked: false },
  ]);
});

test('a hit that lands inside a link cuts it into runs that are both link and lit', () => {
  // "a.io" of "www.a.io" — the two ranges overlap without either one wrapping the other
  const runs = proseRuns('see www.a.io now', { highlight: { lo: 8, hi: 12 } });
  assert.deepEqual(runs, [
    { lo: 0, hi: 4, text: 'see ', href: null, marked: false },
    { lo: 4, hi: 8, text: 'www.', href: 'https://www.a.io', marked: false },
    { lo: 8, hi: 12, text: 'a.io', href: 'https://www.a.io', marked: true },
    { lo: 12, hi: 16, text: ' now', href: null, marked: false },
  ]);
});

test('a hit that starts inside a link and runs out past it keeps both halves right', () => {
  const runs = proseRuns('see www.a.io now', { highlight: { lo: 8, hi: 16 } });
  assert.deepEqual(runs.map((run) => [run.text, run.href, run.marked]), [
    ['see ', null, false],
    ['www.', 'https://www.a.io', false],
    ['a.io', 'https://www.a.io', true],
    [' now', null, true],
  ]);
});

test('the runs always spell the page back, exactly', () => {
  for (const page of ['', 'a quiet day', 'see www.a.io now', 'a\n\nb https://x.io/y? c']) {
    assert.equal(proseRuns(page, { highlight: { lo: 0, hi: 2 } }).map((run) => run.text).join(''), page);
  }
});

// ─── the canvas and the composer paint the same one ───────────────────────────────────────────────

test('past prose and the composer paint are both runs, and only past prose is clickable', () => {
  assert.match(CANVAS, /className="journal-prose"><Prose text=\{day\.body\} highlight=\{highlight\} \/>/);
  assert.match(CANVAS, /className="journal-input-paint"[^>]*><Prose text=\{body\} inert \/>/);
  // inert paints a span, never an anchor: a click in the field has to place a caret
  assert.match(CANVAS, /if \(inert\) return <span key=\{run\.lo\} className="journal-link">/);
  assert.match(CANVAS, /target="_blank" rel="noreferrer noopener nofollow"/);
});

test('the field and the paint over it share every property that decides where a character lands', () => {
  const shared = CSS.match(/\.journal-input,\n\.journal-input-paint \{([^}]*)\}/);
  assert.ok(shared, 'the two layers are declared together');
  for (const property of ['font-family', 'font-size', 'line-height', 'width', 'padding', 'margin',
    'border', 'white-space', 'overflow-wrap', 'font-weight']) {
    assert.match(shared[1], new RegExp(`\\n\\s*${property}:`), `${property} is shared`);
  }
  // the field's own glyphs are transparent — the paint is what is read
  assert.match(CSS, /\.journal-input \{[^}]*color: transparent;/);
  assert.match(CSS, /\.journal-input \{[^}]*caret-color: var\(--lamp-400\);/);
  assert.match(CSS, /\.journal-input-paint \{[^}]*pointer-events: none;/);
});
