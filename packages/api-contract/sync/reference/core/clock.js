// §10.2 the hybrid logical clock and §10.4 the server offset. A clock is its persisted pair
// `(ms, counter)`; the actor and `physNow` belong to the engine instance using it.

import { COUNTER_LIMIT, CONSTANTS } from './constants.js';
import { Stamp, comparePairs } from './stamp.js';

export class Clock {
  constructor(pair, actor, physNow) {
    this.ms = pair.ms;
    this.counter = pair.counter;
    this.actor = actor;
    this.physNow = physNow;
  }

  get pair() {
    return { ms: this.ms, counter: this.counter };
  }

  tick() {
    const p = this.physNow();
    if (p > this.ms) {
      this.ms = p;
      this.counter = 0;
    } else {
      this.counter += 1;
      if (this.counter === COUNTER_LIMIT) {
        this.ms += 1;
        this.counter = 0;
      }
    }
    return Stamp.encode({ ms: this.ms, counter: this.counter, actor: this.actor });
  }

  observe(stamp) {
    const seen = Stamp.pairOf(stamp);
    if (comparePairs(seen, this.pair) > 0) {
      this.ms = seen.ms;
      this.counter = seen.counter;
    }
  }
}

export function maxPair(a, b) {
  return comparePairs(a, b) >= 0 ? a : b;
}

// observe() over many stamps, on a bare clock pair.
export function observedPair(pair, stamps) {
  return stamps.reduce((high, stamp) => maxPair(high, Stamp.pairOf(stamp)), pair);
}

export const Offset = {
  sample({ serverTime, tSend, tRecv }) {
    return { offset: serverTime - Math.floor((tSend + tRecv) / 2), rtt: tRecv - tSend };
  },

  record(samples, sample, limits = CONSTANTS) {
    return [...samples, sample].slice(-limits.OFFSET_SAMPLES);
  },

  choose(samples) {
    let best = null;
    for (const sample of samples) {
      if (best === null || sample.rtt <= best.rtt) best = sample;
    }
    return best === null ? 0 : best.offset;
  },
};
