import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMessage, parseMessage } from '../../../src/platform/i18n/message.js';

function render(source, args = {}) {
  return formatMessage(parseMessage(source), args, new Intl.PluralRules('en')).join('');
}

test('an argument renders as String(value), so a number or date reads exactly as the caller formatted it', () => {
  assert.deepEqual([
    render('Hello, {name}!', { name: 'Ada' }),
    render('{ first } and {second}', { first: 'a', second: 'b' }),
    render('{count} sets', { count: 1000 }),
    render('{load} kg', { load: 82.5 }),
    render('{when}', { when: '14 March' }),
    render('[{empty}]', { empty: '' }),
    render('Set #{n}', { n: 2 }),
  ], ['Hello, Ada!', 'a and b', '1000 sets', '82.5 kg', '14 March', '[]', 'Set #2']);
});

test('plural picks =N first, then the English category, and # is the count as String(count)', () => {
  const steps = '{count, plural, =0 {No steps yet} one {# step} other {# steps}}';
  assert.deepEqual([0, 1, 2, 1.5, 0.5, -1, 1000].map((count) => render(steps, { count })),
    ['No steps yet', '1 step', '2 steps', '1.5 steps', '0.5 steps', '-1 step', '1000 steps']);
  const sets = '{count, plural, one {# set} other {# sets}}';
  assert.deepEqual([0, 1, 2].map((count) => render(sets, { count })), ['0 sets', '1 set', '2 sets']);
  assert.deepEqual([1, 2].map((n) => render('{n, plural, =1.0 {exactly one} =2 {exactly two} one {# one} other {#}}', { n })), ['exactly one', 'exactly two']);
});

test('a plural branch can show other arguments, a nested plural and a select', () => {
  assert.equal(render('{count, plural, one {{shown} set} other {{shown} sets}}', { count: 1200, shown: '1,200' }), '1,200 sets');
  assert.equal(render('{a, plural, one {# row of {b, plural, one {# col} other {# cols}}} other {# rows}}', { a: 1, b: 3 }), '1 row of 3 cols');
  const day = '{kind, select, workout {Workout} rest {Rest day} other {Day}}';
  assert.deepEqual(['workout', 'rest', 'anything'].map((kind) => render(day, { kind })), ['Workout', 'Rest day', 'Day']);
});

test('apostrophes quote as ICU does: doubled is one, before a brace or a plural # it quotes, otherwise it is itself', () => {
  assert.deepEqual([
    render("Don't stop"),
    render('Don’t stop'),
    render("It''s here"),
    render("'{name}' stays literal"),
    render("'{'braces'}'"),
    render("'{it''s}'"),
    render("{n, plural, other {'#' is #}}", { n: 3 }),
    render('# outside a plural'),
  ], ["Don't stop", 'Don’t stop', "It's here", '{name} stays literal', '{braces}', "{it's}", '# is 3', '# outside a plural']);
});

test('a malformed message is a SyntaxError naming what it expected', () => {
  const failures = ['Oops }', '{name', '{first name}', '{}', '{n, number}', '{n, plural, one {x}}', '{n, plural, few {x} other {y} few {z}}', '{n, plural, lots {x} other {y}}', '{n, plural, other {x}']
    .map((source) => { try { parseMessage(source); return null; } catch (error) { return `${error.name}: ${error.message}`; } });
  assert.deepEqual(failures, [
    'SyntaxError: message "Oops }" expects an unmatched } at 5',
    'SyntaxError: message "{name" expects , or } after {name at 5',
    'SyntaxError: message "{first name}" expects , or } after {first at 7',
    'SyntaxError: message "{}" expects an argument name, got "" at 1',
    'SyntaxError: message "{n, number}" expects plural or select as the type of {n}, got "number" at 10',
    'SyntaxError: message "{n, plural, one {x}}" expects an other option in the plural at 20',
    'SyntaxError: message "{n, plural, few {x} other {y} few {z}}" expects one few option, got two at 33',
    'SyntaxError: message "{n, plural, lots {x} other {y}}" expects a plural option, got "lots" at 16',
    'SyntaxError: message "{n, plural, other {x}" expects a plural option, got "" at 21',
  ]);
});

test('a missing argument, or a plural count that is not a number, cannot be formatted', () => {
  const failures = [
    ['Hello, {name}!', {}],
    ['{count, plural, other {# sets}}', { count: '3' }],
    ['{count, plural, other {# sets}}', { count: Number.NaN }],
    ['{kind, select, other {x}}', { kind: null }],
  ].map(([source, args]) => { try { render(source, args); return null; } catch (error) { return error.message; } });
  assert.deepEqual(failures, [
    'message needs the argument "name"',
    'plural argument "count" must be a number',
    'plural argument "count" must be a number',
    'message needs the argument "kind"',
  ]);
});
