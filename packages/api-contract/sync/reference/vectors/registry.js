// registry/refusals.json: documents that break one of §2.4's rules beside a document that keeps them.
// Every implementation loads each whole document as a registry; `admitted` says whether it loads.

import assert from 'node:assert/strict';
import { jcs } from '../core/jcs.js';
import { checkArgument, checkFieldValue, checkId } from '../core/values.js';
import { Registry } from '../core/registry.js';
import { vector } from './fixtures.js';

const ITEM = {
  type: 'item', scope: 'product:p', identity: 'minted', idSpace: 'scope', idPattern: '^i_[0-9]+$',
  mint: { prefix: 'i_', alphabet: '0123456789', length: 12 }, life: true, revivable: false, deadRows: 'spent',
  origins: ['replica'], fields: { title: { kind: 'lww', writer: 'client' } },
};
const BOARD = {
  type: 'board', scope: 'product:p', identity: 'minted', idSpace: 'global', idPattern: '^b_[0-9a-f]{8}$',
  mint: { prefix: 'b_', alphabet: '0123456789abcdef', length: 8 }, life: true, revivable: false, deadRows: 'keep',
  governs: 'tree', origins: ['replica'], fields: {},
};
const META = {
  type: 'meta', scope: 'tree', identity: 'singleton', singletonId: 'meta', idPattern: '^meta$', life: false,
  origins: ['replica'], fields: { title: { kind: 'lww', writer: 'client' } },
};

function documentOf(...types) {
  return {
    registry: 'mini', version: 2, minVersion: 1, products: { p: {}, q: {} }, types,
    commands: [{ name: 'p.sweep', scope: 'product:p', origins: ['server'], serverInternal: true, args: {} }],
  };
}

function loaded(name, registry) {
  let admitted = true;
  try {
    new Registry(registry);
  } catch {
    admitted = false;
  }
  return vector(name, { registry }, { admitted });
}

function headlines() {
  return [
    loaded('a primary type of a product scope is its headline type', documentOf({ ...ITEM, primary: true, headline: true })),
    loaded('two products each have a headline type', documentOf(
      { ...ITEM, primary: true, headline: true },
      { ...ITEM, type: 'other', scope: 'product:q', primary: true, headline: true },
    )),
    loaded('a headline type is primary', documentOf({ ...ITEM, headline: true })),
    loaded('headline is true or absent', documentOf({ ...ITEM, primary: true, headline: false })),
    loaded('a headline type lives in a product scope, never in a tree', documentOf(
      { ...BOARD, primary: true },
      { ...META, primary: true, headline: true },
    )),
    loaded('a product has at most one headline type', documentOf(
      { ...ITEM, primary: true, headline: true },
      { ...ITEM, type: 'other', primary: true, headline: true },
    )),
  ];
}

function unicodeDocument() {
  return documentOf(
    {
      type: 'node', scope: 'tree', identity: 'derived', idSpace: 'scope',
      idDomain: { type: 'string', unit: 'chars', min: 1, max: 128 },
      derive: { fallback: 'node' }, mint: { prefix: '', alphabet: 'ab', length: 16 },
      life: true, revivable: true, deadRows: 'keep', origins: ['replica'],
      fields: { kind: { kind: 'lww', writer: 'client', ref: 'kind' } },
    },
    {
      type: 'kind', scope: 'tree', identity: 'keyed', life: false, origins: ['replica'], fields: {},
      idDomain: { type: 'string', unit: 'chars', min: 1, max: 128 },
    },
    { type: 'mark', scope: 'overlay', identity: 'keyed', key: { ref: 'node' }, life: false, origins: ['replica'], fields: {} },
    {
      type: 'edge', scope: 'tree', identity: 'keyed', life: true, deadRows: 'keep', origins: ['replica'], fields: {},
      key: { tuple: [{ name: 'from', ref: 'node' }, { name: 'to', ref: 'mark' }] },
    },
  );
}

function idDomains() {
  const examples = [
    ['a derived type declares a Unicode id domain', () => {}, true],
    ['a mint draws Unicode scalars within the id domain', (t) => { t.mint = { prefix: '界', alphabet: '😀🚀', length: 127 }; }, true],
    ['a domain mint validates its length without constructing an id', (t) => { t.idDomain.max = 2147483647; t.mint.length = 2147483647; }, true],
    ['a mint alphabet needs two Unicode scalars', (t) => { t.mint.alphabet = '😀'; }, false],
    ['an id domain and a pattern cannot coexist', (t) => { t.idPattern = '^a+$'; }, false],
    ['an id domain and a key cannot coexist', (t) => { t.key = { ref: 'kind' }; }, false],
    ['a scalar id needs a domain or a pattern', (t) => { delete t.idDomain; }, false],
    ['an id domain is a string', (t) => { t.idDomain.type = 'number'; }, false],
    ['an id domain is non-nullable', (t) => { t.idDomain.nullable = true; }, false],
    ['an id domain has only its declared bounds', (t) => { t.idDomain.enum = ['node']; }, false],
    ['an id domain counts code points', (t) => { t.idDomain.unit = 'bytes'; }, false],
    ['an id domain declares a lower bound', (t) => { delete t.idDomain.min; }, false],
    ['an id domain excludes empty ids', (t) => { t.idDomain.min = 0; }, false],
    ['an id domain starts at one', (t) => { t.idDomain.min = 2; }, false],
    ['an id domain declares an upper bound', (t) => { delete t.idDomain.max; }, false],
    ['an id domain upper bound is positive', (t) => { t.idDomain.max = 0; }, false],
    ['an id domain upper bound is integral', (t) => { t.idDomain.max = 1.5; }, false],
    ['an id domain upper bound is safe', (t) => { t.idDomain.max = 2 ** 53; }, false],
    ['a derived id domain declares scope-local identity', (t) => { delete t.idSpace; }, false],
    ['a derived id domain declares its fallback', (t) => { delete t.derive; }, false],
    ['global ids retain their pattern', (t) => { t.idSpace = 'global'; }, false],
    ['minted ids retain their pattern', (t) => { t.identity = 'minted'; delete t.derive; }, false],
    ['a domain type cannot carry singletonId', (t) => { t.singletonId = 'node'; }, false],
    ['a mint must fit the id domain', (t) => { t.mint.length = 129; }, false],
    ['a mint prefix must fit the id domain', (t) => { t.mint.prefix = '界'.repeat(128); }, false],
    ['a mint prefix is a string', (t) => { t.mint.prefix = 123; }, false],
    ['a mint cannot contain NUL', (t) => { t.mint.prefix = '\0'; }, false],
    ['a fallback must fit the id domain', (t) => { t.derive.fallback = 'n'.repeat(129); }, false],
    ['a singleton cannot take an id domain', (t, r) => { r.types[0] = { ...META, idDomain: t.idDomain }; }, false],
    ['a reference key cannot add an id pattern', (t, r) => { r.types[2].idPattern = '^a+$'; }, false],
    ['a tuple key cannot add an id domain', (t, r) => { r.types[3].idDomain = t.idDomain; }, false],
    ['a governing type cannot take an id domain', (t, r) => { const { idPattern, ...board } = BOARD; r.types[0] = { ...board, idDomain: t.idDomain }; }, false],
  ];
  return examples.map(([name, change, admitted]) => {
    const registry = unicodeDocument();
    change(registry.types[0], registry);
    const result = loaded(name, registry);
    assert.deepEqual(result.expect, { admitted }, name);
    return result;
  });
}

function unicodeIds() {
  const document = unicodeDocument();
  const registry = new Registry(document);
  const examples = [
    ['multibyte id', 'node', '学び', true],
    ['non-BMP id at 128 code points', 'node', '😀'.repeat(128), true],
    ['non-BMP id at 129 code points', 'node', '😀'.repeat(129), false],
    ['BMP id at 128 code points', 'kind', '界'.repeat(128), true],
    ['BMP id at 129 code points', 'kind', '界'.repeat(129), false],
    ['empty id', 'node', '', false],
    ['NUL id', 'node', 'a\0b', false],
    ['null id', 'node', null, false],
    ['array id on scalar type', 'node', ['a'], false],
    ['composed id', 'node', 'é', true],
    ['decomposed id', 'node', 'e\u0301', true],
    ['decomposed id counts both code points', 'node', 'e\u0301'.repeat(65), false],
    ['spaces and delimiters remain valid ids', 'node', ' /\n:[]" ', true],
    ['reference key inherits Unicode id domain', 'mark', '学び😀', true],
    ['reference key inherits upper bound', 'mark', '😀'.repeat(129), false],
    ['reference key rejects NUL', 'mark', 'a\0b', false],
    ['tuple and nested reference inherit Unicode id domain', 'edge', ['é', 'e\u0301'], true],
    ['tuple second component inherits upper bound', 'edge', ['学び', '界'.repeat(129)], false],
    ['tuple first component rejects NUL', 'edge', ['\0', 'a'], false],
    ['tuple component cannot be empty', 'edge', ['a', ''], false],
    ['a lone high surrogate is not Unicode', 'node', '\ud800', false],
    ['a lone low surrogate is not Unicode', 'mark', '\udc00', false],
    ['a reversed surrogate pair is not Unicode', 'node', '\udc00\ud800', false],
    ['a tuple component rejects a lone surrogate', 'edge', ['a', '\ud800'], false],
  ];
  return examples.map(([name, type, id, admitted]) => {
    const def = registry.type(type);
    const actual = {
      id: checkId(registry, def, id) === null,
      field: checkFieldValue(registry, { kind: 'lww', writer: 'client', ref: type }, id) === null,
      argument: checkArgument(registry, { type: `ref<${type}>` }, id) === null,
      key: checkId(registry, def, id) === null ? jcs(id) : null,
    };
    const expect = { id: admitted, field: admitted, argument: admitted, key: admitted ? jcs(id) : null };
    assert.deepEqual(actual, expect, name);
    return vector(name, { registry: document, type, idJson: JSON.stringify(id) }, expect);
  });
}

function scopedCommands() {
  return [
    ['engine capture is a scoped command with no arguments', {}, true],
    ['a scoped product command can predict a registered type in another scope', { engine: undefined, predicts: ['meta'] }, true],
    ['engine capture requires the scoped-effects opt-in', { scopedEffects: undefined }, false],
    ['scoped effects is true or absent', { scopedEffects: false }, false],
    ['engine capture accepts no arguments', { args: { id: { type: 'ref<item>' } } }, false],
    ['the engine command tag names only capture', { engine: 'restore' }, false],
    ['scoped commands predict only registered types', { predicts: ['missing'] }, false],
  ].map(([name, change, expected]) => {
    const document = documentOf(ITEM, BOARD, META);
    Object.assign(document.commands[0], { scopedEffects: true, engine: 'capture', predicts: ['item'] }, change);
    for (const key of Object.keys(document.commands[0])) if (document.commands[0][key] === undefined) delete document.commands[0][key];
    const sample = loaded(name, document);
    assert.equal(sample.expect.admitted, expected, name);
    return sample;
  });
}

export function files() {
  return { 'registry/refusals.json': [...headlines(), ...idDomains(), ...scopedCommands()], 'registry/ids.json': unicodeIds() };
}
