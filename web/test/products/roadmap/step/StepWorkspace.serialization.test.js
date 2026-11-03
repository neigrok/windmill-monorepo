import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import React from 'react';

register('../../../jsxLoader.mjs', import.meta.url);
const { readNote } = await import('../../../../src/products/roadmap/step/StepWorkspace.jsx');
const { renderMarkdown } = await import('../../../../src/products/roadmap/graph/tree/NodeWorkspace.jsx');
const { formatNote, NoteDocument } = await import('../../../../src/products/roadmap/model/NodeWorkspace.js');

function text(value) {
  return { nodeType: 3, nodeName: '#text', data: value, childNodes: [], parentNode: null };
}
function element(tag, children = [], attributes = {}) {
  const node = {
    nodeType: 1, nodeName: tag.toUpperCase(), childNodes: children, parentNode: null,
    getAttribute: (name) => name in attributes ? String(attributes[name]) : null,
    hasAttribute: (name) => name in attributes,
  };
  for (const child of children) child.parentNode = node;
  return node;
}
function fromReact(value) {
  if (value == null || value === false) return [];
  if (typeof value === 'string') return [text(value)];
  if (Array.isArray(value)) return value.flatMap(fromReact);
  if (value.type === React.Fragment) return fromReact(value.props.children);
  return [element(value.type, fromReact(value.props.children), value.props)];
}
function rendered(source) {
  return element('div', fromReact(renderMarkdown(source, { sourceMap: true })), { 'data-note-start': 0, 'data-note-end': source.length });
}
function projection(source) {
  return readNote(rendered(source));
}
function changed(note, canonical, selection, replacement) {
  const before = note.projection;
  const nextText = canonical.slice(0, selection.start) + replacement + canonical.slice(selection.end);
  const next = readNote(element('div', [text(nextText)]));
  next.selection = { start: selection.start + replacement.length, end: selection.start + replacement.length };
  note.change(next, selection);
  assert.equal(note.projection.text, nextText);
  assert.equal(note.projection.source.length, nextText.length);
  assert.ok(before !== note.projection);
  return note.text;
}

test('Chrome leading text, div lines and placeholder breaks preserve every typed line', () => {
  const root = element('div', [
    text('first'),
    element('div', [text('second')]),
    element('div', [element('br')]),
    element('div', [text('third')]),
  ]);
  assert.equal(readNote(root).text, 'first\nsecond\n\nthird');
  assert.equal(readNote(element('div', [element('p', [text('first')]), element('p', [element('br')]), element('p', [text('third')])])).text, 'first\n\nthird');
  assert.equal(readNote(element('div', [text('first'), element('br'), element('br')])).text, 'first\n');
  assert.equal(readNote(element('div', [element('p', [element('br')])])).text, '');
});

test('Chrome nested b and i tags serialize their actual formatting and line boundaries', () => {
  const root = element('div', [element('p', [element('b', [text('Watch wind')])]), element('div', [element('i', [text('water')])])]);
  assert.equal(readNote(root).text, '**Watch wind**\n*water*');
});

test('the shared editor projection preserves addressable leading, trailing and repeated blank lines', () => {
  for (const source of ['', '\n', '\n\nfirst\n\n\nlast\n\n', 'a\nb', '  \n  - one\n\n\nlast\n']) {
    const current = projection(source);
    const document = new NoteDocument(source);
    document.project(current);
    document.change(current, null);
    assert.equal(document.text, source);
    assert.equal(current.positions.some((point) => point.source === source.length), true);
    assert.equal(current.source.every((offset) => Number.isInteger(offset)), true);
  }
});

test('source map identifies repeated unsafe-link labels by exact source offsets', () => {
  const source = 'same [same](javascript:same) same';
  const current = projection(source);
  assert.equal(current.text, 'same same same');
  assert.deepEqual(current.source, [0, 1, 2, 3, 4, 6, 7, 8, 9, 28, 29, 30, 31, 32]);
  const note = new NoteDocument(source);
  note.project(current);
  assert.equal(changed(note, current.text, { start: 10, end: 14, source: { start: 29, end: 33 } }, 'tail'), 'same [same](javascript:same) tail');
});

test('editing before, within and after an unsafe link preserves all unedited syntax', () => {
  const source = 'before [label](javascript:label) after';
  const cases = [
    { start: 0, end: 6, source: { start: 0, end: 6 }, replacement: 'first', expected: 'first [label](javascript:label) after' },
    { start: 7, end: 12, source: { start: 8, end: 13 }, replacement: 'name', expected: 'before [name](javascript:label) after' },
    { start: 13, end: 18, source: { start: 33, end: 38 }, replacement: 'last', expected: 'before [label](javascript:label) last' },
  ];
  for (const { replacement, expected, ...selection } of cases) {
    const note = new NoteDocument(source);
    note.project(projection(source));
    assert.equal(changed(note, note.projection.text, selection, replacement), expected);
  }
});

test('source affinity distinguishes typing inside the unsafe label from after its wrapper', () => {
  const source = '[x](javascript:bad) tail';
  for (const [sourceOffset, expected] of [[2, '[x!](javascript:bad) tail'], [19, '[x](javascript:bad)! tail']]) {
    const note = new NoteDocument(source);
    note.project(projection(source));
    assert.equal(changed(note, note.projection.text, { start: 1, end: 1, source: { start: sourceOffset, end: sourceOffset } }, '!'), expected);
  }
});

test('editing an indented item keeps indentation, blank runs and unsafe links elsewhere', () => {
  const source = '\n\n  - first\n\t- second\n\n\n[x](javascript:bad)\n\n';
  const note = new NoteDocument(source);
  note.project(projection(source));
  const start = note.projection.text.indexOf('second');
  const sourceStart = source.indexOf('second');
  assert.equal(changed(note, note.projection.text, {
    start, end: start + 6, source: { start: sourceStart, end: sourceStart + 6 },
  }, 'next'), '\n\n  - first\n\t- next\n\n\n[x](javascript:bad)\n\n');
});

test('sequential edits, UTF-16 text, backspace and undo preserve the untouched source', () => {
  const source = '[x](javascript:bad) a';
  const note = new NoteDocument(source);
  note.project(projection(source));
  changed(note, note.projection.text, { start: 3, end: 3, source: { start: source.length, end: source.length } }, '😀');
  note.project(projection(note.text));
  const first = note.text;
  const end = note.projection.text.length;
  changed(note, note.projection.text, { start: end - 2, end, source: { start: note.text.length - 2, end: note.text.length } }, '');
  assert.equal(note.text, source);
  note.undo();
  assert.equal(note.text, first);
  note.undo();
  assert.equal(note.text, source);
  note.undo(true);
  assert.equal(note.text, first);
});

test('toolbar formatting only changes its selected source span', () => {
  const source = '\n[x](javascript:bad) tail\n\n\n  - item\n';
  const start = source.indexOf('tail');
  const formatted = formatNote(source, { start, end: start + 4 }, { kind: 'bold' });
  assert.equal(formatted.text, '\n[x](javascript:bad) **tail**\n\n\n  - item\n');
  const note = new NoteDocument(formatted.text);
  const current = projection(formatted.text);
  note.project(current);
  note.change(current, null);
  assert.equal(note.text, formatted.text);
});


test('selecting the editor root replaces hidden unsafe syntax while selecting its text preserves it', () => {
  for (const source of ['[same](javascript:same)', '[same](javascript:same) same']) {
    const root = rendered(source);
    const current = readNote(root, { startContainer: root, startOffset: 0, endContainer: root, endOffset: root.childNodes.length });
    assert.deepEqual(current.selection.source, { start: 0, end: source.length });
    const note = new NoteDocument(source);
    note.project(current);
    assert.equal(changed(note, current.text, current.selection, 'new'), 'new');
    const same = new NoteDocument(source);
    same.project(current);
    assert.equal(changed(same, current.text, current.selection, current.text), current.text);
  }
});

test('paragraph insertion splits only the edited inline token and preserves its unsafe URL or emphasis', () => {
  for (const [source, token, expected] of [
    ['[label](javascript:bad)', { start: 0, end: 23, contentStart: 1, contentEnd: 6 }, '[la](javascript:bad)\n[bel](javascript:bad)'],
    ['[label](https://example.org)', { start: 0, end: 28, contentStart: 1, contentEnd: 6 }, '[la](https://example.org)\n[bel](https://example.org)'],
    ['**label**', { start: 0, end: 9, contentStart: 2, contentEnd: 7 }, '**la**\n**bel**'],
  ]) {
    const note = new NoteDocument(source);
    const offset = token.contentStart + 2;
    note.lineBreak({ start: offset, end: offset }, { start: [token], end: [token] });
    assert.equal(note.text, expected);
  }
});

test('paragraph insertion continues exact list indentation and exits an empty item', () => {
  const continued = new NoteDocument('  - first');
  assert.deepEqual(continued.lineBreak({ start: 9, end: 9 }, undefined, true), { start: 14, end: 14 });
  assert.equal(continued.text, '  - first\n  - ');
  continued.lineBreak({ start: 14, end: 14 }, undefined, true);
  assert.equal(continued.text, '  - first\n\n');
  const soft = new NoteDocument('  - first');
  soft.lineBreak({ start: 9, end: 9 });
  assert.equal(soft.text, '  - first\n');
});

test('typing after an inline token returns the caret after inserted source rather than inside its closing marker', () => {
  const note = new NoteDocument('*literal*');
  note.project(projection(note.text));
  const next = readNote(element('div', [element('em', [text('literal ')])]));
  next.selection = { start: 9, end: 9 };
  assert.deepEqual(note.change(next, { start: 8, end: 8, source: { start: 9, end: 9 } }), { start: 10, end: 10 });
  assert.equal(note.text, '*literal* ');
});

test('paragraph insertion splits nested formatting without duplicating link syntax', () => {
  const source = '**[label](https://example.org)**';
  const note = new NoteDocument(source);
  const tokens = [
    { start: 2, end: source.length - 2, contentStart: 3, contentEnd: 8 },
    { start: 0, end: source.length, contentStart: 2, contentEnd: source.length - 2 },
  ];
  note.lineBreak({ start: 5, end: 5 }, { start: tokens, end: tokens });
  assert.equal(note.text, '**[la](https://example.org)**\n**[bel](https://example.org)**');
});

test('undo and redo restore their own caret snapshots', () => {
  const note = new NoteDocument('a');
  note.replace('ab', { start: 1, end: 1 });
  assert.deepEqual(note.undo(false, { start: 2, end: 2 }), { start: 1, end: 1 });
  assert.equal(note.text, 'a');
  assert.deepEqual(note.undo(true, { start: 1, end: 1 }), { start: 2, end: 2 });
  assert.equal(note.text, 'ab');
});


test('paragraph insertion replaces a selection inside or across formatted tokens without damaging remaining wrappers', () => {
  const token = { start: 0, end: 9, contentStart: 2, contentEnd: 7 };
  const inside = new NoteDocument('**label**');
  inside.lineBreak({ start: 3, end: 5 }, { start: [token], end: [token] });
  assert.equal(inside.text, '**l**\n**el**');
  const across = new NoteDocument('**label** tail');
  across.lineBreak({ start: 4, end: 11 }, { start: [token], end: [] });
  assert.equal(across.text, '**la**\nail');
  const after = new NoteDocument('**label** tail');
  after.lineBreak({ start: 7, end: 11 }, { start: [token], end: [] });
  assert.equal(after.text, '**label**\nail');
  const before = new NoteDocument('head **label**');
  const trailing = { start: 5, end: 14, contentStart: 7, contentEnd: 12 };
  before.lineBreak({ start: 2, end: 7 }, { start: [], end: [trailing] });
  assert.equal(before.text, 'he\n**label**');
});
