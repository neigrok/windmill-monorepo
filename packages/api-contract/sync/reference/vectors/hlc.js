// hlc/tick.json, hlc/observe.json and hlc/offset.json: §10.2 tick and observe, §10.4 the offset.

import { Clock, Offset, steadyTiming } from '../core/clock.js';
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

// A response in arrival order: {serverTime, send, recv}, the device clocks' readings around it.
function offset(name, responses) {
  let kept = { samples: [], clockReading: undefined };
  for (const response of responses) kept = Offset.take(kept, response, CONSTANTS) ?? kept;
  return vector(name, { responses }, { samples: kept.samples, serverOffsetMs: Offset.choose(kept.samples), clockReading: kept.clockReading ?? null });
}

function steady(serverTime, tSend, tRecv) {
  return { serverTime, ...steadyTiming(tSend, tRecv) };
}

function reading(wall, mono, boot = 'boot-1') {
  return { wall, mono, boot };
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
      offset('one sample: server time minus the midpoint', [steady(10_000, 1000, 1200)]),
      offset('an odd round trip floors the midpoint', [steady(10_000, 1000, 1001)]),
      offset('the lowest round trip wins', [steady(10_000, 1000, 1400), steady(20_050, 11_000, 11_100), steady(30_000, 21_000, 21_300)]),
      offset('equal round trips choose the latest sample', [steady(10_000, 1000, 1100), steady(20_500, 11_000, 11_100)]),
      offset('a negative offset for a fast device clock', [steady(1000, 400_000, 400_020)]),
      offset('the round trip is monotonic ms, and the midpoint wall ms', [
        { serverTime: 10_000, send: reading(1000, 500), recv: reading(1100, 900) },
        { serverTime: 20_000, send: reading(11_000, 11_000), recv: reading(11_300, 11_200) },
      ]),
      offset('a wall-clock jump against the monotonic clock discards the earlier samples', [
        { serverTime: 10_000, send: reading(1000, 490), recv: reading(1010, 500) },
        { serverTime: 20_000, send: reading(11_000, 10_490), recv: reading(11_050, 10_540) },
        { serverTime: 30_000, send: reading(80_000, 11_500), recv: reading(80_100, 11_600) },
      ]),
      offset('a reboot discards the earlier samples, which then accumulate again', [
        { serverTime: 10_000, send: reading(1000, 490), recv: reading(1010, 500) },
        { serverTime: 30_000, send: reading(80_000, 0, 'boot-2'), recv: reading(80_100, 100, 'boot-2') },
        { serverTime: 31_000, send: reading(81_000, 1000, 'boot-2'), recv: reading(81_040, 1040, 'boot-2') },
      ]),
      offset('a request that straddles a jump yields no sample, and the next sample discards the earlier ones', [
        { serverTime: 10_000, send: reading(1000, 490), recv: reading(1010, 500) },
        { serverTime: 20_000, send: reading(11_000, 10_490), recv: reading(90_050, 10_540) },
        { serverTime: 30_000, send: reading(90_100, 10_600), recv: reading(90_140, 10_640) },
      ]),
      offset('a reboot during the request yields no sample, and the offset is kept', [
        { serverTime: 10_000, send: reading(1000, 490), recv: reading(1010, 500) },
        { serverTime: 20_000, send: reading(5000, 4490), recv: reading(5050, 30, 'boot-2') },
      ]),
      offset('only the last OFFSET_SAMPLES samples count', [
        steady(5000, 1000, 1002),
        ...Array.from({ length: CONSTANTS.OFFSET_SAMPLES }, (_, i) => steady(90_000 + i * 1000, 10_000 + i * 1000, 10_050 + i * 1000)),
      ]),
    ],
    'hlc/jump.json': [
      vector('clocks that move together did not jump', { before: { wall: 1000, mono: 50, boot: 'b1' }, after: { wall: 6000, mono: 5050, boot: 'b1' } }, { jumped: false }),
      vector('a drift of exactly CLOCK_JUMP_MS is not a jump', { before: { wall: 1000, mono: 50, boot: 'b1' }, after: { wall: 7000, mono: 5050, boot: 'b1' } }, { jumped: false }),
      vector('the wall clock set forward past CLOCK_JUMP_MS jumped', { before: { wall: 1000, mono: 50, boot: 'b1' }, after: { wall: 7001, mono: 5050, boot: 'b1' } }, { jumped: true }),
      vector('the wall clock set back jumped', { before: { wall: 100_000, mono: 50, boot: 'b1' }, after: { wall: 40_000, mono: 5050, boot: 'b1' } }, { jumped: true }),
      vector('a reboot in between is a jump, whatever the readings', { before: { wall: 1000, mono: 50, boot: 'b1' }, after: { wall: 6000, mono: 5050, boot: 'b2' } }, { jumped: true }),
    ],
  };
}
