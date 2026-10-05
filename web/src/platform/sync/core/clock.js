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

// The readings {send, recv} around a request, of device clocks that never jumped: monotonic ms equal to
// wall ms, one boot.
export function steadyTiming(tSend, tRecv) {
  return { send: { wall: tSend, mono: tSend, boot: 'boot-1' }, recv: { wall: tRecv, mono: tRecv, boot: 'boot-1' } };
}

export const Offset = {
  // One response, with the device clocks' readings at send and at receipt, taken into the kept
  // samples and the stored reading. Answers null (no sample) when send and receive straddle a jump;
  // a receive reading that jumped from the stored one discards the earlier samples.
  take({ samples, clockReading }, { serverTime, send, recv }, limits = CONSTANTS) {
    if (Offset.jumped(send, recv, limits)) return null;
    const sample = { offset: serverTime - Math.floor((send.wall + recv.wall) / 2), rtt: recv.mono - send.mono };
    const kept = clockReading !== undefined && Offset.jumped(clockReading, recv, limits) ? [] : samples;
    return { samples: [...kept, sample].slice(-limits.OFFSET_SAMPLES), clockReading: recv };
  },

  // Two {wall, mono, boot} readings of the device's clocks: the wall clock jumped when the device booted
  // in between, or moved more than CLOCK_JUMP_MS apart from the monotonic clock.
  jumped(before, after, limits = CONSTANTS) {
    if (before.boot !== after.boot) return true;
    return Math.abs((after.wall - before.wall) - (after.mono - before.mono)) > limits.CLOCK_JUMP_MS;
  },

  choose(samples) {
    let best = null;
    for (const sample of samples) {
      if (best === null || sample.rtt <= best.rtt) best = sample;
    }
    return best === null ? 0 : best.offset;
  },
};
