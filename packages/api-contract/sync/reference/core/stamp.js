// D-1 stamps, §3.1 stamp order, §10.1 encoding. A stamp travels and is stored as its text
// `ms:counter:actor`; this module is the only place that looks inside it.

import { COUNTER_LIMIT, MS_LIMIT } from './constants.js';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const UNSET = '0:0:';

export class StampError extends Error {}

export const Stamp = {
  UNSET,

  encode({ ms, counter, actor }) {
    return `${ms}:${counter}:${actor}`;
  },

  parse(text) {
    if (typeof text !== 'string') throw new StampError(`stamp is not a string: ${JSON.stringify(text)}`);
    if (text === UNSET) return { ms: 0, counter: 0, actor: '' };
    const first = text.indexOf(':');
    const second = first < 0 ? -1 : text.indexOf(':', first + 1);
    if (second < 0) throw new StampError(`stamp lacks two colons: ${text}`);
    const msText = text.slice(0, first);
    const counterText = text.slice(first + 1, second);
    const actor = text.slice(second + 1);
    if (!DECIMAL.test(msText) || !DECIMAL.test(counterText)) throw new StampError(`stamp numbers are not plain decimal: ${text}`);
    const ms = Number(msText);
    const counter = Number(counterText);
    if (!(ms < MS_LIMIT)) throw new StampError(`stamp ms is not below 2^53: ${text}`);
    if (!(counter < COUNTER_LIMIT)) throw new StampError(`stamp counter is not below 2^32: ${text}`);
    if (actor.length < 1 || actor.length > 64 || !PRINTABLE_ASCII.test(actor)) {
      throw new StampError(`stamp actor is not 1-64 printable ASCII bytes: ${text}`);
    }
    return { ms, counter, actor };
  },

  isValid(text) {
    try {
      Stamp.parse(text);
      return true;
    } catch (error) {
      if (error instanceof StampError) return false;
      throw error;
    }
  },

  compare(a, b) {
    const x = Stamp.parse(a);
    const y = Stamp.parse(b);
    if (x.ms !== y.ms) return x.ms < y.ms ? -1 : 1;
    if (x.counter !== y.counter) return x.counter < y.counter ? -1 : 1;
    if (x.actor === y.actor) return 0;
    return x.actor < y.actor ? -1 : 1;
  },

  less(a, b) {
    return Stamp.compare(a, b) < 0;
  },

  max(a, b) {
    return Stamp.compare(a, b) >= 0 ? a : b;
  },

  min(a, b) {
    return Stamp.compare(a, b) <= 0 ? a : b;
  },

  pairOf(text) {
    const { ms, counter } = Stamp.parse(text);
    return { ms, counter };
  },
};

export function comparePairs(a, b) {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return 0;
}
