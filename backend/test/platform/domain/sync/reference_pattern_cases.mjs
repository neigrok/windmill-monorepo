// §2.4's patterns with the JS reference's verdicts, as JSON for PatternTest.cpp: node reference_pattern_cases.mjs [--seed <n>] [--patterns <n>]

import { randomInt } from 'node:crypto';
import vm from 'node:vm';

import { isPortablePattern } from '../../../../../packages/api-contract/sync/reference/core/registry.js';
import { checkDomain } from '../../../../../packages/api-contract/sync/reference/core/values.js';

const DEFAULT_PATTERNS = 3000;
// Values stay this short, in code points, since V8's backtracking can take time exponential in a value's length.
const MAX_VALUE_LENGTH = 24;
// How long the reference may take over one value: ^(?:|a){65535}b$ takes it ten seconds on "a" and over a minute on "aa".
const MATCH_DEADLINE_MS = 100;
const DEEPEST_GROUP = 3;
const SYNTAX_CHARACTERS = '^$\\.*+?()[]{}|/';
// Printable characters a pattern spells as themselves outside a bracket class.
const LITERALS = 'abcxyzAZ0189 -:,&~_!#%@=<>"\'`/';
// Printable characters a bracket class holds as themselves, and the two that may not open one.
const CLASS_LITERALS = 'abxyz09AZ$.*+?(){}|/,_! ';
const CLASS_INNER_LITERALS = '^:';
const RANGE_ENDS = ['a', 'c', 'x', 'z', '0', '9', 'A', 'Z', '!', '/', '(', '+', '$', '|', '{', '\\]', '\\[', '\\\\', '\\^', '\\.', '\\/'];
const COUNTS = [0, 0, 1, 1, 2, 2, 3, 5, 65535];
// What a mutation writes into a pattern: syntax-heavy characters, and spellings just outside §2.4.
const PATTERN_EDITS = [...'^$\\.*+?()[]{}|/-:,&~ab09', '{65536}', '{2,1}', '{,2}', '[^', '[:', '[\\', '--', '(?=', '(?!', '\\d', '\\-', '{0065535}',
  '[z-a]', '[a&&b]', '[[a]]', '\t', '\u0001', '\u007f', 'é', '\u{1f600}'];
// What a value holds beside its pattern's characters: a newline, NUL, é and an emoji (one surrogate pair).
const VALUE_EXTRAS = ['a', 'b', '-', '\n', '\u0000', 'é', '\u{1f600}'];
// The reference's whole-value match, run in a vm context so the deadline can cut it off mid-match.
const REFERENCE = vm.createContext({ checkDomain, pattern: '', value: '' });
const WHOLE_VALUE_MATCH = new vm.Script("checkDomain({ type: 'string', pattern }, value) === null");

function main(args) {
  const { seed, patterns } = readArguments(args);
  const random = new Random(seed);
  const generated = Array.from({ length: patterns }, () => generatedCase(random));
  const cases = generated.map(({ pattern, portable, values }) => ({ pattern, portable, values }));
  const pairs = cases.flatMap((one) => one.values);
  const portable = cases.filter((one) => one.portable).length;
  const matching = pairs.filter((pair) => pair.matches).length;
  const unanswered = generated.reduce((sum, one) => sum + one.unanswered, 0);
  process.stderr.write(`reference_pattern_cases --seed ${seed}: ${cases.length} patterns (${portable} portable), ${pairs.length} values (${matching} matching, `
    + `${unanswered} left out past the ${MATCH_DEADLINE_MS} ms deadline)\n`);
  process.stdout.write(`${JSON.stringify({ seed, cases })}\n`);
}

function readArguments(args) {
  const options = { seed: randomInt(2 ** 32), patterns: DEFAULT_PATTERNS };
  for (let i = 0; i < args.length; i += 2) {
    const number = /^\d+$/.test(args[i + 1] ?? '') ? Number(args[i + 1]) : NaN;
    if (args[i] === '--seed' && number < 2 ** 32) options.seed = number;
    else if (args[i] === '--patterns' && number > 0) options.patterns = number;
    else {
      process.stderr.write('usage: node reference_pattern_cases.mjs [--seed <0..4294967295>] [--patterns <n>]\n');
      process.exit(2);
    }
  }
  return options;
}

// A pattern the grammar writes, a mutation of it, or random syntax, with the reference's verdicts on it.
function generatedCase(random) {
  const tree = new Grammar(random).sequence(0);
  const written = `^${spell(tree)}$`;
  const roll = random.next();
  const pattern = roll < 0.45 ? written : roll < 0.85 ? mutated(random, written) : randomSyntax(random);
  const portable = isPortablePattern(pattern);
  const candidates = portable ? valuesFor(random, tree, pattern) : [];
  const values = verdictsOn(pattern, candidates);
  return { pattern, portable, values, unanswered: candidates.length - values.length };
}

// The reference's verdict on each value, shortest first, up to the first it cannot give within MATCH_DEADLINE_MS.
function verdictsOn(pattern, values) {
  const verdicts = [];
  for (const value of [...values].sort((a, b) => a.length - b.length)) {
    Object.assign(REFERENCE, { pattern, value });
    try {
      verdicts.push({ value, matches: WHOLE_VALUE_MATCH.runInContext(REFERENCE, { timeout: MATCH_DEADLINE_MS }) });
    } catch (error) {
      if (error.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw error;
      break;
    }
  }
  return verdicts;
}

// mulberry32: the same stream for the same seed on every machine.
class Random {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(low, high) {
    return low + Math.floor(this.next() * (high - low + 1));
  }

  chance(probability) {
    return this.next() < probability;
  }

  pick(choices) {
    return choices[this.int(0, choices.length - 1)];
  }
}

// §2.4's portable subset as a tree: each item an atom (a character set, or a group of branches) taken from min to max times.
class Grammar {
  constructor(random) {
    this.random = random;
  }

  sequence(depth) {
    return Array.from({ length: this.random.int(0, 4) }, () => ({ atom: this.atom(depth), ...this.quantifier() }));
  }

  atom(depth) {
    const roll = this.random.int(0, 9);
    if (roll < 2 && depth < DEEPEST_GROUP) {
      return { opener: this.random.pick(['(', '(?:']), branches: Array.from({ length: this.random.int(1, 3) }, () => this.sequence(depth + 1)) };
    }
    if (roll < 5) return this.bracketClass();
    if (roll < 7) return this.escaped(SYNTAX_CHARACTERS);
    const literal = this.random.pick(LITERALS);
    return { spelled: literal, chars: literal };
  }

  // Literals, escapes and ascending ranges, with a bare `-` only first or last and never beside another `-`.
  bracketClass() {
    const members = this.random.chance(0.15) ? [{ spelled: '-', chars: '-' }] : [];
    for (let count = this.random.int(1, 3); count > 0; count -= 1) members.push(this.classMember(members.length === 0));
    if (this.random.chance(0.15) && !members.at(-1).spelled.endsWith('-')) members.push({ spelled: '-', chars: '-' });
    const chars = new Set(members.flatMap((member) => [...member.chars]));
    return { spelled: `[${members.map((member) => member.spelled).join('')}]`, chars: [...chars].join('') };
  }

  classMember(first) {
    const roll = this.random.int(0, 9);
    if (roll < 3) {
      const codeOf = (end) => end.at(-1).charCodeAt(0);
      const [low, high] = [this.random.pick(RANGE_ENDS), this.random.pick(RANGE_ENDS)].sort((a, b) => codeOf(a) - codeOf(b));
      const codes = Array.from({ length: codeOf(high) - codeOf(low) + 1 }, (_, k) => codeOf(low) + k);
      return { spelled: `${low}-${high}`, chars: String.fromCharCode(...codes) };
    }
    if (roll < 5) return this.escaped(`${SYNTAX_CHARACTERS}-`);
    const literal = this.random.pick(first ? CLASS_LITERALS : CLASS_LITERALS + CLASS_INNER_LITERALS);
    return { spelled: literal, chars: literal };
  }

  escaped(escapable) {
    const char = this.random.pick(escapable);
    return { spelled: `\\${char}`, chars: char };
  }

  quantifier() {
    const [low, high] = [this.random.pick(COUNTS), this.random.pick(COUNTS)].sort((a, b) => a - b);
    const count = (n) => (this.random.chance(0.1) ? `0${n}` : `${n}`);
    switch (this.random.int(0, 11)) {
      case 0: return { quantifier: '?', min: 0, max: 1 };
      case 1: return { quantifier: '*', min: 0, max: Infinity };
      case 2: return { quantifier: '+', min: 1, max: Infinity };
      case 3: return { quantifier: `{${count(low)}}`, min: low, max: low };
      case 4: return { quantifier: `{${count(low)},}`, min: low, max: Infinity };
      case 5: return { quantifier: `{${count(low)},${count(high)}}`, min: low, max: high };
      default: return { quantifier: '', min: 1, max: 1 };
    }
  }
}

function spell(sequence) {
  return sequence.map(({ atom, quantifier }) => (atom.branches ? `${atom.opener}${atom.branches.map(spell).join('|')})` : atom.spelled) + quantifier).join('');
}

// A value the tree holds, cut to MAX_VALUE_LENGTH: no count is read past the cut, so a count of 65 535 costs no more than one of 25.
function sample(random, sequence) {
  let held = '';
  for (const { atom, min, max } of sequence) {
    const times = Math.min(random.int(min, Math.min(max, min + 2)), MAX_VALUE_LENGTH + 1);
    for (let k = 0; k < times && held.length <= MAX_VALUE_LENGTH; k += 1) {
      held += atom.branches ? sample(random, random.pick(atom.branches)) : random.pick(atom.chars);
    }
  }
  return held.slice(0, MAX_VALUE_LENGTH);
}

// The empty value, values the tree holds, one-character edits of those, and random values over the pattern's own characters.
function valuesFor(random, tree, pattern) {
  const alphabet = [...new Set([...pattern.slice(1, -1), ...VALUE_EXTRAS])];
  const held = Array.from({ length: 9 }, () => sample(random, tree));
  const edits = Array.from({ length: 8 }, () => edited(random, random.pick(held), alphabet));
  const noise = Array.from({ length: 6 }, () => Array.from({ length: random.int(1, MAX_VALUE_LENGTH) }, () => random.pick(alphabet)).join(''));
  return [...new Set(['', ...held, ...edits, ...noise])];
}

// `value` with one character inserted, deleted or replaced, by code point so an emoji is never split.
function edited(random, value, alphabet) {
  const characters = [...value];
  const edit = characters.length === 0 ? 'insert' : random.pick(['insert', 'delete', 'replace']);
  if (edit === 'insert') characters.splice(random.int(0, characters.length), 0, random.pick(alphabet));
  if (edit === 'delete') characters.splice(random.int(0, characters.length - 1), 1);
  if (edit === 'replace') characters.splice(random.int(0, characters.length - 1), 1, random.pick(alphabet));
  return characters.slice(0, MAX_VALUE_LENGTH).join('');
}

// `written` with one or two PATTERN_EDITS inserted, or characters deleted or replaced.
function mutated(random, written) {
  const pieces = [...written];
  for (let count = random.int(1, 2); count > 0; count -= 1) {
    const at = random.int(0, Math.max(pieces.length - 1, 0));
    const edit = random.pick(['insert', 'delete', 'replace']);
    if (edit === 'insert') pieces.splice(at, 0, random.pick(PATTERN_EDITS));
    if (edit === 'delete') pieces.splice(at, 1);
    if (edit === 'replace') pieces.splice(at, 1, random.pick(PATTERN_EDITS));
  }
  return pieces.join('');
}

// Syntax-heavy text, mostly between anchors.
function randomSyntax(random) {
  const body = Array.from({ length: random.int(0, 10) }, () => random.pick(PATTERN_EDITS)).join('');
  return random.chance(0.8) ? `^${body}$` : body;
}

main(process.argv.slice(2));
