// §4 identity: the op a delta's shape names (§4.1) and the decision table (§4.3). The id state (§4.2)
// comes from the server state (server/state.js).

export function opOf(type, delta) {
  const { life, born } = delta;
  if (type.hasBorn) {
    if (born === undefined) return 'invalid';
    if (life === undefined) return 'update';
    if (life[0] === 'dead') return 'delete';
    return life[1] === born ? 'create' : 'revive';
  }
  if (born !== undefined) return 'invalid';
  if (type.identity === 'keyed' && type.life) return life === undefined ? 'invalid' : 'put';
  return life === undefined ? 'write' : 'invalid';
}

const APPLY = { verdict: 'apply' };
const OK = { verdict: 'ok' };
const refuse = (code) => ({ verdict: 'refuse', code });

// `state`: {state: 'none'|'foreign'|'alive'|'dead', born?}. Answers {verdict: apply|ok|refuse, code?}.
export function decide(type, op, idState, deltaBorn) {
  if (op === 'invalid') return refuse('invalid');
  if (op === 'put' || op === 'write') return APPLY;
  const cell = idState.state === 'alive' || idState.state === 'dead'
    ? `${idState.state}${idState.born === deltaBorn ? '=' : '≠'}`
    : idState.state;
  return TABLE[op][cell](type);
}

const TABLE = {
  create: {
    none: () => APPLY,
    foreign: () => refuse('id-taken'),
    'alive=': () => APPLY,
    'alive≠': () => refuse('id-taken'),
    'dead=': () => OK,
    'dead≠': () => refuse('id-spent'),
  },
  update: {
    none: () => refuse('unknown-record'),
    foreign: () => refuse('unknown-record'),
    'alive=': () => APPLY,
    'alive≠': () => refuse('unknown-record'),
    'dead=': () => refuse('record-dead'),
    'dead≠': () => refuse('unknown-record'),
  },
  delete: {
    none: () => APPLY,
    foreign: () => OK,
    'alive=': () => APPLY,
    'alive≠': () => refuse('unknown-record'),
    'dead=': () => APPLY,
    'dead≠': () => OK,
  },
  revive: {
    none: () => refuse('unknown-record'),
    foreign: () => refuse('unknown-record'),
    'alive=': () => APPLY,
    'alive≠': () => refuse('unknown-record'),
    'dead=': (type) => (type.revivable ? APPLY : refuse('id-spent')),
    'dead≠': () => refuse('unknown-record'),
  },
};
