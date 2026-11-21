import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PI, REDUCIBLE_BELOW, sin, cos, asin, atan, atan2, hypot } from '../../../../src/products/roadmap/layout/arithmetic.js';

test('the arithmetic is written from the operations IEEE 754 defines exactly, and from nothing of the platform’s', () => {
  const source = readFileSync(new URL('../../../../src/products/roadmap/layout/arithmetic.js', import.meta.url), 'utf8')
    .split('\n').filter((line) => !line.startsWith('//')).join('\n');
  assert.deepEqual([...new Set(source.match(/Math\.\w+/g))].sort(), ['Math.abs', 'Math.floor', 'Math.sqrt', 'Math.trunc']);
  assert.deepEqual(source.match(/\*\*|%|<<|>>|[^|]\|[^|]|[^&]&[^&]|\^|~|\bimport\b/g), null);
});

test('zeros, ones, infinities and what is not a number come back as fdlibm returns them', () => {
  const quarter = 0.7853981633974483;
  const half = 1.5707963267948966;
  assert.equal(PI, Math.PI);
  assert.deepEqual(
    [sin(0), sin(-0), sin(Infinity), sin(NaN), sin(1e-9), sin(half), sin(PI), sin(-PI)],
    [0, -0, NaN, NaN, 1e-9, 1, 1.2246467991473532e-16, -1.2246467991473532e-16],
  );
  assert.deepEqual([cos(0), cos(-0), cos(-Infinity), cos(NaN), cos(1e-9), cos(half), cos(PI)], [1, 1, NaN, NaN, 1, 6.123233995736766e-17, -1]);
  assert.deepEqual([asin(0), asin(-0), asin(1), asin(-1), asin(1.0000000000000002), asin(NaN), asin(0.5)], [0, -0, half, -half, NaN, NaN, 0.5235987755982989]);
  assert.deepEqual([atan(0), atan(-0), atan(1), atan(-1), atan(Infinity), atan(-Infinity), atan(NaN)], [0, -0, quarter, -quarter, half, -half, NaN]);
  assert.deepEqual(
    [atan2(0, 0), atan2(-0, 0), atan2(0, -0), atan2(-0, -0), atan2(0, 1), atan2(0, -1), atan2(-0, -1), atan2(1, 0), atan2(-1, -0)],
    [0, -0, PI, -PI, 0, PI, -PI, half, -half],
  );
  assert.deepEqual(
    [atan2(1, 1), atan2(1, -1), atan2(-1, -1), atan2(-1, 1), atan2(3, 2), atan2(NaN, 1), atan2(1, NaN)],
    [quarter, 2.356194490192345, -2.356194490192345, -quarter, 0.982793723247329, NaN, NaN],
  );
  assert.deepEqual(
    [atan2(Infinity, Infinity), atan2(-Infinity, -Infinity), atan2(1, Infinity), atan2(-1, Infinity), atan2(1, -Infinity), atan2(Infinity, 1), atan2(1e300, 1e-300), atan2(1e-300, -1e300)],
    [quarter, -2.356194490192345, 0, -0, PI, half, half, PI],
  );
  assert.deepEqual(
    [hypot(3, 4), hypot(-3, 4), hypot(0, 0), hypot(-0, 0), hypot(5, 0), hypot(1e200, 1e200), hypot(1e-200, 1e-200), hypot(Infinity, NaN), hypot(NaN, 1)],
    [5, 5, 0, 0, 5, 1.414213562373095e200, 1.414213562373095e-200, Infinity, NaN],
  );
});

test('an angle of 1,647,100 or more is outside the arithmetic, and is refused aloud', () => {
  assert.equal(REDUCIBLE_BELOW, 1647100);
  assert.deepEqual([sin(1647099.9999999998), cos(-1647099.9999999998)], [0.6216400377390442, 0.7833030470257343]);
  assert.throws(() => sin(REDUCIBLE_BELOW), { name: 'RangeError', message: 'An angle this large is outside the arithmetic' });
  assert.throws(() => cos(-1e300), { name: 'RangeError', message: 'An angle this large is outside the arithmetic' });
});

// Measured against exact values in 256-bit fixed point over seeded samples of what the layout asks: angles a roadmap of
// 10,000 steps can turn through, ratios in [-1, 1], and world coordinates. Each function's first number is the furthest
// a returned double lay from the true value, in the true value's last places; its second, how many doubles away from
// the correctly rounded one that is at most.
test('sin, cos, asin, atan and atan2 return the correctly rounded double or its neighbour; hypot, the platform’s own sum, at most the next one', () => {
  const BITS = 256n;
  const ONE = 1n << BITS;
  const mul = (a, b) => (a * b) >> BITS;
  const abs = (a) => (a < 0n ? -a : a);
  const root = (value) => {
    if (value === 0n) return 0n;
    let guess = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
    for (;;) {
      const next = (guess + value / guess) >> 1n;
      if (next >= guess) return guess;
      guess = next;
    }
  };
  const fixed = (number) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, number);
    const bits = view.getBigUint64(0);
    const exponent = Number((bits >> 52n) & 0x7ffn);
    const mantissa = (bits & 0xfffffffffffffn) | (exponent === 0 ? 0n : 1n << 52n);
    const shift = BigInt(Math.max(exponent, 1) - 1075) + BITS;
    const magnitude = shift >= 0n ? mantissa << shift : mantissa >> -shift;
    return bits >> 63n ? -magnitude : magnitude;
  };
  const arctanOfSmall = (t) => {
    let power = t;
    let sum = t;
    for (let n = 1n; power !== 0n; n += 1n) {
      power = -mul(mul(power, t), t);
      sum += power / (2n * n + 1n);
    }
    return sum;
  };
  const pi = 16n * arctanOfSmall(ONE / 5n) - 4n * arctanOfSmall(ONE / 239n);
  const exactSinCos = (x) => {
    const turns = (abs(x) + pi / 4n) / (pi / 2n);
    const rest = abs(x) - turns * (pi / 2n);
    let sinTerm = rest;
    let cosTerm = ONE;
    let sinSum = rest;
    let cosSum = ONE;
    for (let n = 1n; sinTerm !== 0n || cosTerm !== 0n; n += 1n) {
      cosTerm = -mul(mul(cosTerm, rest), rest) / ((2n * n - 1n) * (2n * n));
      sinTerm = -mul(mul(sinTerm, rest), rest) / ((2n * n) * (2n * n + 1n));
      cosSum += cosTerm;
      sinSum += sinTerm;
    }
    const quadrant = Number(turns % 4n);
    const sine = [sinSum, cosSum, -sinSum, -cosSum][quadrant];
    return { sin: x < 0n ? -sine : sine, cos: [cosSum, -sinSum, -cosSum, sinSum][quadrant] };
  };
  const exactAtan = (t) => {
    if (t < 0n) return -exactAtan(-t);
    if (t > ONE) return pi / 2n - exactAtan((ONE * ONE) / t);
    let halved = t;
    for (let i = 0; i < 3; i += 1) halved = (halved * ONE) / (ONE + root(ONE * ONE + halved * halved));
    return 8n * arctanOfSmall(halved);
  };
  const exactAsin = (x) => (abs(x) === ONE ? (x < 0n ? -pi / 2n : pi / 2n) : exactAtan((x * ONE) / root(ONE * ONE - x * x)));
  const exactAtan2 = (y, x) => {
    if (x === 0n) return y < 0n ? -pi / 2n : pi / 2n;
    const acute = exactAtan((abs(y) * ONE) / abs(x));
    const angle = x < 0n ? pi - acute : acute;
    return y < 0n ? -angle : angle;
  };
  const errorOf = (returned, exact) => {
    const place = BigInt(abs(exact).toString(2).length - 53);
    const rounded = (((abs(exact) >> (place - 1n)) + 1n) >> 1n) << place;
    return [Number((abs(fixed(returned) - exact) << 20n) >> place) / 1048576, Number(abs(abs(fixed(returned)) - rounded) >> place)];
  };
  const worse = (worst, [lastPlaces, doubles]) => [Math.max(worst[0], lastPlaces), Math.max(worst[1], doubles)];

  let state = 20261121;
  const random = () => {
    state = (state + 0x6D2B79F5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const signed = (magnitude) => (random() < 0.5 ? -magnitude : magnitude);
  const spread = (low, high) => signed(low * (high / low) ** random());
  const angle = (index) => {
    if (index % 4 === 0) return signed(random() * 7);
    if (index % 4 === 1) return signed(random() * 48000);
    if (index % 4 === 2) return Math.floor(1 + random() * 30000) * 1.5707963267948966 * (1 + signed(2 ** -Math.floor(20 + random() * 33)));
    return spread(1e-9, REDUCIBLE_BELOW - 1);
  };

  const worst = { sin: [0, 0], cos: [0, 0], asin: [0, 0], atan: [0, 0], atan2: [0, 0], hypot: [0, 0] };
  for (let index = 0; index < 12000; index += 1) {
    const turn = angle(index);
    const exact = exactSinCos(fixed(turn));
    worst.sin = worse(worst.sin, errorOf(sin(turn), exact.sin));
    worst.cos = worse(worst.cos, errorOf(cos(turn), exact.cos));
    const ratio = index % 3 === 0 ? signed(1 - 10 ** (-17 * random())) : index % 3 === 1 ? signed(random()) : spread(1e-9, 1);
    worst.asin = worse(worst.asin, errorOf(asin(ratio), exactAsin(fixed(ratio))));
    const slope = index % 2 === 0 ? signed(random() * 4) : spread(1e-9, 1e12);
    worst.atan = worse(worst.atan, errorOf(atan(slope), exactAtan(fixed(slope))));
    const x = index % 2 === 0 ? signed(random() * 4000) : spread(1e-6, 1e7);
    const y = index % 2 === 0 ? signed(random() * 4000) : spread(1e-6, 1e7);
    worst.atan2 = worse(worst.atan2, errorOf(atan2(y, x), exactAtan2(fixed(y), fixed(x))));
    worst.hypot = worse(worst.hypot, errorOf(hypot(x, y), root(fixed(x) * fixed(x) + fixed(y) * fixed(y))));
  }
  const measured = Object.fromEntries(Object.entries(worst).map(([name, [lastPlaces, doubles]]) => [name, [Number(lastPlaces.toFixed(3)), doubles]]));
  assert.deepEqual(measured, { sin: [0.71, 1], cos: [0.786, 1], asin: [0.744, 1], atan: [0.725, 1], atan2: [1.238, 1], hypot: [1.91, 2] });
});

test('the picture’s files take from the platform’s Math only what is exact, and import only one another', () => {
  const picture = [
    'layout/arithmetic.js', 'layout/BubbleLayoutEngine.js', 'layout/LayoutEngine.js', 'layout/RadialLayoutEngine.js', 'layout/index.js',
    'model/SkillTree.js', 'model/SpatialGrid.js', 'model/TrunkTree.js', 'model/UnlockRules.js', 'model/footprint.js',
    'scene/captionLayout.js', 'scene/edgeCurve.js', 'scene/framing.js', 'theme.js',
  ];
  const root = new URL('../../../../src/products/roadmap/', import.meta.url);
  const members = new Set();
  const raised = [];
  const imported = new Set();
  for (const file of picture) {
    const source = readFileSync(new URL(file, root), 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    for (const member of source.match(/Math\.\w+/g) ?? []) members.add(member);
    if (source.includes('**')) raised.push(file);
    for (const [, specifier] of source.matchAll(/from '(\.[^']+)'/g)) imported.add(new URL(specifier, new URL(file, root)).href.slice(root.href.length));
  }
  assert.deepEqual([...members].sort(), ['Math.abs', 'Math.ceil', 'Math.floor', 'Math.imul', 'Math.max', 'Math.min', 'Math.sqrt', 'Math.trunc']);
  assert.deepEqual(raised, []);
  assert.deepEqual([...imported].filter((file) => !picture.includes(file)), []);
});
