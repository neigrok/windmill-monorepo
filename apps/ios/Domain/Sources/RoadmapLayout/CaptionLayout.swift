// Captions, decided: which steps get a name, where it sits and when it appears. The web's `scene/captionLayout.js`
// function for function, with the grid that says which steps are near a view, `model/SpatialGrid.js`. Screen px
// throughout; the canvas measures the text and draws each name in the box this file returns.

private let workingBodyPx: Double = 18
private let frontierBodyPx: Double = 12
private let branchHeadMinSubtree = 8
// The text column inside the 168 px box.
private let textWidth = Theme.Caption.maxWidthPx - Theme.Caption.padPx * 2
private let rimFraction = Theme.bodyFraction / 2
private let candidateLimit = CaptionPlacer.pool * 3
private let collisionGap: Double = 2
private let cellPx: Double = 64
// A step this far past the canvas edge can still own a caption on it.
private let reachPx: Double = 200
// The longest sampled crossing near a caption.
private let ribbonStepPx: Double = 16
private let ribbonStepsMax: Double = 96
// Half the drawn ribbon, plus its halo.
private let ribbonHalfPx: Double = 3
private let ellipsis: Unicode.Scalar = "\u{2026}"

// A caption's wrapped text and the size it takes: up to two lines of the text column, broken at a space, the second
// line ellipsised.
public struct CaptionMetric: Sendable, Equatable {
  public let lines: [String]
  public let width: Double
  public let height: Double

  // The fixtures' ruler: a text is `charPx` wide for each of its code points.
  public static func ruler(_ text: String) -> Double {
    Theme.Caption.charPx * Double(text.unicodeScalars.count)
  }

  // `measure` is a text's width in px under the caption font. The label is trimmed and each run of JavaScript's white
  // space made one space. A blank label has no caption.
  public init?(wrapping label: String, measure: (String) -> Double) {
    var source: [Unicode.Scalar] = []
    var gap = false
    for scalar in label.unicodeScalars {
      if scalar.isJavaScriptWhiteSpace {
        gap = !source.isEmpty
        continue
      }
      if gap { source.append(" ") }
      gap = false
      source.append(scalar)
    }
    if source.isEmpty { return nil }
    let whole = measure(text(source))
    if whole <= textWidth {
      lines = [text(source)]
      width = whole
      height = Theme.Caption.linePx
      return
    }
    let first = firstLine(source, measure)
    let rest = Array(source.dropFirst(first.count).drop(while: \.isJavaScriptWhiteSpace))
    let second = measure(text(rest)) <= textWidth ? rest : widestPrefix(rest, measure, [ellipsis]) + [ellipsis]
    lines = [text(first), text(second)]
    width = Math.max(measure(text(first)), measure(text(second)))
    height = Theme.Caption.linePx * 2
  }
}

private func text(_ scalars: [Unicode.Scalar]) -> String {
  String(String.UnicodeScalarView(scalars))
}

// The longest run of whole words that fits; a first word wider than the column is cut between code points.
private func firstLine(_ source: [Unicode.Scalar], _ measure: (String) -> Double) -> [Unicode.Scalar] {
  let words = source.split(separator: " ", omittingEmptySubsequences: false)
  var line: [Unicode.Scalar] = []
  for word in words {
    let longer = line.isEmpty ? Array(word) : line + [" "] + word
    if measure(text(longer)) > textWidth { break }
    line = longer
  }
  if !line.isEmpty { return line }
  return widestPrefix(Array(words[0]), measure, [])
}

// The most code points of `points` that, followed by `tail`, still fit the column; at least one.
private func widestPrefix(_ points: [Unicode.Scalar], _ measure: (String) -> Double, _ tail: [Unicode.Scalar]) -> [Unicode.Scalar] {
  func trimmedPrefix(_ count: Int) -> [Unicode.Scalar] {
    var prefix = Array(points.prefix(count))
    while let last = prefix.last, last.isJavaScriptWhiteSpace { prefix.removeLast() }
    return prefix
  }
  var low = 1
  var high = points.count
  while low < high {
    let mid = (low + high + 1) / 2
    if measure(text(trimmedPrefix(mid) + tail)) > textWidth { high = mid - 1 } else { low = mid }
  }
  return trimmedPrefix(low)
}

// What a caption is named for, first to last.
public enum CaptionRank: Int, Sendable, Comparable {
  case selected = 0
  case hovered = 1
  // The selected step's trunk parent and trunk children.
  case family = 2
  // Crowned roots and branch heads.
  case anchor = 3
  // Available steps.
  case frontier = 4
  case rest = 5

  public static func < (a: CaptionRank, b: CaptionRank) -> Bool { a.rawValue < b.rawValue }
}

// Where a caption sits about its disc.
public enum CaptionAnchor: Int, Sendable, CaseIterable {
  case below = 0
  case above = 1
  case right = 2
  case left = 3
}

public struct Caption: Sendable {
  public let id: UTF16Text
  public let anchor: CaptionAnchor
  public let left: Double
  public let top: Double
  public let width: Double
  public let height: Double
  public let lines: [String]
  // Past its wait.
  public let shown: Bool
}

// A box the chrome holds, anchored to a corner of the viewport.
public struct Block: Sendable {
  public enum Horizontal: Sendable {
    case left(Double)
    case right(Double)
  }

  public enum Vertical: Sendable {
    case top(Double)
    case bottom(Double)
  }

  public var horizontal: Horizontal
  public var vertical: Vertical
  public var width: Double
  public var height: Double

  public init(horizontal: Horizontal, vertical: Vertical, width: Double, height: Double) {
    self.horizontal = horizontal
    self.vertical = vertical
    self.width = width
    self.height = height
  }
}

// A uniform bucket grid over seated steps, for the steps near a view.
public struct SpatialGrid: Sendable {
  private struct Cell: Hashable {
    let x: Double
    let y: Double
  }

  private let cellSize: Double
  private let nodes: [RenderModel.Node]
  private var cells: [Cell: [Int]] = [:]

  public init(_ nodes: [RenderModel.Node], cellSize: Double) {
    self.cellSize = cellSize
    self.nodes = nodes
    for (place, node) in nodes.enumerated() {
      cells[Cell(x: (node.x / cellSize).rounded(.down), y: (node.y / cellSize).rounded(.down)), default: []].append(place)
    }
  }

  // Every step in the box, cell by cell; a box that asks for more cells than the grid holds walks every step instead.
  func within(_ minX: Double, _ minY: Double, _ maxX: Double, _ maxY: Double) -> [Int] {
    let cellXMin = (minX / cellSize).rounded(.down)
    let cellYMin = (minY / cellSize).rounded(.down)
    let cellXMax = (maxX / cellSize).rounded(.down)
    let cellYMax = (maxY / cellSize).rounded(.down)
    var scanned: [Int] = []
    if (cellXMax - cellXMin + 1) * (cellYMax - cellYMin + 1) > Double(cells.count) {
      scanned = Array(nodes.indices)
    } else {
      var cellX = cellXMin
      while cellX <= cellXMax {
        var cellY = cellYMin
        while cellY <= cellYMax {
          scanned.append(contentsOf: cells[Cell(x: cellX, y: cellY)] ?? [])
          cellY += 1
        }
        cellX += 1
      }
    }
    return scanned.filter { place in
      let node = nodes[place]
      return !(node.x < minX || node.x > maxX || node.y < minY || node.y > maxY)
    }
  }
}

private struct Box {
  var left: Double
  var top: Double
  var right: Double
  var bottom: Double
}

// What a seat may not touch. A caption keeps clear of all three; one that cannot goes on a branch rather than unsaid;
// a landmark below the working view may cross the dots and threads, but never another name.
private enum Obstacle: Int {
  // A placed caption, or chrome holding a corner.
  case name = 0
  case disc = 1
  case ribbon = 2
}

private struct Ribbon {
  let fx: Double
  let fy: Double
  let tx: Double
  let ty: Double
  let cx: Double
  let cy: Double
  let length: Double
}

// Boxes bucketed by 64 px cell, so a collision test touches only the cells a box covers.
private struct CollisionGrid {
  var cells: [Double: [(box: Box, kind: Obstacle)]] = [:]
  var ribbons: [Ribbon] = []

  mutating func insert(_ box: Box, _ kind: Obstacle) {
    let lastX = ((box.right + collisionGap) / cellPx).rounded(.down)
    let lastY = ((box.bottom + collisionGap) / cellPx).rounded(.down)
    var cellX = ((box.left - collisionGap) / cellPx).rounded(.down)
    while cellX <= lastX {
      var cellY = ((box.top - collisionGap) / cellPx).rounded(.down)
      while cellY <= lastY {
        cells[(cellX + 32768) * 65536 + (cellY + 32768), default: []].append((box, kind))
        cellY += 1
      }
      cellX += 1
    }
  }

  // Whether `box` touches anything of kind `upTo` or lower; the kinds above it are the ones this pass may cross.
  func collides(_ box: Box, _ upTo: Obstacle) -> Bool {
    let lastX = ((box.right + collisionGap) / cellPx).rounded(.down)
    let lastY = ((box.bottom + collisionGap) / cellPx).rounded(.down)
    var cellX = ((box.left - collisionGap) / cellPx).rounded(.down)
    while cellX <= lastX {
      var cellY = ((box.top - collisionGap) / cellPx).rounded(.down)
      while cellY <= lastY {
        for other in cells[(cellX + 32768) * 65536 + (cellY + 32768)] ?? [] {
          if other.kind.rawValue > upTo.rawValue { continue }
          if box.left < other.box.right + collisionGap && box.right > other.box.left - collisionGap
            && box.top < other.box.bottom + collisionGap && box.bottom > other.box.top - collisionGap
          {
            return true
          }
        }
        cellY += 1
      }
      cellX += 1
    }
    if upTo.rawValue < Obstacle.ribbon.rawValue { return false }
    for ribbon in ribbons {
      guard
        let crossing = chordRange(
          ribbon.fx, ribbon.fy, ribbon.tx, ribbon.ty, box, EdgeCurve.bendReach * ribbon.length + ribbonHalfPx + collisionGap)
      else { continue }
      let (lo, hi) = crossing
      let steps = Math.min(ribbonStepsMax, Math.max(1, (((hi - lo) * ribbon.length) / ribbonStepPx).rounded(.up)))
      var previous = EdgeCurve.pointOnCurve(ribbon.fx, ribbon.fy, ribbon.cx, ribbon.cy, ribbon.tx, ribbon.ty, lo)
      var step: Double = 1
      while step <= steps {
        let point = EdgeCurve.pointOnCurve(ribbon.fx, ribbon.fy, ribbon.cx, ribbon.cy, ribbon.tx, ribbon.ty, lo + ((hi - lo) * step) / steps)
        if chordRange(previous.x, previous.y, point.x, point.y, box, ribbonHalfPx + collisionGap) != nil { return true }
        previous = point
        step += 1
      }
    }
    return false
  }
}

// One caption's record across passes: pending, shown, or leaving, since when, and the seat it last took.
private struct Record {
  enum Phase {
    case pending
    case shown
    case leaving
  }

  var phase: Phase
  var since: Double
  var anchor: CaptionAnchor
  var pass: Int
}

private struct Candidate {
  let id: UTF16Text
  let sx: Double
  let sy: Double
  let rim: Double
  let metric: CaptionMetric
  let rank: CaptionRank
  let eligible: Bool
  let landmark: Bool
  let forced: Bool
  let weight: Int
  let newcomer: Bool
  let distance: Double

  // Priority first; among the anchors the biggest subtree first, so a crown outranks a lone step; then a caption already
  // on screen, then nearness to the viewport centre, then id: two passes over the same picture agree.
  static func byPriority(_ a: Candidate, _ b: Candidate) -> Bool {
    if a.rank != b.rank { return a.rank < b.rank }
    if a.weight != b.weight { return a.weight > b.weight }
    if a.newcomer != b.newcomer { return b.newcomer }
    let nearer = a.distance - b.distance
    if nearer < 0 || nearer > 0 { return nearer < 0 }
    return a.id < b.id
  }
}

// The model's index, the metrics, the selection and each caption's record. `place` is the one decision, the same for
// the same inputs and clock; a pass meets the records the passes before it left.
public struct CaptionPlacer: Sendable {
  // The most captions on screen at once.
  public static let pool = 96
  // Continuous eligibility before a caption appears, and continuous ineligibility before a shown caption goes, in ms.
  public static let showAfterMs: Double = 200
  public static let hideAfterMs: Double = 200

  private var nodes: [RenderModel.Node] = []
  private var placeOf: [UTF16Text: Int] = [:]
  private var links: [RenderModel.Link] = []
  private var spatialGrid: SpatialGrid?
  private var trunkParentOf: [Int?] = []
  private var trunkChildrenOf: [[Int]] = []
  private var anchors: Set<Int> = []
  private var subtreeSizeOf: [Int] = []
  private var metricByID: [UTF16Text: CaptionMetric] = [:]
  private var selected: Int?
  private var hovered: Int?
  private var family: Set<Int> = []
  private var insets = Insets()
  private var blocks: [Block] = []
  private var records: [UTF16Text: Record] = [:]
  private var pass = 0

  public init() {}

  // Records survive a model installed again, so a live edit never blinks every caption.
  public mutating func setModel(_ model: RenderModel, _ spatialGrid: SpatialGrid) {
    let selectedID = selected.map { nodes[$0].id }
    let hoveredID = hovered.map { nodes[$0].id }
    nodes = model.nodes
    placeOf = [:]
    for (place, node) in nodes.enumerated() { placeOf[node.id] = place }
    links = model.links
    self.spatialGrid = spatialGrid
    trunkParentOf = [Int?](repeating: nil, count: nodes.count)
    trunkChildrenOf = [[Int]](repeating: [], count: nodes.count)
    for link in links where link.kind == .trunk {
      trunkParentOf[link.to] = link.from
      trunkChildrenOf[link.from].append(link.to)
    }

    // The trunk links form a forest; every step's size counts itself and its trunk descendants.
    var order: [Int] = []
    var stack = nodes.indices.filter { trunkParentOf[$0] == nil }
    while let node = stack.popLast() {
      order.append(node)
      stack.append(contentsOf: trunkChildrenOf[node])
    }
    subtreeSizeOf = [Int](repeating: 0, count: nodes.count)
    for node in order.reversed() {
      subtreeSizeOf[node] = trunkChildrenOf[node].reduce(1) { $0 + subtreeSizeOf[$1] }
    }

    anchors = Set(nodes.indices.filter { nodes[$0].crowned || (nodes[$0].branch == $0 && subtreeSizeOf[$0] >= branchHeadMinSubtree) })
    records = records.filter { placeOf[$0.key] != nil }
    setContext(selected: selectedID, hovered: hoveredID)
  }

  // Each step's wrapped caption, by id; a step with none is never named.
  public mutating func setMetrics(_ metricByID: [UTF16Text: CaptionMetric]) {
    self.metricByID = metricByID
  }

  public mutating func setContext(selected: UTF16Text?, hovered: UTF16Text?) {
    self.selected = selected.flatMap { placeOf[$0] }
    self.hovered = hovered.flatMap { placeOf[$0] }
    family = []
    guard let selected = self.selected else { return }
    if let parent = trunkParentOf[selected] { family.insert(parent) }
    family.formUnion(trunkChildrenOf[selected])
  }

  // `blocks` are the corners chrome holds; the sides it covers are the insets.
  public mutating func setInsets(_ insets: Insets, blocks: [Block]) {
    self.insets = insets
    self.blocks = blocks
  }

  // The last rank named at this zoom, keyed on the body as drawn, never below the floor it keeps: the landmarks always,
  // the frontier from 12 px, everyone from 18 px.
  public static func captionRankLimit(_ zoom: Double) -> CaptionRank {
    let bodyPx = Math.max(Theme.nodeSize * Theme.bodyFraction * zoom, Theme.minBodyPx)
    if bodyPx < frontierBodyPx { return .anchor }
    if bodyPx < workingBodyPx { return .frontier }
    return .rest
  }

  private func rankOf(_ node: Int) -> CaptionRank {
    if node == selected { return .selected }
    if node == hovered { return .hovered }
    if family.contains(node) { return .family }
    if anchors.contains(node) { return .anchor }
    if nodes[node].tier == .available { return .frontier }
    return .rest
  }

  // The captions to draw at a camera and the clock `now`, in ms, in priority order, and the clock at which the next one
  // changes; nil when none will.
  public mutating func place(camera: Frame, viewport: Viewport, now: Double) -> (captions: [Caption], nextDeadline: Double?) {
    pass += 1
    var captions: [Caption] = []
    if let spatialGrid { placeRanks(spatialGrid, camera, viewport, now, CaptionPlacer.captionRankLimit(camera.zoom), &captions) }

    records = records.filter { $0.value.pass == pass }
    var nextDeadline: Double?
    for record in records.values where record.phase != .shown {
      let due = record.since + (record.phase == .pending ? CaptionPlacer.showAfterMs : CaptionPlacer.hideAfterMs)
      if let soonest = nextDeadline, !(due < soonest) { continue }
      nextDeadline = due
    }
    return (captions, nextDeadline)
  }

  private mutating func placeRanks(
    _ spatialGrid: SpatialGrid, _ camera: Frame, _ viewport: Viewport, _ now: Double, _ limit: CaptionRank, _ captions: inout [Caption]
  ) {
    // The chrome, disc rims, nearby ribbons and captions placed so far.
    var grid = CollisionGrid()
    let area = Box(left: insets.left, top: insets.top, right: viewport.width - insets.right, bottom: viewport.height - insets.bottom)
    for block in blocks { grid.insert(blockRect(block, viewport), .name) }
    let candidates = stage(spatialGrid, camera, viewport, limit, &grid, area)

    for candidate in candidates {
      if captions.count >= CaptionPlacer.pool { break }
      let record = records[candidate.id]
      let boxWidth = candidate.metric.width + Theme.Caption.padPx * 2
      let boxHeight = candidate.metric.height

      if candidate.eligible, let anchor = seatFor(candidate, boxWidth, boxHeight, grid, area, record?.anchor) {
        let phase = placedPhase(record, now, candidate.forced)
        let since = record.map { $0.phase == phase ? $0.since : now } ?? now
        records[candidate.id] = Record(phase: phase, since: since, anchor: anchor, pass: pass)
        let box = anchorRect(candidate, boxWidth, boxHeight, anchor)
        grid.insert(box, .name)
        captions.append(
          Caption(
            id: candidate.id, anchor: anchor, left: box.left, top: box.top, width: boxWidth, height: boxHeight,
            lines: candidate.metric.lines, shown: phase != .pending))
        continue
      }

      // Lost its seat. A caption on screen holds it, and keeps lower ranks off it, until the hide deadline.
      guard var held = record, held.phase != .pending else { continue }
      if held.phase == .shown {
        held.phase = .leaving
        held.since = now
      }
      if now - held.since >= CaptionPlacer.hideAfterMs { continue }
      held.pass = pass
      records[candidate.id] = held
      let box = anchorRect(candidate, boxWidth, boxHeight, held.anchor)
      grid.insert(box, .name)
      captions.append(
        Caption(
          id: candidate.id, anchor: held.anchor, left: box.left, top: box.top, width: boxWidth, height: boxHeight,
          lines: candidate.metric.lines, shown: true))
    }
  }

  // Every step near the viewport is a disc obstacle. A candidate is a step this zoom's rank limit names, or one still
  // on screen; the selected, the hovered and a crown below the working view are forced. Candidates are sorted, then cut.
  private func stage(
    _ spatialGrid: SpatialGrid, _ camera: Frame, _ viewport: Viewport, _ limit: CaptionRank, _ grid: inout CollisionGrid, _ area: Box
  ) -> [Candidate] {
    let reach = reachPx / camera.zoom
    let halfWidth = viewport.width / 2 / camera.zoom
    let halfHeight = viewport.height / 2 / camera.zoom
    let near = spatialGrid.within(
      camera.x - halfWidth - reach, camera.y - halfHeight - reach, camera.x + halfWidth + reach, camera.y + halfHeight + reach)
    var candidates: [Candidate] = []
    for node in near {
      let seat = nodes[node]
      let sx = (seat.x - camera.x) * camera.zoom + viewport.width / 2
      let sy = (seat.y - camera.y) * camera.zoom + viewport.height / 2
      let crown = seat.crowned
      let crownScale: Double = crown ? Theme.rootBodyScale - 1 : 0
      let selectedScale: Double = node == selected ? Theme.selectedScale - 1 : 0
      let scale = 1 + crownScale + selectedScale
      let rim = Math.max(Theme.nodeSize * rimFraction * camera.zoom * scale, (crown ? Theme.minRootBodyPx : Theme.minBodyPx) / 2)
      grid.insert(Box(left: sx - rim, top: sy - rim, right: sx + rim, bottom: sy + rim), .disc)
      guard let metric = metricByID[seat.id] else { continue }
      let rank = rankOf(node)
      let onScreen = records[seat.id].map { $0.phase != .pending } ?? false
      if rank > limit && !onScreen { continue }
      candidates.append(
        Candidate(
          id: seat.id, sx: sx, sy: sy, rim: rim, metric: metric, rank: rank,
          eligible: rank <= limit,
          landmark: crown && limit < .rest,
          forced: rank <= .hovered || (crown && limit < .rest),
          weight: rank == .anchor ? subtreeSizeOf[node] : 0,
          newcomer: !onScreen,
          distance: (seat.x - camera.x) * (seat.x - camera.x) + (seat.y - camera.y) * (seat.y - camera.y)))
    }
    if limit > .anchor { stageRibbons(camera, viewport, &grid, area) }
    candidates.sort(by: Candidate.byPriority)
    return Array(candidates.prefix(candidateLimit))
  }

  // Keep nearby curves once; a seat tests its own short crossing and stops at the first ribbon it touches. Curves outside
  // the caption area never reach a seat's collision query.
  private func stageRibbons(_ camera: Frame, _ viewport: Viewport, _ grid: inout CollisionGrid, _ area: Box) {
    for link in links {
      let from = nodes[link.from]
      let to = nodes[link.to]
      let fx = (from.x - camera.x) * camera.zoom + viewport.width / 2
      let fy = (from.y - camera.y) * camera.zoom + viewport.height / 2
      let tx = (to.x - camera.x) * camera.zoom + viewport.width / 2
      let ty = (to.y - camera.y) * camera.zoom + viewport.height / 2
      let length = Arithmetic.hypot(tx - fx, ty - fy)
      if chordRange(fx, fy, tx, ty, area, EdgeCurve.bendReach * length + ribbonHalfPx) == nil { continue }
      let control = EdgeCurve.controlPoint(fx, fy, tx, ty, link.sway)
      grid.ribbons.append(Ribbon(fx: fx, fy: fy, tx: tx, ty: ty, cx: control.x, cy: control.y, length: length))
    }
  }
}

private func anchorRect(_ candidate: Candidate, _ boxWidth: Double, _ boxHeight: Double, _ anchor: CaptionAnchor) -> Box {
  let sx = candidate.sx
  let sy = candidate.sy
  let rim = candidate.rim
  let gapPx = Theme.Caption.gapPx
  switch anchor {
  case .below: return Box(left: sx - boxWidth / 2, top: sy + rim + gapPx, right: sx + boxWidth / 2, bottom: sy + rim + gapPx + boxHeight)
  case .above: return Box(left: sx - boxWidth / 2, top: sy - rim - gapPx - boxHeight, right: sx + boxWidth / 2, bottom: sy - rim - gapPx)
  case .right: return Box(left: sx + rim + gapPx, top: sy - boxHeight / 2, right: sx + rim + gapPx + boxWidth, bottom: sy + boxHeight / 2)
  case .left: return Box(left: sx - rim - gapPx - boxWidth, top: sy - boxHeight / 2, right: sx - rim - gapPx, bottom: sy + boxHeight / 2)
  }
}

private func inside(_ box: Box, _ area: Box) -> Bool {
  box.left >= area.left && box.right <= area.right && box.top >= area.top && box.bottom <= area.bottom
}

// A corner-anchored chrome box against the live viewport.
private func blockRect(_ block: Block, _ viewport: Viewport) -> Box {
  let left: Double
  switch block.horizontal {
  case .left(let inset): left = inset
  case .right(let inset): left = viewport.width - inset - block.width
  }
  let top: Double
  switch block.vertical {
  case .top(let inset): top = inset
  case .bottom(let inset): top = viewport.height - inset - block.height
  }
  return Box(left: left, top: top, right: left + block.width, bottom: top + block.height)
}

// The stretch of a straight run from (fx, fy) to (tx, ty) that lies inside `area` grown by `margin`, as a [0, 1]
// parameter range; nil when none of it does.
private func chordRange(_ fx: Double, _ fy: Double, _ tx: Double, _ ty: Double, _ area: Box, _ margin: Double) -> (lo: Double, hi: Double)? {
  var lo: Double = 0
  var hi: Double = 1
  let axes: [(delta: Double, near: Double, far: Double)] = [
    (tx - fx, area.left - margin - fx, area.right + margin - fx),
    (ty - fy, area.top - margin - fy, area.bottom + margin - fy),
  ]
  for (delta, near, far) in axes {
    if delta.magnitude < 1e-9 {
      if near > 0 || far < 0 { return nil }
      continue
    }
    lo = Math.max(lo, Math.min(near / delta, far / delta))
    hi = Math.min(hi, Math.max(near / delta, far / delta))
  }
  return lo <= hi ? (lo, hi) : nil
}

// The seat a caption takes: one clear of everything; else one that only crosses a branch, since a name on a ribbon beats
// a step with no name; else, when it is forced, one that covers the dots and threads too. The selected and the hovered
// are never dropped: boxed in by other names they sit under one. A landmark that would have to goes unnamed instead.
private func seatFor(
  _ candidate: Candidate, _ boxWidth: Double, _ boxHeight: Double, _ grid: CollisionGrid, _ area: Box, _ lastAnchor: CaptionAnchor?
) -> CaptionAnchor? {
  if let clear = freeAnchor(candidate, boxWidth, boxHeight, grid, .ribbon, area, lastAnchor) { return clear }
  if let acrossARibbon = freeAnchor(candidate, boxWidth, boxHeight, grid, .disc, area, lastAnchor) { return acrossARibbon }
  if !candidate.forced { return nil }
  if let overTheDots = freeAnchor(candidate, boxWidth, boxHeight, grid, .name, area, lastAnchor) { return overTheDots }
  if candidate.landmark { return nil }
  return lastAnchor ?? .below
}

// The last seat first, so a caption stays put across small camera moves; then below, above, right, left.
private func freeAnchor(
  _ candidate: Candidate, _ boxWidth: Double, _ boxHeight: Double, _ grid: CollisionGrid, _ upTo: Obstacle, _ area: Box,
  _ lastAnchor: CaptionAnchor?
) -> CaptionAnchor? {
  if let lastAnchor, seatIsFree(anchorRect(candidate, boxWidth, boxHeight, lastAnchor), grid, upTo, area) { return lastAnchor }
  for anchor in CaptionAnchor.allCases where anchor != lastAnchor {
    if seatIsFree(anchorRect(candidate, boxWidth, boxHeight, anchor), grid, upTo, area) { return anchor }
  }
  return nil
}

private func seatIsFree(_ box: Box, _ grid: CollisionGrid, _ upTo: Obstacle, _ area: Box) -> Bool {
  inside(box, area) && !grid.collides(box, upTo)
}

// A forced caption (selected, hovered, a crown at an overview zoom) shows at once; any other waits `showAfterMs` of
// unbroken placement.
private func placedPhase(_ record: Record?, _ now: Double, _ forced: Bool) -> Record.Phase {
  if forced { return .shown }
  guard let record else { return .pending }
  if record.phase == .pending { return now - record.since >= CaptionPlacer.showAfterMs ? .shown : .pending }
  return .shown
}
