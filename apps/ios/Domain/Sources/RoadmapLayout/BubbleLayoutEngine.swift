// The bubble layout, the web's `layout/BubbleLayoutEngine.js` function for function: a bubble tree over the trunk, each
// step's children on rays inside its enclosing circle with the in-edge side free, then a post-order tuck sliding subtrees
// on their rays until footprints or trunk edges touch or discs meet their air. Every sum, product and comparison is in
// the web's order, and a number the web holds as a number is a Double here, cell indices and the budget of work included.

private let twoPi = 2 * Arithmetic.pi
// The arc kept free on a step's parent side, so its in-edge reaches it between no children.
private let inEdgeGap = Arithmetic.pi / 3
// A root has no in-edge; its children spread around it, but never further apart than this.
private let rootSpreadCap = Arithmetic.pi / 9
// Subtree circles are rounded up to this step, so a small change in one caption rarely reaches its ancestors.
private let radiusStep: Double = 24
// Island circles are rounded up more coarsely still, so an edit inside one rarely reseats the others.
private let islandStep = radiusStep * 4
// The least two footprints, or a footprint and a trunk edge, keep between them after the tuck.
private let tuckMargin = 8 / Theme.workingZoom
// The least air two discs keep between their rims after the tuck, whatever their captions reserve, as circles.
private let discAir = Theme.bodyWU * 0.75
private let gridCell: Double = 256
private let maxRectCells: Double = 64
// A deterministic cap keeps deep trees responsive; untouched enclosing seats remain collision-free.
private let tuckWorkPerNode = 2048
private let epsilon = 1e-9
// A rect corner that crossed a moving edge within this fraction of the move before it began only grazed it.
private let graze = 1e-3

public struct BubbleLayoutEngine: LayoutEngine {
  public let name = LayoutName.bubble

  public init() {}

  public func layout(_ tree: SkillTree) throws -> [Point] {
    let forest = Forest(tree)
    let bubbles = try enclosingBubbles(forest)
    var positions = try growIslands(forest, bubbles)
    // One budget, shared by every island.
    var work = Math.max(1_000_000, Double(forest.size * tuckWorkPerNode))
    var islands: [Island] = []
    for root in forest.roots { islands.append(tuckIsland(forest, &positions, root, &work)) }
    settleIslands(forest, &positions, islands)
    var seats = [Point](repeating: Point(x: 0, y: 0), count: forest.size)
    for node in 0..<forest.size { seats[forest.steps[node]] = Point(x: positions.x[node], y: positions.y[node]) }
    return seats
  }
}

private struct Disc {
  var x: Double
  var y: Double
  var r: Double
}

private struct Edge {
  var px: Double
  var py: Double
  var qx: Double
  var qy: Double
}

private struct Positions {
  var x: [Double]
  var y: [Double]
}

// The trunk as flat arrays over topological positions, so a parent always precedes its children. A node is a step's
// position in the topological order.
private struct Forest {
  let steps: [Int]
  let size: Int
  let parentOf: [Int]
  let childrenOf: [[Int]]
  let rectOf: [Rect]
  let ownRadiusOf: [Double]
  let subtreeSize: [Int]
  let roots: [Int]

  init(_ tree: SkillTree) {
    let trunk = tree.trunk
    let steps = tree.topoOrder
    let size = steps.count
    var nodeOf = [Int](repeating: 0, count: size)
    for (node, step) in steps.enumerated() { nodeOf[step] = node }
    let parentOf: [Int] = steps.map { step in
      guard let parent = trunk.primaryParentOf[step] else { return -1 }
      return nodeOf[parent]
    }
    let rectOf = steps.indices.map { node in
      Footprint(label: tree.steps[steps[node]].label, root: parentOf[node] == -1).rect(x: 0, y: 0)
    }
    var subtreeSize = [Int](repeating: 1, count: size)
    for node in stride(from: size - 1, to: 0, by: -1) where parentOf[node] != -1 {
      subtreeSize[parentOf[node]] += subtreeSize[node]
    }
    // Roots by subtree size, larger first, then in sibling order.
    var roots = steps.indices.filter { parentOf[$0] == -1 }
    roots.sort { a, b in
      if subtreeSize[a] != subtreeSize[b] { return subtreeSize[a] > subtreeSize[b] }
      return SkillTree.Step.cmpOrder(tree.steps[steps[a]], tree.steps[steps[b]]) < 0
    }

    self.steps = steps
    self.size = size
    self.parentOf = parentOf
    self.childrenOf = steps.map { step in trunk.trunkChildrenOf[step].map { nodeOf[$0] } }
    self.rectOf = rectOf
    self.ownRadiusOf = rectOf.map { rect in
      Arithmetic.hypot(Math.max(-rect.minX, rect.maxX), Math.max(-rect.minY, rect.maxY)) + tuckMargin / 2
    }
    self.subtreeSize = subtreeSize
    self.roots = roots
  }

  // Post-order over one root's subtree with siblings in trunk order: a subtree is a contiguous run ending at its head.
  func postOrderOf(_ root: Int) -> [Int] {
    var out: [Int] = []
    var stack = [root]
    while let node = stack.popLast() {
      out.append(node)
      stack.append(contentsOf: childrenOf[node])
    }
    out.reverse()
    return out
  }
}

// A step's child ring, each child's ray in its frame (+x away from its own parent), and the circle enclosing its subtree.
private struct Bubble {
  var ring: Double = 0
  var rays: [Double] = []
  var radius: Double = 0
  var cx: Double = 0
  var cy: Double = 0
}

// Bottom-up. A step's own circle reaches half the margin past its footprint, so tangent circles keep clear.
private func enclosingBubbles(_ forest: Forest) throws -> [Bubble] {
  var bubbles = [Bubble](repeating: Bubble(), count: forest.size)
  for node in stride(from: forest.size - 1, through: 0, by: -1) {
    let own = forest.ownRadiusOf[node]
    let children = forest.childrenOf[node].map { bubbles[$0] }
    if children.isEmpty {
      bubbles[node] = Bubble(ring: 0, rays: [], radius: stepUp(own, radiusStep), cx: 0, cy: 0)
      continue
    }
    let isRoot = forest.parentOf[node] == -1
    let free = isRoot ? twoPi : twoPi - inEdgeGap
    let ring = ringRadius(own, children, free)
    let rays = fanRays(ring, children, free, isRoot ? rootSpreadCap : 0)
    var discs = [Disc(x: 0, y: 0, r: own)]
    for (i, child) in children.enumerated() { discs.append(try circleOnRay(ring, rays[i], child)) }
    let enclosing = smallestCircleAround(discs)
    bubbles[node] = Bubble(ring: ring, rays: rays, radius: stepUp(enclosing.r, radiusStep), cx: enclosing.x, cy: enclosing.y)
  }
  return bubbles
}

private func stepUp(_ radius: Double, _ step: Double) -> Double {
  (radius / step).rounded(.up) * step
}

// The shortest ring on which every child's circle clears the step's own circle and, seen from the step, all their arcs
// fit inside the free angle.
private func ringRadius(_ own: Double, _ children: [Bubble], _ free: Double) -> Double {
  var ring: Double = 0
  for child in children {
    let reach = own + child.radius
    ring = Math.max(ring, Math.max(0, reach * reach - child.cy * child.cy).squareRoot() - child.cx)
  }
  func arcsFit(_ d: Double) -> Bool {
    var sum: Double = 0
    for child in children { sum = sum + arcOf(d, child) }
    return sum <= free
  }
  if arcsFit(ring) { return ring }
  var lo = ring
  var hi = ring
  var doubling = 0
  while doubling < 64 && !arcsFit(hi) {
    hi *= 2
    doubling += 1
  }
  for _ in 0..<48 {
    let mid = (lo + hi) / 2
    if arcsFit(mid) { hi = mid } else { lo = mid }
  }
  return hi
}

// The angle a child's circle covers, seen from the step, when the child sits `ring` out along its ray.
private func arcOf(_ ring: Double, _ child: Bubble) -> Double {
  2 * Arithmetic.asin(Math.min(1, child.radius / Arithmetic.hypot(ring + child.cx, child.cy)))
}

// Consecutive arcs packed edge to edge and centred on +x, a root's spread apart by the slack, up to the cap. A child's
// ray aims at the child itself; its circle's centre may sit beside the ray, so the arc is centred on that.
private func fanRays(_ ring: Double, _ children: [Bubble], _ free: Double, _ spreadCap: Double) -> [Double] {
  let arcs = children.map { arcOf(ring, $0) }
  var total: Double = 0
  for arc in arcs { total = total + arc }
  let gaps = Double(children.count - 1)
  let spread = children.count > 1 ? Math.min(spreadCap, (free - total) / gaps) : 0
  var cursor = -(total + spread * gaps) / 2
  var rays: [Double] = []
  for (i, child) in children.enumerated() {
    let arcCentre = cursor + arcs[i] / 2
    cursor += arcs[i] + spread
    rays.append(arcCentre - Arithmetic.atan2(child.cy, ring + child.cx))
  }
  return rays
}

// A child's subtree circle in its parent's frame: the child `ring` out along `angle`, facing along it.
private func circleOnRay(_ ring: Double, _ angle: Double, _ child: Bubble) throws -> Disc {
  let ux = try Arithmetic.cos(angle)
  let uy = try Arithmetic.sin(angle)
  return Disc(x: (ring + child.cx) * ux - child.cy * uy, y: (ring + child.cx) * uy + child.cy * ux, r: child.radius)
}

// Top-down: every root at its island's origin facing +x; a child leaves its parent along the parent's heading plus its
// ray and faces along that, so its own in-edge points straight back at the parent.
private func growIslands(_ forest: Forest, _ bubbles: [Bubble]) throws -> Positions {
  var x = [Double](repeating: 0, count: forest.size)
  var y = [Double](repeating: 0, count: forest.size)
  var heading = [Double](repeating: 0, count: forest.size)
  for node in 0..<forest.size {
    let ring = bubbles[node].ring
    for (i, child) in forest.childrenOf[node].enumerated() {
      let angle = heading[node] + bubbles[node].rays[i]
      x[child] = x[node] + ring * (try Arithmetic.cos(angle))
      y[child] = y[node] + ring * (try Arithmetic.sin(angle))
      heading[child] = angle
    }
  }
  return Positions(x: x, y: y)
}

// One root's subtree after its tuck: its post-order and the circle around it, in the island's frame.
private struct Island {
  let order: [Int]
  let x: Double
  let y: Double
  let r: Double
}

// Post-order over one island: each subtree, its children already tucked, slides toward its parent as far as the resting
// footprints and trunk edges allow. A move during which the budget passes below zero is discarded, and no later move is
// tried.
private func tuckIsland(_ forest: Forest, _ positions: inout Positions, _ root: Int, _ work: inout Double) -> Island {
  let order = forest.postOrderOf(root)
  var rank = [Int](repeating: 0, count: forest.size)
  for (i, node) in order.enumerated() { rank[node] = i }
  var resting = RestingSet(forest)
  for node in order { resting.rest(node, positions) }

  for head in order {
    if work < 0 { break }
    if head == root { continue }
    let parent = forest.parentOf[head]
    let vx = positions.x[parent] - positions.x[head]
    let vy = positions.y[parent] - positions.y[head]
    if Arithmetic.hypot(vx, vy) < epsilon { continue }
    let last = rank[head]
    let first = last - forest.subtreeSize[head] + 1
    let t = resting.room(order, first, last, vx, vy, positions, &work) { node in rank[node] >= first && rank[node] <= last }
    if t <= 0 { continue }
    for i in first...last { resting.lift(order[i]) }
    for i in first...last {
      positions.x[order[i]] += t * vx
      positions.y[order[i]] += t * vy
    }
    for i in first...last { resting.rest(order[i], positions) }
  }

  var corners: [Disc] = []
  for node in order {
    let footprint = resting.footprintOf(node, positions)
    corners.append(Disc(x: footprint.minX, y: footprint.minY, r: 0))
    corners.append(Disc(x: footprint.maxX, y: footprint.minY, r: 0))
    corners.append(Disc(x: footprint.minX, y: footprint.maxY, r: 0))
    corners.append(Disc(x: footprint.maxX, y: footprint.maxY, r: 0))
  }
  let circle = smallestCircleAround(corners)
  return Island(order: order, x: circle.x, y: circle.y, r: stepUp(circle.r + tuckMargin, islandStep))
}

// Islands in size order: the largest root at the world origin; every other keeps the direction the circle packing seats
// it in and slides along it until its footprints or trunk edges meet what is already resting. Settling has no budget:
// its work is counted against infinity.
private func settleIslands(_ forest: Forest, _ positions: inout Positions, _ islands: [Island]) {
  guard let anchor = islands.first else { return }
  var circles = islands.map { Disc(x: $0.x, y: $0.y, r: $0.r) }
  packCircles(&circles)
  var islandOf = [Int](repeating: 0, count: forest.size)
  for (i, island) in islands.enumerated() {
    for node in island.order { islandOf[node] = i }
  }
  var resting = RestingSet(forest)
  var unbudgeted = Double.infinity
  var reach = anchor.r
  for (i, island) in islands.enumerated() {
    if i > 0 {
      let seat = Arithmetic.hypot(circles[i].x, circles[i].y)
      let ux = circles[i].x / seat
      let uy = circles[i].y / seat
      let start = reach + island.r
      let vx = -ux * start
      let vy = -uy * start
      for node in island.order {
        positions.x[node] += anchor.x + ux * start - island.x
        positions.y[node] += anchor.y + uy * start - island.y
      }
      let t = resting.room(island.order, 0, island.order.count - 1, vx, vy, positions, &unbudgeted) { node in islandOf[node] == i }
      for node in island.order {
        positions.x[node] += t * vx
        positions.y[node] += t * vy
      }
      reach = Math.max(reach, start * (1 - t) + island.r)
    }
    for node in island.order { resting.rest(node, positions) }
  }
}

// The footprints and trunk edges already at rest, and how far a set of nodes may slide before coming within the margin
// of one, a trunk edge riding along between two sliding nodes included.
private struct RestingSet {
  let forest: Forest
  var footprints: RectGrid
  var edges: RectGrid

  init(_ forest: Forest) {
    self.forest = forest
    footprints = RectGrid(forest.size)
    edges = RectGrid(forest.size)
  }

  func footprintOf(_ node: Int, _ positions: Positions) -> Rect {
    let rect = forest.rectOf[node]
    let x = positions.x[node]
    let y = positions.y[node]
    return Rect(minX: x + rect.minX, maxX: x + rect.maxX, minY: y + rect.minY, maxY: y + rect.maxY)
  }

  // The disc as a circle: its centre and the body's radius (the footprint's top edge is the disc's rim).
  func discOf(_ node: Int, _ positions: Positions) -> Disc {
    Disc(x: positions.x[node], y: positions.y[node], r: -forest.rectOf[node].minY)
  }

  func edgeOf(_ node: Int, _ positions: Positions) -> Edge {
    let parent = forest.parentOf[node]
    return Edge(px: positions.x[parent], py: positions.y[parent], qx: positions.x[node], qy: positions.y[node])
  }

  mutating func rest(_ node: Int, _ positions: Positions) {
    footprints.insert(node, footprintOf(node, positions))
    if forest.parentOf[node] != -1 { edges.insert(node, boxOf(edgeOf(node, positions))) }
  }

  mutating func lift(_ node: Int) {
    footprints.remove(node)
    if forest.parentOf[node] != -1 { edges.remove(node) }
  }

  // The fraction of the move (vx, vy) that nodes[first...last] can take together, marching a cell at a time and asking
  // the grids a margin wider than each sweep, so a contact at the margin is never missed across a cell boundary. Each
  // march step of each sliding node costs one of `work`.
  mutating func room(
    _ nodes: [Int], _ first: Int, _ last: Int, _ vx: Double, _ vy: Double, _ positions: Positions, _ work: inout Double,
    sliding: (Int) -> Bool
  ) -> Double {
    let length = Arithmetic.hypot(vx, vy)
    let ux = vx / length
    let uy = vy / length
    var travelled: Double = 0
    while travelled < length {
      let step = Math.min(gridCell, length - travelled)
      var fraction: Double = 1
      for i in stride(from: first, through: last, by: 1) {
        work -= 1
        if work < 0 { return 0 }
        let node = nodes[i]
        let footprint = shift(footprintOf(node, positions), travelled * ux, travelled * uy)
        let swept = expand(sweep(footprint, step * ux, step * uy), tuckMargin)
        for other in footprints.within(swept, &work) where !sliding(other) {
          fraction = Math.min(fraction, footprintStop(footprint, step * ux, step * uy, footprintOf(other, positions)))
        }
        var disc = discOf(node, positions)
        disc.x += travelled * ux
        disc.y += travelled * uy
        let discBox = Rect(minX: disc.x - disc.r, maxX: disc.x + disc.r, minY: disc.y - disc.r, maxY: disc.y + disc.r)
        for other in footprints.within(expand(sweep(discBox, step * ux, step * uy), discAir), &work) where !sliding(other) {
          fraction = Math.min(fraction, discStop(disc, step * ux, step * uy, discOf(other, positions)))
        }
        for other in edges.within(swept, &work) where !sliding(other) {
          fraction = Math.min(fraction, edgeStop(edgeOf(other, positions), -step * ux, -step * uy, footprint))
        }
        let parent = forest.parentOf[node]
        if parent == -1 || !sliding(parent) { continue }
        let edge = shiftEdge(edgeOf(node, positions), travelled * ux, travelled * uy)
        for other in footprints.within(expand(sweep(boxOf(edge), step * ux, step * uy), tuckMargin), &work) where !sliding(other) {
          fraction = Math.min(fraction, edgeStop(edge, step * ux, step * uy, footprintOf(other, positions)))
        }
      }
      if work < 0 { return 0 }
      if fraction < 1 { return (travelled + fraction * step) / length }
      travelled += gridCell
    }
    return 1
  }
}

// Circles in the given order: the first at the origin, each next tangent to two on the front chain, at the seat nearest
// the origin (Wang, Wang, Dai & Wang 2006, the way d3 packs siblings). Depends on the radii alone. The chain is a ring of
// circles, each naming its `next` and its `previous` by place.
private func packCircles(_ circles: inout [Disc]) {
  if circles.isEmpty { return }
  circles[0].x = 0
  circles[0].y = 0
  if circles.count == 1 { return }
  circles[1].x = circles[0].r + circles[1].r
  circles[1].y = 0
  if circles.count == 2 { return }
  circles[2] = placeTangent(circles[1], circles[0], circles[2])
  var a = 0
  var b = 1
  var c = 2
  var next = [Int](repeating: 0, count: circles.count)
  var previous = [Int](repeating: 0, count: circles.count)
  next[a] = b
  previous[c] = b
  next[b] = c
  previous[a] = c
  next[c] = a
  previous[b] = a

  var i = 3
  while i < circles.count {
    circles[i] = placeTangent(circles[a], circles[b], circles[i])
    c = i
    var j = next[b]
    var k = previous[a]
    var sj = circles[b].r
    var sk = circles[a].r
    var collided = false
    repeat {
      if sj <= sk {
        if intersects(circles[j], circles[c]) {
          b = j
          next[a] = b
          previous[b] = a
          collided = true
          break
        }
        sj += circles[j].r
        j = next[j]
      } else {
        if intersects(circles[k], circles[c]) {
          a = k
          next[a] = b
          previous[b] = a
          collided = true
          break
        }
        sk += circles[k].r
        k = previous[k]
      }
    } while j != next[k]
    if collided { continue }

    // `a.next = b.previous = b = c`: c joins the chain between a and the b named before, and b names c afterwards.
    previous[c] = a
    next[c] = b
    previous[b] = c
    next[a] = c
    b = c
    var best = seatDistance(circles, next, a)
    c = next[c]
    while c != b {
      let distance = seatDistance(circles, next, c)
      if distance < best {
        a = c
        best = distance
      }
      c = next[c]
    }
    b = next[a]
    i += 1
  }
}

// Puts c tangent to both b and a, on the outer side of the chain running from a to b.
private func placeTangent(_ b: Disc, _ a: Disc, _ c: Disc) -> Disc {
  let dx = b.x - a.x
  let dy = b.y - a.y
  let d2 = dx * dx + dy * dy
  if d2 == 0 { return Disc(x: a.x + c.r, y: a.y, r: c.r) }
  let a2 = (a.r + c.r) * (a.r + c.r)
  let b2 = (b.r + c.r) * (b.r + c.r)
  if a2 > b2 {
    let x = (d2 + b2 - a2) / (2 * d2)
    let y = Math.max(0, b2 / d2 - x * x).squareRoot()
    return Disc(x: b.x - x * dx - y * dy, y: b.y - x * dy + y * dx, r: c.r)
  }
  let x = (d2 + a2 - b2) / (2 * d2)
  let y = Math.max(0, a2 / d2 - x * x).squareRoot()
  return Disc(x: a.x + x * dx - y * dy, y: a.y + x * dy + y * dx, r: c.r)
}

private func intersects(_ a: Disc, _ b: Disc) -> Bool {
  let reach = a.r + b.r - 1e-6
  return reach > 0 && reach * reach > (b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)
}

// How far from the origin the seat between a chain link and its next one lies.
private func seatDistance(_ circles: [Disc], _ next: [Int], _ link: Int) -> Double {
  let a = circles[link]
  let b = circles[next[link]]
  let dx = (a.x * b.r + b.x * a.r) / (a.r + b.r)
  let dy = (a.y * b.r + b.y * a.r) / (a.r + b.r)
  return dx * dx + dy * dy
}

// The smallest circle enclosing a set of discs, exact: grow a basis of at most three discs by the one currently furthest
// outside, re-solving the basis each round (bounded; the last resort widens the circle to reach it).
private func smallestCircleAround(_ discs: [Disc]) -> Disc {
  var basis = [discs[0]]
  var circle = discs[0]
  for _ in 0..<(64 + discs.count) {
    var outermost: Disc?
    var outBy = epsilon * (1 + circle.r)
    for disc in discs {
      let by = Arithmetic.hypot(disc.x - circle.x, disc.y - circle.y) + disc.r - circle.r
      if by > outBy {
        outermost = disc
        outBy = by
      }
    }
    guard let outermost else { return circle }
    guard let improved = smallestBasis(basis + [outermost]) else { break }
    basis = improved.basis
    circle = improved.circle
  }
  var r: Double = 0
  for disc in discs { r = Math.max(r, Arithmetic.hypot(disc.x - circle.x, disc.y - circle.y) + disc.r) }
  return Disc(x: circle.x, y: circle.y, r: r)
}

// Among every one-, two- and three-disc subset of at most four discs, the smallest circle enclosing all of them.
private func smallestBasis(_ discs: [Disc]) -> (basis: [Disc], circle: Disc)? {
  var best: (basis: [Disc], circle: Disc)?
  func consider(_ basis: [Disc]) {
    let solved: Disc?
    switch basis.count {
    case 1: solved = basis[0]
    case 2: solved = circleOfTwoDiscs(basis[0], basis[1])
    default: solved = circleOfThreeDiscs(basis[0], basis[1], basis[2])
    }
    guard let circle = solved, discs.allSatisfy({ encloses(circle, $0) }) else { return }
    if let best, !(circle.r < best.circle.r) { return }
    best = (basis, circle)
  }
  for i in discs.indices {
    consider([discs[i]])
    for j in discs.indices where j > i {
      consider([discs[i], discs[j]])
      for k in discs.indices where k > j { consider([discs[i], discs[j], discs[k]]) }
    }
  }
  return best
}

private func encloses(_ circle: Disc, _ disc: Disc) -> Bool {
  Arithmetic.hypot(disc.x - circle.x, disc.y - circle.y) + disc.r <= circle.r + epsilon * (1 + circle.r)
}

private func circleOfTwoDiscs(_ a: Disc, _ b: Disc) -> Disc {
  let distance = Arithmetic.hypot(b.x - a.x, b.y - a.y)
  if distance + b.r <= a.r + epsilon { return a }
  if distance + a.r <= b.r + epsilon { return b }
  let r = (distance + a.r + b.r) / 2
  let k = (r - a.r) / distance
  return Disc(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, r: r)
}

// The circle tangent to three discs from outside: its centre is affine in its radius, which a quadratic then fixes.
private func circleOfThreeDiscs(_ a: Disc, _ b: Disc, _ c: Disc) -> Disc? {
  let m00 = 2 * (a.x - b.x)
  let m01 = 2 * (a.y - b.y)
  let m10 = 2 * (a.x - c.x)
  let m11 = 2 * (a.y - c.y)
  let det = m00 * m11 - m01 * m10
  if det.magnitude < 1e-12 { return nil }
  let kab: Double = (a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y) - (a.r * a.r - b.r * b.r)
  let kac: Double = (a.x * a.x + a.y * a.y - c.x * c.x - c.y * c.y) - (a.r * a.r - c.r * c.r)
  let vab = 2 * (a.r - b.r)
  let vac = 2 * (a.r - c.r)
  let ax = (m11 * kab - m01 * kac) / det
  let ay = (-m10 * kab + m00 * kac) / det
  let bx = (m11 * vab - m01 * vac) / det
  let by = (-m10 * vab + m00 * vac) / det
  let wx = ax - a.x
  let wy = ay - a.y
  let qa: Double = bx * bx + by * by - 1
  let qb: Double = 2 * (wx * bx + wy * by + a.r)
  let qc: Double = wx * wx + wy * wy - a.r * a.r
  var roots: [Double] = []
  if qa.magnitude < 1e-12 {
    if qb.magnitude > 1e-12 { roots.append(-qc / qb) }
  } else if qb * qb - 4 * qa * qc >= 0 {
    let s = (qb * qb - 4 * qa * qc).squareRoot()
    roots.append((-qb - s) / (2 * qa))
    roots.append((-qb + s) / (2 * qa))
  }
  var best: Disc?
  for r in roots {
    if !(r >= Math.max(a.r, b.r, c.r) - epsilon) { continue }
    let circle = Disc(x: ax + r * bx, y: ay + r * by, r: r)
    if !(encloses(circle, a) && encloses(circle, b) && encloses(circle, c)) { continue }
    if let best, !(circle.r < best.r) { continue }
    best = circle
  }
  return best
}

// The fraction of the move (vx, vy) the moving footprint can take before coming within the margin of the still one; a
// pair already inside each other's margin stops at their bare rims instead; 1 when they never meet.
private func footprintStop(_ moving: Rect, _ vx: Double, _ vy: Double, _ still: Rect) -> Double {
  guard let margined = entryTime(moving, vx, vy, expand(still, tuckMargin)) else { return 1 }
  if !margined.alreadyInside { return margined.t }
  return entryTime(moving, vx, vy, still)?.t ?? 1
}

// The fraction of the move (vx, vy) the moving disc can take before its rim comes within `discAir` of the still disc's
// rim, as circles, so a diagonal neighbour is judged by its true distance; a pair already inside that air stops at their
// bare rims instead; 1 when they never meet.
private func discStop(_ moving: Disc, _ vx: Double, _ vy: Double, _ still: Disc) -> Double {
  let dx = moving.x - still.x
  let dy = moving.y - still.y
  let apart = Arithmetic.hypot(dx, dy)
  var reach = moving.r + still.r + discAir
  if apart < reach - epsilon {
    reach = moving.r + still.r
    if apart < reach - epsilon { return 1 }
  }
  let a = vx * vx + vy * vy
  let b = 2 * (dx * vx + dy * vy)
  let c = apart * apart - reach * reach
  if a < epsilon || b >= 0 { return 1 }
  let discriminant = b * b - 4 * a * c
  if discriminant < 0 { return 1 }
  let t = (-b - discriminant.squareRoot()) / (2 * a)
  if t >= 1 { return 1 }
  return Math.max(0, t)
}

// The fraction of the move (ux, uy) the trunk edge can take before coming within the margin of the still footprint; an
// edge already inside the margin stops at the bare rim; a crossing that already exists never blocks.
private func edgeStop(_ edge: Edge, _ ux: Double, _ uy: Double, _ still: Rect) -> Double {
  if segmentHitsRect(edge, expand(still, tuckMargin)) {
    if segmentHitsRect(edge, still) { return 1 }
    return segmentEntryTime(edge, ux, uy, still) ?? 1
  }
  return segmentEntryTime(edge, ux, uy, expand(still, tuckMargin)) ?? 1
}

// The fraction of the move (vx, vy) at which rect `a` first strictly overlaps the static rect `b`, and whether it
// already does; nil when it never will within the move.
private func entryTime(_ a: Rect, _ vx: Double, _ vy: Double, _ b: Rect) -> (t: Double, alreadyInside: Bool)? {
  var enter = -Double.infinity
  var exit = Double.infinity
  if vx == 0 {
    if a.maxX <= b.minX || a.minX >= b.maxX { return nil }
  } else {
    enter = Math.min((b.minX - a.maxX) / vx, (b.maxX - a.minX) / vx)
    exit = Math.max((b.minX - a.maxX) / vx, (b.maxX - a.minX) / vx)
  }
  if vy == 0 {
    if a.maxY <= b.minY || a.minY >= b.maxY { return nil }
  } else {
    enter = Math.max(enter, Math.min((b.minY - a.maxY) / vy, (b.maxY - a.minY) / vy))
    exit = Math.min(exit, Math.max((b.minY - a.maxY) / vy, (b.maxY - a.minY) / vy))
  }
  if enter >= exit || exit <= 0 || enter >= 1 { return nil }
  return (Math.max(enter, 0), enter < -epsilon)
}

// The fraction of the move (ux, uy) at which the segment first enters the rect's interior, an endpoint entering or a
// corner crossing it (a graze stops it at once); nil when it never does. Assumes no crossing before the move.
private func segmentEntryTime(_ edge: Edge, _ ux: Double, _ uy: Double, _ rect: Rect) -> Double? {
  var first = Double.infinity
  if let p = entryTime(Rect(minX: edge.px, maxX: edge.px, minY: edge.py, maxY: edge.py), ux, uy, rect) { first = p.t }
  if let q = entryTime(Rect(minX: edge.qx, maxX: edge.qx, minY: edge.qy, maxY: edge.qy), ux, uy, rect) { first = Math.min(first, q.t) }
  let dx = edge.qx - edge.px
  let dy = edge.qy - edge.py
  let det = ux * dy - dx * uy
  if det.magnitude > 1e-12 {
    for corner in 0..<4 {
      let wx = (corner & 1 != 0 ? rect.maxX : rect.minX) - edge.px
      let wy = (corner & 2 != 0 ? rect.maxY : rect.minY) - edge.py
      let t = (wx * dy - dx * wy) / det
      let s = (ux * wy - uy * wx) / det
      if s >= 0 && s <= 1 && t >= -graze && t <= 1 { first = Math.min(first, Math.max(t, 0)) }
    }
  }
  return first == .infinity ? nil : first
}

// Liang–Barsky: does the segment pass through the rect's interior?
private func segmentHitsRect(_ edge: Edge, _ rect: Rect) -> Bool {
  let dx = edge.qx - edge.px
  let dy = edge.qy - edge.py
  var t0: Double = 0
  var t1: Double = 1
  func clip(_ p: Double, _ q: Double) -> Bool {
    if p == 0 { return q >= 0 }
    if p < 0 { t0 = Math.max(t0, q / p) } else { t1 = Math.min(t1, q / p) }
    return t0 <= t1
  }
  return clip(-dx, edge.px - rect.minX) && clip(dx, rect.maxX - edge.px) && clip(-dy, edge.py - rect.minY)
    && clip(dy, rect.maxY - edge.py) && t1 - t0 > 1e-6
}

private func boxOf(_ edge: Edge) -> Rect {
  Rect(minX: Math.min(edge.px, edge.qx), maxX: Math.max(edge.px, edge.qx), minY: Math.min(edge.py, edge.qy), maxY: Math.max(edge.py, edge.qy))
}

private func shift(_ rect: Rect, _ dx: Double, _ dy: Double) -> Rect {
  Rect(minX: rect.minX + dx, maxX: rect.maxX + dx, minY: rect.minY + dy, maxY: rect.maxY + dy)
}

private func shiftEdge(_ edge: Edge, _ dx: Double, _ dy: Double) -> Edge {
  Edge(px: edge.px + dx, py: edge.py + dy, qx: edge.qx + dx, qy: edge.qy + dy)
}

private func sweep(_ rect: Rect, _ vx: Double, _ vy: Double) -> Rect {
  Rect(
    minX: Math.min(rect.minX, rect.minX + vx), maxX: Math.max(rect.maxX, rect.maxX + vx),
    minY: Math.min(rect.minY, rect.minY + vy), maxY: Math.max(rect.maxY, rect.maxY + vy))
}

private func expand(_ rect: Rect, _ by: Double) -> Rect {
  Rect(minX: rect.minX - by, maxX: rect.maxX + by, minY: rect.minY - by, maxY: rect.maxY + by)
}

// Small rectangles use grid cells; wide rectangles and wide queries scan what the grid stores. A query spends `work`:
// one for every rectangle stored when it covers more cells than that; otherwise the number of cells it covers, one for
// every entry in those cells' buckets, and one for every rectangle too wide for the cells. What a query finds is taken
// for a least value alone, so the order rectangles are walked in decides nothing.
private struct RectGrid {
  var cells: [Double: [Int]] = [:]
  var rects: [Int: Rect] = [:]
  var wide: Set<Int> = []
  var found: [Int] = []
  // The web's `Int32Array`: a stamp is held as its low 32 bits.
  var seen: [Int32]
  var stamp = 0

  init(_ capacity: Int) {
    seen = [Int32](repeating: 0, count: capacity)
  }

  mutating func insert(_ node: Int, _ rect: Rect) {
    rects[node] = rect
    let columns = (rect.maxX / gridCell).rounded(.down) - (rect.minX / gridCell).rounded(.down) + 1
    let rows = (rect.maxY / gridCell).rounded(.down) - (rect.minY / gridCell).rounded(.down) + 1
    if columns * rows > maxRectCells {
      wide.insert(node)
      return
    }
    var i = (rect.minX / gridCell).rounded(.down)
    while i <= (rect.maxX / gridCell).rounded(.down) {
      var j = (rect.minY / gridCell).rounded(.down)
      while j <= (rect.maxY / gridCell).rounded(.down) {
        cells[cellKey(i, j), default: []].append(node)
        j += 1
      }
      i += 1
    }
  }

  mutating func remove(_ node: Int) {
    guard let rect = rects.removeValue(forKey: node) else { return }
    if wide.remove(node) != nil { return }
    var i = (rect.minX / gridCell).rounded(.down)
    while i <= (rect.maxX / gridCell).rounded(.down) {
      var j = (rect.minY / gridCell).rounded(.down)
      while j <= (rect.maxY / gridCell).rounded(.down) {
        if let slot = cells.index(forKey: cellKey(i, j)) {
          if let at = cells.values[slot].firstIndex(of: node) { cells.values[slot][at] = cells.values[slot][cells.values[slot].count - 1] }
          cells.values[slot].removeLast()
          if cells.values[slot].isEmpty { cells.remove(at: slot) }
        }
        j += 1
      }
      i += 1
    }
  }

  mutating func within(_ rect: Rect, _ work: inout Double) -> [Int] {
    stamp += 1
    found.removeAll(keepingCapacity: true)
    let columns = (rect.maxX / gridCell).rounded(.down) - (rect.minX / gridCell).rounded(.down) + 1
    let rows = (rect.maxY / gridCell).rounded(.down) - (rect.minY / gridCell).rounded(.down) + 1
    if columns * rows > Double(rects.count) {
      for (node, bounds) in rects {
        work -= 1
        if work < 0 { return found }
        if rectsTouch(rect, bounds) { found.append(node) }
      }
      return found
    }
    work -= columns * rows
    if work < 0 { return found }
    var i = (rect.minX / gridCell).rounded(.down)
    while i <= (rect.maxX / gridCell).rounded(.down) {
      var j = (rect.minY / gridCell).rounded(.down)
      while j <= (rect.maxY / gridCell).rounded(.down) {
        for node in cells[cellKey(i, j)] ?? [] {
          work -= 1
          if work < 0 { return found }
          if Int(seen[node]) == stamp { continue }
          seen[node] = Int32(truncatingIfNeeded: stamp)
          found.append(node)
        }
        j += 1
      }
      i += 1
    }
    for node in wide {
      work -= 1
      if work < 0 { return found }
      if let bounds = rects[node], rectsTouch(rect, bounds) { found.append(node) }
    }
    return found
  }
}

private func rectsTouch(_ a: Rect, _ b: Rect) -> Bool {
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}

// Two cells further than 32,768 from the origin can share a key.
private func cellKey(_ i: Double, _ j: Double) -> Double {
  (i + 0x8000) * 0x10000 + (j + 0x8000)
}
