// hlc/tick.json, hlc/observe.json and hlc/offset.json: §10.2 tick and observe, §10.4 the offset.

import { Clock, Offset } from '../core/clock.js';
import { CONSTANTS } from '../core/constants.js';
import { ACTOR, vector } from './fixtures.js';

const LAST_COUNTER = 2 ** 32 - 1;

function runClock(clock, ops) {
  let now = 0;
  const running = new Clock(clock, ACTOR, () => now);
  const stamps = [];
  for (const op of ops) {
    if (op.observe !== undefined) running.observe(op.observe);
    else {
      now = op.tick;
      stamps.push(running.tick());
    }
  }
  return { stamps, clock: running.pair };
}

function tick(name, clock, physNow) {
  const out = runClock(clock, physNow.map((p) => ({ tick: p })));
  return vector(name, { actor: ACTOR, clock, physNow }, out);
}

function observe(name, clock, ops) {
  return vector(name, { actor: ACTOR, clock, ops }, runClock(clock, ops));
}

function offset(name, responses) {
  let samples = [];
  for (const response of responses) samples = Offset.record(samples, Offset.sample(response), CONSTANTS);
  return vector(name, { samples: responses }, { samples, serverOffsetMs: Offset.choose(samples) });
}

export function files() {
  return {
    'hlc/tick.json': [
      tick('a fresh clock takes physNow with counter 0', { ms: 0, counter: 0 }, [1000]),
      tick('physNow ahead of the clock resets the counter', { ms: 1000, counter: 7 }, [1001]),
      tick('physNow equal to the clock bumps the counter', { ms: 1000, counter: 7 }, [1000]),
      tick('physNow behind the clock bumps the counter', { ms: 5000, counter: 2 }, [1000]),
      tick('a burst in one millisecond counts up', { ms: 0, counter: 0 }, [1000, 1000, 1000, 1001, 999]),
      tick('the counter overflows into the next millisecond', { ms: 1000, counter: LAST_COUNTER }, [1000]),
      tick('the counter overflows while physNow lags', { ms: 1000, counter: LAST_COUNTER - 1 }, [900, 900, 900]),
      tick('physNow jumping back and forward', { ms: 2000, counter: 0 }, [1500, 2500, 2400, 2500]),
    ],
    'hlc/observe.json': [
      observe('observing a greater stamp adopts its pair', { ms: 1000, counter: 0 }, [{ observe: '2000:5:srv' }]),
      observe('observing a smaller stamp changes nothing', { ms: 3000, counter: 1 }, [{ observe: '2000:5:srv' }]),
      observe('observing an equal pair of another actor changes nothing', { ms: 2000, counter: 5 }, [{ observe: '2000:5:zzz' }]),
      observe('observing a larger counter on the same ms adopts it', { ms: 2000, counter: 5 }, [{ observe: '2000:9:a' }]),
      observe('observing the unset stamp changes nothing', { ms: 0, counter: 0 }, [{ observe: '0:0:' }]),
      observe('a tick after observing a future stamp counts past it', { ms: 1000, counter: 0 }, [{ observe: '9000:3:srv' }, { tick: 1200 }]),
      observe('a tick after observing a past stamp takes physNow', { ms: 1000, counter: 0 }, [{ observe: '900:3:srv' }, { tick: 1200 }]),
      observe('ticks and observes interleave', { ms: 0, counter: 0 }, [
        { tick: 100 },
        { observe: '100:4:srv' },
        { tick: 100 },
        { observe: '150:0:r_bbbbbbbbbbbb' },
        { tick: 120 },
        { tick: 200 },
      ]),
    ],
    'hlc/offset.json': [
      offset('one sample: server time minus the midpoint', [{ serverTime: 10_000, tSend: 1000, tRecv: 1200 }]),
      offset('an odd round trip floors the midpoint', [{ serverTime: 10_000, tSend: 1000, tRecv: 1001 }]),
      offset('the lowest round trip wins', [
        { serverTime: 10_000, tSend: 1000, tRecv: 1400 },
        { serverTime: 20_050, tSend: 11_000, tRecv: 11_100 },
        { serverTime: 30_000, tSend: 21_000, tRecv: 21_300 },
      ]),
      offset('equal round trips choose the latest sample', [
        { serverTime: 10_000, tSend: 1000, tRecv: 1100 },
        { serverTime: 20_500, tSend: 11_000, tRecv: 11_100 },
      ]),
      offset('a negative offset for a fast device clock', [{ serverTime: 1000, tSend: 400_000, tRecv: 400_020 }]),
      offset('only the last OFFSET_SAMPLES samples count', [
        { serverTime: 5000, tSend: 1000, tRecv: 1002 },
        ...Array.from({ length: CONSTANTS.OFFSET_SAMPLES }, (_, i) => ({ serverTime: 90_000 + i * 1000, tSend: 10_000 + i * 1000, tRecv: 10_050 + i * 1000 })),
      ]),
    ],
  };
}
