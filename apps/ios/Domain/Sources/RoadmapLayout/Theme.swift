// The constants every file of the picture shares, the web's `theme.js`, and the box a step reserves for its disc and
// caption, the web's `model/footprint.js`. A constant the web writes as an expression is computed here, never retyped:
// `56 * 0.84` is `47.04`, and `52 / 47.04` is `1.1054421768707483`.
public enum Theme {
  // World units; the diameter a step is drawn in.
  public static let nodeSize: Double = 56

  // The body disc fills this share of `nodeSize`; a crowned root's body is `rootBodyScale` times wider.
  public static let bodyFraction = 0.84
  public static let rootBodyScale = 1.55
  public static let bodyWU = nodeSize * bodyFraction

  // The zoom at which an ordinary body is 52 px across, and the phone's, where it is 40.
  public static let workingZoom = 52 / bodyWU
  public static let phoneWorkingZoom = 40 / bodyWU

  // A body never draws narrower than this many screen px at any zoom; the crowned root keeps a taller floor.
  public static let minBodyPx: Double = 6
  public static let minRootBodyPx: Double = 9

  // The selected disc is drawn this much larger, and its caption's seat clears the grown rim.
  public static let selectedScale = 1.14

  // A caption is fixed-size text under the disc, never scaled by zoom: at most two 20 px lines inside 168 px, 8 px below
  // the rim. `charPx` is the width the layout reserves for one code point.
  public enum Caption {
    public static let linePx: Double = 20
    public static let maxWidthPx: Double = 168
    public static let padPx: Double = 4
    public static let gapPx: Double = 8
    public static let maxLines: Double = 2
    public static let charPx = 6.65
  }
}

// The box a step reserves, from its label's length alone and never from a measured font, so every device lays a roadmap
// out the same: px of the working view, divided by the working zoom into world units.
struct Footprint {
  let bodyWU: Double
  let widthWU: Double
  let heightWU: Double

  // A label's length is its code points, spaces included.
  init(label: String, root: Bool) {
    let bodyPx = Theme.bodyWU * (root ? Theme.rootBodyScale : 1) * Theme.workingZoom
    let textPx = Theme.Caption.charPx * Double(label.unicodeScalars.count)
    let captionPx = Math.min(Theme.Caption.maxWidthPx, Theme.Caption.padPx * 2 + textPx)
    let lines = textPx <= Theme.Caption.maxWidthPx - Theme.Caption.padPx * 2 ? 1 : Theme.Caption.maxLines
    let widthPx = Math.max(bodyPx, captionPx)
    let heightPx = bodyPx + Theme.Caption.gapPx + lines * Theme.Caption.linePx
    bodyWU = bodyPx / Theme.workingZoom
    widthWU = widthPx / Theme.workingZoom
    heightWU = heightPx / Theme.workingZoom
  }

  // The reserved rectangle of a step seated at (x, y): the disc centred there, the caption hanging below it.
  func rect(x: Double, y: Double) -> Rect {
    Rect(minX: x - widthWU / 2, maxX: x + widthWU / 2, minY: y - bodyWU / 2, maxY: y - bodyWU / 2 + heightWU)
  }
}
