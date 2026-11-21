// The Graph's one arithmetic, from operations IEEE 754 defines exactly (+ - * /, square root, comparison, floor, trunc,
// abs) and unfused, so this text in another language gives the same bits. All but hypot is fdlibm's, whose notice is:
//
// ====================================================
// Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================

export const PI = 3.141592653589793;

const PI_TAIL = 1.2246467991473532e-16;
const HALF_PI = 1.5707963267948966;
const HALF_PI_TAIL = 6.123233995736766e-17;
const QUARTER_PI = 0.7853981633974483;

// Below this an angle needs no reduction, and at or past REDUCIBLE_BELOW none is offered.
const UNREDUCED_BELOW = 0.7853984832763672;
export const REDUCIBLE_BELOW = 1647100;
const SINGLE_QUADRANT_BELOW = 2.3561935424804688;

// π/2 in three pieces of 33 bits, each with the tail that completes it to 53.
const TWO_OVER_PI = 0.6366197723675814;
const HALF_PI_1 = 1.5707963267341256;
const HALF_PI_1_TAIL = 6.077100506506192e-11;
const HALF_PI_2 = 6.077100506303966e-11;
const HALF_PI_2_TAIL = 2.0222662487959506e-21;
const HALF_PI_3 = 2.0222662487111665e-21;
const HALF_PI_3_TAIL = 8.4784276603689e-32;

// The 21 leading bits of each of the first 32 multiples of π/2: an angle sharing them cancels against its multiple.
const HALF_PI_MULTIPLE_LEADING_BITS = [
  1.570796012878418, 3.141592025756836, 4.7123870849609375, 6.283184051513672, 7.853981018066406, 9.424774169921875,
  10.995567321777344, 12.566368103027344, 14.137161254882812, 15.707962036132812, 17.27874755859375, 18.84954833984375,
  20.42034912109375, 21.991134643554688, 23.561935424804688, 25.132736206054688, 26.703536987304688, 28.274322509765625,
  29.845123291015625, 31.415924072265625, 32.9866943359375, 34.5574951171875, 36.1282958984375, 37.6990966796875,
  39.2698974609375, 40.8406982421875, 42.4114990234375, 43.982269287109375, 45.553070068359375, 47.123870849609375,
  48.694671630859375, 50.265472412109375,
];

const TWO_POW_MINUS_27 = 7.450580596923828e-9;
const TWO_POW_MINUS_29 = 1.862645149230957e-9;
const TWO_POW_MINUS_60 = 8.673617379884035e-19;
const TWO_POW_16 = 65536;
const TWO_POW_20 = 1048576;
const TWO_POW_49 = 562949953421312;
const TWO_POW_61 = 2305843009213693952;
const TWO_POW_66 = 73786976294838206464;

const S1 = -0.16666666666666632;
const S2 = 0.00833333333332249;
const S3 = -0.0001984126982985795;
const S4 = 0.0000027557313707070068;
const S5 = -2.5050760253406863e-8;
const S6 = 1.58969099521155e-10;

const C1 = 0.0416666666666666;
const C2 = -0.001388888888887411;
const C3 = 0.00002480158728947673;
const C4 = -2.7557314351390663e-7;
const C5 = 2.087572321298175e-9;
const C6 = -1.1359647557788195e-11;

const P0 = 0.16666666666666666;
const P1 = -0.3255658186224009;
const P2 = 0.20121253213486293;
const P3 = -0.04005553450067941;
const P4 = 0.0007915349942898145;
const P5 = 0.00003479331075960212;
const Q1 = -2.403394911734414;
const Q2 = 2.0209457602335057;
const Q3 = -0.6882839716054533;
const Q4 = 0.07703815055590194;

// atan(0.5), atan(1), atan(1.5) and atan(∞), each with the tail that completes it.
const ATAN_HEAD = [0.4636476090008061, 0.7853981633974483, 0.982793723247329, 1.5707963267948966];
const ATAN_TAIL = [2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17];
const T0 = 0.3333333333333293;
const T1 = -0.19999999999876483;
const T2 = 0.14285714272503466;
const T3 = -0.11111110405462356;
const T4 = 0.09090887133436507;
const T5 = -0.0769187620504483;
const T6 = 0.06661073137387531;
const T7 = -0.058335701337905735;
const T8 = 0.049768779946159324;
const T9 = -0.036531572744216916;
const T10 = 0.016285820115365782;

// The power of two at or below a positive number.
function binadeOf(magnitude) {
  let binade = 1;
  while (binade > magnitude) binade /= 2;
  while (binade * 2 <= magnitude) binade *= 2;
  return binade;
}

// A positive number cut down to its 21 leading bits, given its binade.
function leadingBitsOf(magnitude, binade) {
  return (Math.floor((magnitude / binade) * TWO_POW_20) / TWO_POW_20) * binade;
}

// sin(x + tail) for |x| under π/4; an angle that was never reduced has no tail and takes the shorter sum.
function sinNearZero(x, tail, reduced) {
  if (Math.abs(x) < TWO_POW_MINUS_27) return x;
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (!reduced) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * tail - v * r) - tail) - v * S1);
}

// cos(x + tail) for |x| under π/4.
function cosNearZero(x, tail) {
  const magnitude = Math.abs(x);
  if (magnitude < TWO_POW_MINUS_27) return 1;
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (magnitude < 0.2999999523162842) return 1 - (0.5 * z - (z * r - x * tail));
  const quarter = magnitude >= 0.7812504768371582 ? 0.28125 : leadingBitsOf(magnitude, binadeOf(magnitude)) / 4;
  return (1 - quarter) - ((0.5 * z - quarter) - (z * r - x * tail));
}

// A magnitude of π/4 or more as a quadrant and what is left of it past that many quarter turns, in two parts.
function reduce(magnitude) {
  if (magnitude >= REDUCIBLE_BELOW) throw new RangeError('An angle this large is outside the arithmetic');
  const binade = binadeOf(magnitude);
  if (magnitude < SINGLE_QUADRANT_BELOW) {
    const coarse = magnitude - HALF_PI_1;
    if (leadingBitsOf(magnitude, binade) !== HALF_PI_MULTIPLE_LEADING_BITS[0]) {
      const head = coarse - HALF_PI_1_TAIL;
      return { quadrant: 1, head, tail: (coarse - head) - HALF_PI_1_TAIL };
    }
    const fine = coarse - HALF_PI_2;
    const head = fine - HALF_PI_2_TAIL;
    return { quadrant: 1, head, tail: (fine - head) - HALF_PI_2_TAIL };
  }
  const turns = Math.trunc(magnitude * TWO_OVER_PI + 0.5);
  const quadrant = turns - 4 * Math.floor(turns / 4);
  const first = magnitude - turns * HALF_PI_1;
  const firstTail = turns * HALF_PI_1_TAIL;
  const firstHead = first - firstTail;
  const cancels = turns >= 32 || leadingBitsOf(magnitude, binade) === HALF_PI_MULTIPLE_LEADING_BITS[turns - 1];
  if (!cancels || Math.abs(firstHead) >= binade / TWO_POW_16) return { quadrant, head: firstHead, tail: (first - firstHead) - firstTail };
  const secondStep = turns * HALF_PI_2;
  const second = first - secondStep;
  const secondTail = turns * HALF_PI_2_TAIL - ((first - second) - secondStep);
  const secondHead = second - secondTail;
  if (Math.abs(secondHead) >= binade / TWO_POW_49) return { quadrant, head: secondHead, tail: (second - secondHead) - secondTail };
  const thirdStep = turns * HALF_PI_3;
  const third = second - thirdStep;
  const thirdTail = turns * HALF_PI_3_TAIL - ((second - third) - thirdStep);
  const thirdHead = third - thirdTail;
  return { quadrant, head: thirdHead, tail: (third - thirdHead) - thirdTail };
}

export function sin(x) {
  const magnitude = Math.abs(x);
  if (!(magnitude < Infinity)) return NaN;
  if (magnitude < UNREDUCED_BELOW) return sinNearZero(x, 0, false);
  const { quadrant, head, tail } = reduce(magnitude);
  const sign = x < 0 ? -1 : 1;
  if (quadrant === 0) return sign * sinNearZero(head, tail, true);
  if (quadrant === 1) return sign * cosNearZero(head, tail);
  if (quadrant === 2) return -sign * sinNearZero(head, tail, true);
  return -sign * cosNearZero(head, tail);
}

export function cos(x) {
  const magnitude = Math.abs(x);
  if (!(magnitude < Infinity)) return NaN;
  if (magnitude < UNREDUCED_BELOW) return cosNearZero(x, 0);
  const { quadrant, head, tail } = reduce(magnitude);
  if (quadrant === 0) return cosNearZero(head, tail);
  if (quadrant === 1) return -sinNearZero(head, tail, true);
  if (quadrant === 2) return -cosNearZero(head, tail);
  return sinNearZero(head, tail, true);
}

// The ratio asin's two expansions share.
function asinRatio(t) {
  const p = t * (P0 + t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5)))));
  const q = 1 + t * (Q1 + t * (Q2 + t * (Q3 + t * Q4)));
  return p / q;
}

export function asin(x) {
  const magnitude = Math.abs(x);
  if (!(magnitude <= 1)) return NaN;
  if (magnitude === 1) return x * HALF_PI + x * HALF_PI_TAIL;
  if (magnitude < TWO_POW_MINUS_27) return x;
  if (magnitude < 0.5) return x + x * asinRatio(x * x);
  const sign = x < 0 ? -1 : 1;
  const t = (1 - magnitude) * 0.5;
  const s = Math.sqrt(t);
  if (magnitude >= 0.9749999046325684) return sign * (HALF_PI - (2 * (s + s * asinRatio(t)) - HALF_PI_TAIL));
  const w = leadingBitsOf(s, binadeOf(s));
  const c = (t - w * w) / (s + w);
  const p = 2 * s * asinRatio(t) - (HALF_PI_TAIL - 2 * c);
  const q = QUARTER_PI - 2 * w;
  return sign * (QUARTER_PI - (p - q));
}

// The series atan sums over an argument already brought near zero.
function atanSeries(x) {
  const z = x * x;
  const w = z * z;
  const odd = z * (T0 + w * (T2 + w * (T4 + w * (T6 + w * (T8 + w * T10)))));
  const even = w * (T1 + w * (T3 + w * (T5 + w * (T7 + w * T9))));
  return odd + even;
}

// atan of a positive number from the tabled arctangent it was brought near.
function atanFrom(index, x) {
  return ATAN_HEAD[index] - ((x * atanSeries(x) - ATAN_TAIL[index]) - x);
}

export function atan(x) {
  const magnitude = Math.abs(x);
  if (magnitude !== magnitude) return NaN;
  const sign = x < 0 ? -1 : 1;
  if (magnitude >= TWO_POW_66) return sign * (ATAN_HEAD[3] + ATAN_TAIL[3]);
  if (magnitude < TWO_POW_MINUS_29) return x;
  if (magnitude < 0.4375) return x - x * atanSeries(x);
  if (magnitude < 0.6875) return sign * atanFrom(0, (2 * magnitude - 1) / (2 + magnitude));
  if (magnitude < 1.1875) return sign * atanFrom(1, (magnitude - 1) / (magnitude + 1));
  if (magnitude < 2.4375) return sign * atanFrom(2, (magnitude - 1.5) / (1 + 1.5 * magnitude));
  return sign * atanFrom(3, -1 / magnitude);
}

// The angle of the point (x, y), in (-π, π]. A zero's sign counts, as fdlibm's does.
export function atan2(y, x) {
  if (x !== x || y !== y) return NaN;
  if (x === 1) return atan(y);
  const left = x < 0 || (x === 0 && 1 / x < 0);
  const down = y < 0 || (y === 0 && 1 / y < 0);
  const sign = down ? -1 : 1;
  if (y === 0) return left ? sign * PI : y;
  if (x === 0) return sign * HALF_PI;
  const width = Math.abs(x);
  const height = Math.abs(y);
  if (width === Infinity && height === Infinity) return left ? sign * (3 * QUARTER_PI) : sign * QUARTER_PI;
  if (width === Infinity) return left ? sign * PI : sign * 0;
  if (height === Infinity) return sign * HALF_PI;
  const leading = leadingBitsOf(width, binadeOf(width));
  if (height >= leading * TWO_POW_61) return sign * (HALF_PI + 0.5 * PI_TAIL);
  const acute = left && height < leading * TWO_POW_MINUS_60 ? 0 : atan(Math.abs(y / x));
  if (!left) return sign * acute;
  if (down) return (acute - PI_TAIL) - PI;
  return PI - (acute - PI_TAIL);
}

// The length of (x, y), scaled by the longer side so the squares neither overflow nor vanish.
export function hypot(x, y) {
  const width = Math.abs(x);
  const height = Math.abs(y);
  if (width === Infinity || height === Infinity) return Infinity;
  if (width !== width || height !== height) return NaN;
  const longer = width > height ? width : height;
  if (longer === 0) return 0;
  const across = width / longer;
  const up = height / longer;
  return Math.sqrt(across * across + up * up) * longer;
}
