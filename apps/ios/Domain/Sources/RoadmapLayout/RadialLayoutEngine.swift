// The fallback layout, the web's `layout/RadialLayoutEngine.js`: a radial tidy tree over the trunk. Each step sits on the
// ring for its trunk depth, at the centre of an angular wedge; a wedge is split among trunk children by their leaf counts.

// The least the first ring clears the centre.
private let ring = Theme.nodeSize * 2.8
// Centre to centre.
private let minArc = Theme.nodeSize * 1.7
private let fullCircle = 2 * Arithmetic.pi
// How much of a child's slice comes from an equal share rather than from its leaf count.
private let evenness = 0.15
// Fraction each ring past the first widens its clearance by, for each depth.
private let ringGrowth = 0.05

public struct RadialLayoutEngine: LayoutEngine {
  public let name = LayoutName.radial

  public init() {}

  public func layout(_ tree: SkillTree) throws -> [Point] {
    let trunk = tree.trunk
    // Several roots share an empty centre, which pushes them out to the first ring.
    let depthOffset = trunk.center == nil ? 1 : 0
    var wedges: [(step: Int, depth: Int, angle: Double)] = []

    // An explicit stack, deepest claim last, so a chain thousands of steps long cannot overflow the call stack.
    var claims: [(step: Int, angleStart: Double, angleEnd: Double)] = []
    if let center = trunk.center {
      claims.append((center, 0, fullCircle))
    } else {
      let roots = tree.roots.sorted { SkillTree.Step.cmpOrder(tree.steps[$0], tree.steps[$1]) < 0 }
      let totalLeaves = roots.reduce(0) { $0 + trunk.leafCountOf[$1] }
      var cursor: Double = 0
      for root in roots {
        let span = fullCircle * shareOf(trunk.leafCountOf[root], totalLeaves, roots.count)
        claims.append((root, cursor, cursor + span))
        cursor += span
      }
      claims.reverse()
    }

    while let (step, angleStart, angleEnd) = claims.popLast() {
      wedges.append((step, trunk.trunkDepthOf[step] + depthOffset, (angleStart + angleEnd) / 2))

      let children = trunk.trunkChildrenOf[step]
      if children.isEmpty { continue }
      let totalLeaves = children.reduce(0) { $0 + trunk.leafCountOf[$1] }
      var claimed: [(step: Int, angleStart: Double, angleEnd: Double)] = []
      var cursor = angleStart
      for child in children {
        let span = (angleEnd - angleStart) * shareOf(trunk.leafCountOf[child], totalLeaves, children.count)
        claimed.append((child, cursor, cursor + span))
        cursor += span
      }
      claims.append(contentsOf: claimed.reversed())
    }

    let radii = ringRadii(wedges)
    var seats = [Point](repeating: Point(x: 0, y: 0), count: tree.steps.count)
    for (step, depth, angle) in wedges {
      let radius = radii[depth]
      seats[step] = Point(x: radius * (try Arithmetic.cos(angle)), y: radius * (try Arithmetic.sin(angle)))
    }
    return seats
  }
}

// Shares sum to one, so the wedge is always fully spent.
private func shareOf(_ leaves: Int, _ totalLeaves: Int, _ siblings: Int) -> Double {
  (1 - evenness) * (Double(leaves) / Double(totalLeaves)) + evenness * (1 / Double(siblings))
}

// Radii inside out: a ring clears the one within it by `ring`, and is pushed further when neighbours an angle apart need
// `minArc` of arc between them.
private func ringRadii(_ wedges: [(step: Int, depth: Int, angle: Double)]) -> [Double] {
  var anglesByDepth: [Int: [Double]] = [:]
  var deepest = 0
  for (_, depth, angle) in wedges {
    deepest = max(deepest, depth)
    anglesByDepth[depth, default: []].append(angle)
  }

  var radii: [Double] = [0]
  for depth in stride(from: 1, through: deepest, by: 1) {
    let gap = tightestGap(anglesByDepth[depth] ?? [])
    let needed = gap > 0 ? minArc / gap : 0
    let clearance = ring * (1 + ringGrowth * Double(depth - 1))
    radii.append(Math.max(radii[depth - 1] + clearance, needed))
  }
  return radii
}

// Smallest angle between neighbours around the ring, wrap included; 0 when no radius can part them.
private func tightestGap(_ angles: [Double]) -> Double {
  if angles.count < 2 { return 0 }
  let sorted = angles.sorted()
  var tightest = fullCircle - (sorted[sorted.count - 1] - sorted[0])
  for i in 1..<sorted.count { tightest = Math.min(tightest, sorted[i] - sorted[i - 1]) }
  return tightest
}
