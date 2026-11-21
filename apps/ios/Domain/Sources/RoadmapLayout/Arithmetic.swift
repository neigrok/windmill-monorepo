// The Graph's one arithmetic, the web's `layout/arithmetic.js` operation for operation: from what IEEE 754 defines exactly
// (+ - * /, square root, comparison, floor, trunc, abs) and never fused, so both texts give the same bits. Every decimal
// is the web's digit for digit. All but hypot is fdlibm's, whose notice is:
//
// ====================================================
// Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================

public enum Arithmetic {
  public static let pi = 3.141592653589793

  static let piTail = 1.2246467991473532e-16
  static let halfPi = 1.5707963267948966
  static let halfPiTail = 6.123233995736766e-17
  static let quarterPi = 0.7853981633974483

  // Below this an angle needs no reduction, and at or past `reducibleBelow` none is offered.
  static let unreducedBelow = 0.7853984832763672
  public static let reducibleBelow: Double = 1647100
  static let singleQuadrantBelow = 2.3561935424804688

  // π/2 in three pieces of 33 bits, each with the tail that completes it to 53.
  static let twoOverPi = 0.6366197723675814
  static let halfPi1 = 1.5707963267341256
  static let halfPi1Tail = 6.077100506506192e-11
  static let halfPi2 = 6.077100506303966e-11
  static let halfPi2Tail = 2.0222662487959506e-21
  static let halfPi3 = 2.0222662487111665e-21
  static let halfPi3Tail = 8.4784276603689e-32

  // The 21 leading bits of each of the first 32 multiples of π/2: an angle sharing them cancels against its multiple.
  static let halfPiMultipleLeadingBits: [Double] = [
    1.570796012878418, 3.141592025756836, 4.7123870849609375, 6.283184051513672, 7.853981018066406, 9.424774169921875,
    10.995567321777344, 12.566368103027344, 14.137161254882812, 15.707962036132812, 17.27874755859375, 18.84954833984375,
    20.42034912109375, 21.991134643554688, 23.561935424804688, 25.132736206054688, 26.703536987304688, 28.274322509765625,
    29.845123291015625, 31.415924072265625, 32.9866943359375, 34.5574951171875, 36.1282958984375, 37.6990966796875,
    39.2698974609375, 40.8406982421875, 42.4114990234375, 43.982269287109375, 45.553070068359375, 47.123870849609375,
    48.694671630859375, 50.265472412109375,
  ]

  static let twoPowMinus27 = 7.450580596923828e-9
  static let twoPowMinus29 = 1.862645149230957e-9
  static let twoPowMinus60 = 8.673617379884035e-19
  static let twoPow16: Double = 65536
  static let twoPow20: Double = 1048576
  static let twoPow49: Double = 562949953421312
  static let twoPow61: Double = 2305843009213693952
  static let twoPow66: Double = 73786976294838206464

  static let s1 = -0.16666666666666632
  static let s2 = 0.00833333333332249
  static let s3 = -0.0001984126982985795
  static let s4 = 0.0000027557313707070068
  static let s5 = -2.5050760253406863e-8
  static let s6 = 1.58969099521155e-10

  static let c1 = 0.0416666666666666
  static let c2 = -0.001388888888887411
  static let c3 = 0.00002480158728947673
  static let c4 = -2.7557314351390663e-7
  static let c5 = 2.087572321298175e-9
  static let c6 = -1.1359647557788195e-11

  static let p0 = 0.16666666666666666
  static let p1 = -0.3255658186224009
  static let p2 = 0.20121253213486293
  static let p3 = -0.04005553450067941
  static let p4 = 0.0007915349942898145
  static let p5 = 0.00003479331075960212
  static let q1 = -2.403394911734414
  static let q2 = 2.0209457602335057
  static let q3 = -0.6882839716054533
  static let q4 = 0.07703815055590194

  // atan(0.5), atan(1), atan(1.5) and atan(∞), each with the tail that completes it.
  static let atanHead: [Double] = [0.4636476090008061, 0.7853981633974483, 0.982793723247329, 1.5707963267948966]
  static let atanTail: [Double] = [2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17]
  static let t0 = 0.3333333333333293
  static let t1 = -0.19999999999876483
  static let t2 = 0.14285714272503466
  static let t3 = -0.11111110405462356
  static let t4 = 0.09090887133436507
  static let t5 = -0.0769187620504483
  static let t6 = 0.06661073137387531
  static let t7 = -0.058335701337905735
  static let t8 = 0.049768779946159324
  static let t9 = -0.036531572744216916
  static let t10 = 0.016285820115365782

  // sin and cos refuse an angle of `reducibleBelow` or more; the bubble layout then fails and the fallback seats the roadmap.
  public struct AngleOutsideTheArithmetic: Error, Equatable {}

  // The power of two at or below a positive number.
  static func binadeOf(_ magnitude: Double) -> Double {
    var binade: Double = 1
    while binade > magnitude { binade /= 2 }
    while binade * 2 <= magnitude { binade *= 2 }
    return binade
  }

  // A positive number cut down to its 21 leading bits, given its binade.
  static func leadingBitsOf(_ magnitude: Double, _ binade: Double) -> Double {
    (((magnitude / binade) * twoPow20).rounded(.down) / twoPow20) * binade
  }

  // sin(x + tail) for |x| under π/4; an angle that was never reduced has no tail and takes the shorter sum.
  static func sinNearZero(_ x: Double, _ tail: Double, _ reduced: Bool) -> Double {
    if x.magnitude < twoPowMinus27 { return x }
    let z = x * x
    let v = z * x
    let r = s2 + z * (s3 + z * (s4 + z * (s5 + z * s6)))
    if !reduced { return x + v * (s1 + z * r) }
    return x - ((z * (0.5 * tail - v * r) - tail) - v * s1)
  }

  // cos(x + tail) for |x| under π/4.
  static func cosNearZero(_ x: Double, _ tail: Double) -> Double {
    let magnitude = x.magnitude
    if magnitude < twoPowMinus27 { return 1 }
    let z = x * x
    let r = z * (c1 + z * (c2 + z * (c3 + z * (c4 + z * (c5 + z * c6)))))
    if magnitude < 0.2999999523162842 { return 1 - (0.5 * z - (z * r - x * tail)) }
    let quarter = magnitude >= 0.7812504768371582 ? 0.28125 : leadingBitsOf(magnitude, binadeOf(magnitude)) / 4
    return (1 - quarter) - ((0.5 * z - quarter) - (z * r - x * tail))
  }

  // A magnitude of π/4 or more as a quadrant and what is left of it past that many quarter turns, in two parts.
  static func reduce(_ magnitude: Double) throws(AngleOutsideTheArithmetic) -> (quadrant: Double, head: Double, tail: Double) {
    if magnitude >= reducibleBelow { throw AngleOutsideTheArithmetic() }
    let binade = binadeOf(magnitude)
    if magnitude < singleQuadrantBelow {
      let coarse = magnitude - halfPi1
      if leadingBitsOf(magnitude, binade) != halfPiMultipleLeadingBits[0] {
        let head = coarse - halfPi1Tail
        return (1, head, (coarse - head) - halfPi1Tail)
      }
      let fine = coarse - halfPi2
      let head = fine - halfPi2Tail
      return (1, head, (fine - head) - halfPi2Tail)
    }
    let turns = (magnitude * twoOverPi + 0.5).rounded(.towardZero)
    let quadrant = turns - 4 * (turns / 4).rounded(.down)
    let first = magnitude - turns * halfPi1
    let firstTail = turns * halfPi1Tail
    let firstHead = first - firstTail
    let cancels = turns >= 32 || leadingBitsOf(magnitude, binade) == halfPiMultipleLeadingBits[Int(turns) - 1]
    if !cancels || firstHead.magnitude >= binade / twoPow16 { return (quadrant, firstHead, (first - firstHead) - firstTail) }
    let secondStep = turns * halfPi2
    let second = first - secondStep
    let secondTail = turns * halfPi2Tail - ((first - second) - secondStep)
    let secondHead = second - secondTail
    if secondHead.magnitude >= binade / twoPow49 { return (quadrant, secondHead, (second - secondHead) - secondTail) }
    let thirdStep = turns * halfPi3
    let third = second - thirdStep
    let thirdTail = turns * halfPi3Tail - ((second - third) - thirdStep)
    let thirdHead = third - thirdTail
    return (quadrant, thirdHead, (third - thirdHead) - thirdTail)
  }

  public static func sin(_ x: Double) throws(AngleOutsideTheArithmetic) -> Double {
    let magnitude = x.magnitude
    if !(magnitude < .infinity) { return .nan }
    if magnitude < unreducedBelow { return sinNearZero(x, 0, false) }
    let (quadrant, head, tail) = try reduce(magnitude)
    let sign: Double = x < 0 ? -1 : 1
    if quadrant == 0 { return sign * sinNearZero(head, tail, true) }
    if quadrant == 1 { return sign * cosNearZero(head, tail) }
    if quadrant == 2 { return -sign * sinNearZero(head, tail, true) }
    return -sign * cosNearZero(head, tail)
  }

  public static func cos(_ x: Double) throws(AngleOutsideTheArithmetic) -> Double {
    let magnitude = x.magnitude
    if !(magnitude < .infinity) { return .nan }
    if magnitude < unreducedBelow { return cosNearZero(x, 0) }
    let (quadrant, head, tail) = try reduce(magnitude)
    if quadrant == 0 { return cosNearZero(head, tail) }
    if quadrant == 1 { return -sinNearZero(head, tail, true) }
    if quadrant == 2 { return -cosNearZero(head, tail) }
    return sinNearZero(head, tail, true)
  }

  // The ratio asin's two expansions share.
  static func asinRatio(_ t: Double) -> Double {
    let p = t * (p0 + t * (p1 + t * (p2 + t * (p3 + t * (p4 + t * p5)))))
    let q = 1 + t * (q1 + t * (q2 + t * (q3 + t * q4)))
    return p / q
  }

  public static func asin(_ x: Double) -> Double {
    let magnitude = x.magnitude
    if !(magnitude <= 1) { return .nan }
    if magnitude == 1 { return x * halfPi + x * halfPiTail }
    if magnitude < twoPowMinus27 { return x }
    if magnitude < 0.5 { return x + x * asinRatio(x * x) }
    let sign: Double = x < 0 ? -1 : 1
    let t = (1 - magnitude) * 0.5
    let s = t.squareRoot()
    if magnitude >= 0.9749999046325684 { return sign * (halfPi - (2 * (s + s * asinRatio(t)) - halfPiTail)) }
    let w = leadingBitsOf(s, binadeOf(s))
    let c = (t - w * w) / (s + w)
    let p: Double = 2 * s * asinRatio(t) - (halfPiTail - 2 * c)
    let q = quarterPi - 2 * w
    return sign * (quarterPi - (p - q))
  }

  // The series atan sums over an argument already brought near zero.
  static func atanSeries(_ x: Double) -> Double {
    let z = x * x
    let w = z * z
    let odd = z * (t0 + w * (t2 + w * (t4 + w * (t6 + w * (t8 + w * t10)))))
    let even = w * (t1 + w * (t3 + w * (t5 + w * (t7 + w * t9))))
    return odd + even
  }

  // atan of a positive number from the tabled arctangent it was brought near.
  static func atanFrom(_ index: Int, _ x: Double) -> Double {
    atanHead[index] - ((x * atanSeries(x) - atanTail[index]) - x)
  }

  public static func atan(_ x: Double) -> Double {
    let magnitude = x.magnitude
    if magnitude != magnitude { return .nan }
    let sign: Double = x < 0 ? -1 : 1
    if magnitude >= twoPow66 { return sign * (atanHead[3] + atanTail[3]) }
    if magnitude < twoPowMinus29 { return x }
    if magnitude < 0.4375 { return x - x * atanSeries(x) }
    if magnitude < 0.6875 { return sign * atanFrom(0, (2 * magnitude - 1) / (2 + magnitude)) }
    if magnitude < 1.1875 { return sign * atanFrom(1, (magnitude - 1) / (magnitude + 1)) }
    if magnitude < 2.4375 { return sign * atanFrom(2, (magnitude - 1.5) / (1 + 1.5 * magnitude)) }
    return sign * atanFrom(3, -1 / magnitude)
  }

  // The angle of the point (x, y), in (-π, π]. A zero's sign counts, as fdlibm's does.
  public static func atan2(_ y: Double, _ x: Double) -> Double {
    if x != x || y != y { return .nan }
    if x == 1 { return atan(y) }
    let left = x < 0 || (x == 0 && 1 / x < 0)
    let down = y < 0 || (y == 0 && 1 / y < 0)
    let sign: Double = down ? -1 : 1
    if y == 0 { return left ? sign * pi : y }
    if x == 0 { return sign * halfPi }
    let width = x.magnitude
    let height = y.magnitude
    if width == .infinity && height == .infinity { return left ? sign * (3 * quarterPi) : sign * quarterPi }
    if width == .infinity { return left ? sign * pi : sign * 0 }
    if height == .infinity { return sign * halfPi }
    let leading = leadingBitsOf(width, binadeOf(width))
    if height >= leading * twoPow61 { return sign * (halfPi + 0.5 * piTail) }
    let acute = left && height < leading * twoPowMinus60 ? 0 : atan((y / x).magnitude)
    if !left { return sign * acute }
    if down { return (acute - piTail) - pi }
    return pi - (acute - piTail)
  }

  // The length of (x, y), scaled by the longer side so the squares neither overflow nor vanish.
  public static func hypot(_ x: Double, _ y: Double) -> Double {
    let width = x.magnitude
    let height = y.magnitude
    if width == .infinity || height == .infinity { return .infinity }
    if width != width || height != height { return .nan }
    let longer = width > height ? width : height
    if longer == 0 { return 0 }
    let across = width / longer
    let up = height / longer
    return (across * across + up * up).squareRoot() * longer
  }
}
