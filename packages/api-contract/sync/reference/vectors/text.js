// text/{tokens,script,diff3,merge}.json: the §6.11 text merge, from tokenization to base resolution.

import { diff3, editScript, mergeText, mergedFlag, tokenize } from '../server/textmerge.js';
import { vector } from './fixtures.js';

const TOKENS = [
  ['empty text has no tokens', ''],
  ['a single space', ' '],
  ['one word', 'word'],
  ['words and a space', 'a b'],
  ['runs of whitespace are one token', '  a  \t b  '],
  ['tab, newline, vertical tab, form feed, carriage return', 'a\tb\nc\u000bd\u000ce\rf'],
  ['no-break space is whitespace', 'a b'],
  ['ogham space, en quad..hair space, narrow no-break space', 'a b c d e'],
  ['line and paragraph separators are whitespace', 'a b c'],
  ['medium mathematical space and ideographic space', 'a b　c'],
  ['the byte-order mark is whitespace', 'a﻿b'],
  ['zero-width space is not whitespace', 'a​b'],
  ['next line (U+0085) is not whitespace', 'a\u0085b'],
  ['mongolian vowel separator is not whitespace', 'a᠎b'],
  ['punctuation stays in its word', 'hello, world!'],
];

const SCRIPTS = [
  ['equal texts keep everything', 'a b', 'a b'],
  ['from empty: insert every token', '', 'x y'],
  ['to empty: delete every token', 'x y', ''],
  ['a replacement: the deletion comes first', 'a', 'b'],
  ['a replacement inside a sentence', 'a b c', 'a x c'],
  ['a duplicate token: equal tokens are kept first, so the insertion follows them', 'a b', 'a a b'],
  ['a duplicate token: equal tokens are kept first, so the deletion follows them', 'a a b', 'a b'],
  ['a repeated phrase: the kept copy comes first, the new one is appended', 'x y', 'x y x y'],
  ['a reorder', 'a b c', 'c b a'],
  ['a whitespace run changes width', 'a  b', 'a b'],
  ['leading and trailing whitespace go', ' a ', 'a'],
  ['a word appended', 'hello world', 'hello world again'],
  ['a word inserted in the middle', 'hello world', 'hello big world'],
  ['one token becomes two', 'x', 'y z'],
];

const DIFF3 = [
  ['nobody changed anything', 'a b c', 'a b c', 'a b c'],
  ['only head changed', 'a b c', 'a x c', 'a b c'],
  ['only mine changed', 'a b c', 'a b c', 'a b y'],
  ['changes far apart both apply', 'one two three four', 'ONE two three four', 'one two three FOUR'],
  ['the same change on both sides is emitted once', 'a b c', 'a x c', 'a x c'],
  ['different changes to one token conflict', 'a b c', 'a x c', 'a y c'],
  ['changes in neighbouring words both apply: a stable space separates them', 'a b c', 'x b c', 'a y c'],
  ['changes separated by one stable token both apply', 'a b', 'x b', 'a y'],
  ['each side\'s copy of a repeated word survives (INV-12 counts tokens, not kinds)', 'a b c', 'a b b c', 'a b c b'],
  ['whitespace-only on both sides never conflicts: head\'s whitespace', 'a b', 'a  b', 'a\tb'],
  ['a word change beats a whitespace-only edit touching it (head\'s word)', 'a b c', 'a x c', 'a b  c'],
  ['a word change beats a whitespace-only edit touching it (mine\'s word)', 'a b c', 'a b  c', 'a x c'],
  ['a deletion beats a whitespace-only edit inside it', 'keep this part end', 'keep end', 'keep  this part end'],
  ['a word change on both sides still conflicts beside a whitespace edit', 'a b c', 'a x  c', 'a y c'],
  ['head deletes a region mine edits: mine is emitted', 'keep this part end', 'keep end', 'keep this PART end'],
  ['mine deletes a region head edits: head is emitted', 'keep this part end', 'keep THIS part end', 'keep end'],
  ['both insert different text at one point: conflict', 'a b', 'a x b', 'a y b'],
  ['both insert the same text at one point: once', 'a b', 'a x b', 'a x b'],
  ['head appends while mine prepends', 'middle', 'middle end', 'start middle'],
  ['the conflict seam drops the head side\'s trailing whitespace', 'p q', 'p x ', 'p y '],
  ['the conflict seam drops the mine side\'s leading whitespace', 'p q r', 'p X r', 'p  Y r'],
  ['both sides rewrite one word, each widening a space: a conflict', 'a b c', 'a x  c', 'a  y c'],
  ['multi-line journal edits in different paragraphs', 'Walked.\n\nRead a book.', 'Walked far.\n\nRead a book.', 'Walked.\n\nRead a good book.'],
  ['both sides rewrite the same line', 'Mood: fine', 'Mood: great', 'Mood: tired'],
];

const STORED = { text: 'hello world', rev: 7, merged: false };

// MERGE_WORK_CELLS at 4 194 304 = 2048²: 1024 one-letter words are 2047 tokens, so a script between two
// such texts takes exactly the bound, and one more token takes it over.
const WORDS = (first, last) => [first, ...Array(1022).fill('w'), last].join(' ');
const AT_BOUND = { text: WORDS('x', 'w'), rev: 9, merged: false };
const REVISIONS = [{ rev: 3, text: 'hello' }];

function merge(name, stored, base, mine, revisions = []) {
  const outcome = mergeText({ stored, base, mine, revisionText: (rev) => revisions.find((revision) => revision.rev === rev)?.text });
  const expect = outcome.refuse
    ? { refuse: outcome.refuse }
    : { text: outcome.text, conflict: outcome.conflict, merged: mergedFlag(stored, outcome), baseText: outcome.baseText };
  return vector(name, { stored, base, mine, revisions }, expect);
}

export function files() {
  return {
    'text/tokens.json': TOKENS.map(([name, text]) => vector(name, { text }, { tokens: tokenize(text) })),
    'text/script.json': SCRIPTS.map(([name, a, b]) => vector(name, { a, b }, { script: editScript(tokenize(a), tokenize(b)).map((step) => [step.op, step.token]) })),
    'text/diff3.json': DIFF3.map(([name, base, head, mine]) => vector(name, { base, head, mine }, diff3(base, head, mine))),
    'text/merge.json': [
      merge('a {rev} equal to the head rev: base is head, so mine wins', STORED, { rev: 7 }, 'hello there'),
      merge('a {rev} found among the revisions merges', STORED, { rev: 3 }, 'hi hello', REVISIONS),
      merge('a {rev} neither head nor kept is base-unknown', STORED, { rev: 2 }, 'hello there', REVISIONS),
      merge('a {text} base merges like a found rev', STORED, { text: 'hello' }, 'hi hello'),
      merge('empty base, mine extends head: base becomes head', { text: 'a b', rev: 4, merged: false }, { text: '' }, 'a b c'),
      merge('empty base, head extends mine: base becomes mine, head stays', { text: 'a b c', rev: 4, merged: false }, { text: '' }, 'a b'),
      merge('empty base, neither extends: both inserts conflict', { text: 'x', rev: 4, merged: false }, { text: '' }, 'y'),
      merge('mine equal to head: head', STORED, { rev: 3 }, 'hello world', REVISIONS),
      merge('base equal to mine: head', STORED, { text: 'hello' }, 'hello'),
      merge('a never-written field takes the first text', { text: '', rev: 0, merged: false }, { text: '' }, 'first'),
      merge('a {rev: 0} on a never-written field is the head', { text: '', rev: 0, merged: false }, { rev: 0 }, 'first'),
      merge('merged resets when the writer saw the head', { text: 'x\n\ny', rev: 9, merged: true }, { rev: 9 }, 'x and y'),
      merge('merged stays while the base is older than the head', { text: 'x\n\ny tail', rev: 9, merged: true }, { text: 'x\n\ny' }, 'START x\n\ny'),
      merge('a conflict sets merged', { text: 'a x c', rev: 9, merged: false }, { text: 'a b c' }, 'a y c'),
      merge('diff3 scripts of exactly MERGE_WORK_CELLS cells merge region by region', AT_BOUND, { text: WORDS('w', 'w') }, WORDS('w', 'y')),
      merge('a diff3 script over MERGE_WORK_CELLS cells makes the whole text one conflict, and merged', AT_BOUND, { text: WORDS('w', 'w') }, `${WORDS('w', 'y')} `),
    ],
  };
}
