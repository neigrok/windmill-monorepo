// machine/{intent,replica,scope}.json: the §8 tables. Every legal (from, event, to) and a set of
// illegal ones.

import { INTENT_MACHINE, REPLICA_MACHINE, SCOPE_MACHINE, transition } from '../core/machines.js';
import { vector } from './fixtures.js';

function answer(machine, from, event, to) {
  try {
    return { to: transition(machine, from, event, to) };
  } catch {
    return { error: true };
  }
}

function legal(machine) {
  const out = [];
  for (const rule of machine) {
    for (const from of rule.from) {
      for (const to of rule.to) {
        out.push(vector(`${from ?? 'none'} --${rule.event}--> ${to}`, { from, event: rule.event, to }, answer(machine, from, rule.event, to)));
      }
    }
  }
  return out;
}

function illegal(machine, cases) {
  return cases.map(([from, event, to]) => {
    const input = { from, event };
    if (to !== undefined) input.to = to;
    return vector(`illegal: ${from ?? 'none'} --${event}--> ${to ?? 'any'}`, input, answer(machine, from, event, to));
  });
}

export function files() {
  return {
    'machine/intent.json': [
      ...legal(INTENT_MACHINE),
      ...illegal(INTENT_MACHINE, [
        ['held', 'number'],
        ['held', 'ok'],
        ['ready', 'ok'],
        ['ready', 'undo'],
        ['sent', 'release'],
        ['sent', 'undo'],
        ['sent', 'coalesce'],
        ['acked', 'refuse'],
        ['acked', 'number'],
        [null, 'release'],
        ['refused', 'number'],
        ['resolved', 'discard'],
        ['sent', 'recover', 'acked'],
        [null, 'commit', 'sent'],
      ]),
    ],
    'machine/replica.json': [
      ...legal(REPLICA_MACHINE),
      ...illegal(REPLICA_MACHINE, [
        ['anon', 'sign-out-keep'],
        ['dormant', 'sign-out-keep'],
        ['bound', 'sign-in'],
        ['anon', 'discard'],
        ['bound', 'discard'],
        ['deleted', 'sign-in'],
        ['anon', 'reidentify', 'bound'],
      ]),
    ],
    'machine/scope.json': [
      ...legal(SCOPE_MACHINE),
      ...illegal(SCOPE_MACHINE, [
        ['dead', 'first-write'],
        ['dead', 'governing-create'],
        ['alive', 'governing-create'],
        ['absent', 'governing-delete'],
      ]),
    ],
  };
}
