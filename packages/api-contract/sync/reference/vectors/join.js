// join/{lww,ranked,fww,life,born,record}.json: the §3.2 lattice joins. An absent register is null.

import { joinBorn, joinFww, joinLife, joinLww, joinRanked, joinRecord } from '../core/merge.js';
import { OTHER, registry, st, vector } from './fixtures.js';

const TIER = registry.type('card').field('tier').rank;

const absent = (value) => (value === null ? undefined : value);
const present = (value) => (value === undefined ? null : value);

function pair(join, name, a, b) {
  return vector(name, { a, b }, { join: present(join(absent(a), absent(b))) });
}

const LWW = [
  ['both absent', null, null],
  ['absent loses to a register', null, ['x', st(5)]],
  ['a register beats absent', ['x', st(5)], null],
  ['the greater stamp wins', ['old', st(5)], ['new', st(6)]],
  ['the greater stamp wins whatever the value', ['zzz', st(5)], ['aaa', st(6)]],
  ['the counter breaks a millisecond tie', ['a', st(5, 2)], ['b', st(5, 1)]],
  ['the actor breaks a pair tie', ['a', st(5, 0, OTHER)], ['b', st(5, 0)]],
  ['equal stamps: the bytewise-greater jcs value wins', ['a', st(5)], ['b', st(5)]],
  ['equal stamps: 9 beats 10, as jcs "9" > "10"', [10, st(5)], [9, st(5)]],
  ['equal stamps: null beats false, as jcs "null" > "false"', [false, st(5)], [null, st(5)]],
  ['equal stamps: UTF-8 bytes decide, U+1F600 beats U+FB33', ['דּ', st(5)], ['\u{1f600}', st(5)]],
  ['equal stamps: an object value by its jcs', [{ b: 1, a: 2 }, st(5)], [{ a: 3 }, st(5)]],
  ['equal stamps: 9 beats "1", as jcs byte 0x39 > 0x22', ['1', st(5)], [9, st(5)]],
  ['equal registers', ['same', st(5)], ['same', st(5)]],
];

const FWW = [
  ['both absent', null, null],
  ['absent loses to a register', null, ['x', st(5)]],
  ['the smaller stamp wins', ['first', st(5)], ['second', st(6)]],
  ['the smaller stamp wins whatever the value', ['aaa', st(6)], ['zzz', st(5)]],
  ['the actor breaks a pair tie', ['a', st(5, 0, OTHER)], ['b', st(5, 0)]],
  ['equal stamps: the bytewise-smaller jcs value wins', ['a', st(5)], ['b', st(5)]],
  ['equal stamps: 10 beats 9, as jcs "10" < "9"', [9, st(5)], [10, st(5)]],
  ['equal stamps: UTF-8 bytes decide, U+FB33 beats U+1F600', ['\u{1f600}', st(5)], ['דּ', st(5)]],
  ['equal registers', ['same', st(5)], ['same', st(5)]],
];

const RANKED = [
  ['both absent', null, null],
  ['absent loses to a register', null, ['draft', st(5)]],
  ['a higher rank beats a newer stamp', ['done', st(5)], ['draft', st(9)]],
  ['a higher rank beats a newer stamp from the other side', ['review', st(9)], ['done', st(5)]],
  ['equal ranks: the greater stamp wins', ['done', st(5)], ['dropped', st(6)]],
  ['equal ranks: the greater stamp wins the other way', ['dropped', st(6)], ['done', st(7)]],
  ['equal ranks and stamps: the bytewise-greater jcs wins', ['done', st(5)], ['dropped', st(5)]],
  ['equal values of rank 0: the greater stamp wins', ['draft', st(5)], ['draft', st(4, 9)]],
  ['equal registers', ['review', st(5)], ['review', st(5)]],
];

const LIFE = [
  ['both absent', null, null],
  ['absent loses to a life', null, ['dead', st(5)]],
  ['the greater stamp wins: a later death', ['alive', st(5)], ['dead', st(6)]],
  ['the greater stamp wins: a later revival', ['dead', st(5)], ['alive', st(6)]],
  ['equal stamps: alive wins', ['dead', st(5)], ['alive', st(5)]],
  ['the actor breaks a pair tie', ['alive', st(5, 0)], ['dead', st(5, 0, OTHER)]],
  ['equal lives', ['dead', st(5)], ['dead', st(5)]],
];

const BORN = [
  ['both absent', null, null],
  ['absent contributes nothing', null, st(5)],
  ['the smaller stamp wins', st(6), st(5)],
  ['the actor breaks a pair tie', st(5, 0, OTHER), st(5, 0)],
  ['equal borns', st(5), st(5)],
];

function record(name, type, a, b) {
  return vector(name, { type, a, b }, { join: joinRecord(registry.type(type), a, b) });
}

export function files() {
  return {
    'join/lww.json': LWW.map(([name, a, b]) => pair(joinLww, name, a, b)),
    'join/fww.json': FWW.map(([name, a, b]) => pair(joinFww, name, a, b)),
    'join/ranked.json': RANKED.map(([name, a, b]) => vector(name, { rank: TIER, a, b }, { join: present(joinRanked(absent(a), absent(b), TIER)) })),
    'join/life.json': LIFE.map(([name, a, b]) => pair(joinLife, name, a, b)),
    'join/born.json': BORN.map(([name, a, b]) => pair(joinBorn, name, a, b)),
    'join/record.json': [
      record('two empty records', 'card', {}, {}),
      record('each field by its kind: title lww, claim fww, tier ranked', 'card',
        { life: ['alive', st(5)], born: st(5), f: { title: ['A', st(5)], claim: ['ann', st(5)], tier: ['done', st(5)] } },
        { born: st(5), f: { title: ['B', st(7)], claim: ['bob', st(7)], tier: ['review', st(7)] } }),
      record('fields on one side only are kept', 'card',
        { born: st(5), f: { title: ['A', st(5)] } },
        { born: st(5), f: { body: ['text', st(6)], size: [1.25, st(6)] } }),
      record('a delete joins over a create', 'card',
        { life: ['alive', st(5)], born: st(5), f: { title: ['A', st(5)] } },
        { life: ['dead', st(8)], born: st(5) }),
      record('born takes the smaller stamp', 'card', { born: st(6) }, { born: st(5) }),
      record('const and time fields join as fww', 'lap',
        { born: st(5), f: { runId: ['run00001', st(6)], at: [1000, st(6)] } },
        { born: st(5), f: { runId: ['run00002', st(5)], at: [2000, st(7)] } }),
      record('a field the registry does not know, present on one side, is kept', 'card',
        { born: st(5), f: { title: ['A', st(5)], shine: ['gold', st(4)] } },
        { born: st(5), f: { title: ['B', st(6)] } }),
      record('a keyed record without born', 'link', { life: ['alive', st(5)] }, { life: ['dead', st(5, 1)] }),
      record('a singleton without life', 'meta', { f: { title: ['x', st(5)] } }, { f: { title: ['y', st(5)], visibility: ['public', st(9, 0, 'srv')] } }),
    ],
  };
}
