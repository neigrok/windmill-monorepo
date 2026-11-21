// The bow of a link, the web's `scene/edgeCurve.js`: the one curve both the ribbon and the captions read. Screen px or
// world units; the curve is the same shape under a uniform scale.
public enum EdgeCurve {
  static let bendFactor = 0.18
  // The most of its own length a bow can carry a ribbon off the straight run between its ends.
  static let bendReach = bendFactor / 2

  // A link's own bow, in [-0.5, 0.5), from the two ids and never from their seats. The hash runs over the UTF-16 code
  // units of `from`, `-`, `to` in JavaScript's numbers: `h << 5` wraps `h` to a signed 32-bit integer and shifts it,
  // dropping what overflows, while the subtraction and the sum are not wrapped, so `h` leaves the 32-bit range.
  public static func bendOf(_ from: UTF16Text, _ to: UTF16Text) -> Double {
    var h: Double = 0
    for unit in from.units + [0x2D] + to.units {
      let wrapped = Int32(truncatingIfNeeded: Int64(h.truncatingRemainder(dividingBy: 4294967296)))
      h = Double(unit) + (Double(wrapped << 5) - h)
    }
    return h.magnitude.truncatingRemainder(dividingBy: 100) / 100 - 0.5
  }

  public static func controlPoint(_ fx: Double, _ fy: Double, _ tx: Double, _ ty: Double, _ sway: Double) -> Point {
    let dx = tx - fx
    let dy = ty - fy
    // `hypot(dx, dy) || 1`: a length of zero, or one that is not a number, is taken as 1.
    let length = Arithmetic.hypot(dx, dy)
    let len = length > 0 ? length : 1
    let bend = sway * len * bendFactor
    return Point(x: (fx + tx) / 2 - (dy / len) * bend, y: (fy + ty) / 2 + (dx / len) * bend)
  }

  public static func pointOnCurve(_ fx: Double, _ fy: Double, _ cx: Double, _ cy: Double, _ tx: Double, _ ty: Double, _ t: Double) -> Point {
    let omt = 1 - t
    let x: Double = omt * omt * fx + 2 * omt * t * cx + t * t * tx
    let y: Double = omt * omt * fy + 2 * omt * t * cy + t * t * ty
    return Point(x: x, y: y)
  }
}
