import SyncCore

// §2.5 the engine's sliced steps, a pull page's chunks, its settling slices and a push answer's result batches, and their sizes.

// How the engine sizes its sliced steps: each by how long the last of its kind held the writer, or every one alike.
public enum WriterSlicing: Sendable, Hashable {
  case measured
  case fixed(Sizes)

  // A chunk's rows, a settling slice's entries and a batch's results, one at least; measured sizes start at the defaults.
  public struct Sizes: Sendable, Hashable {
    public let chunkRows: Int
    public let settleEntries: Int
    public let resultsPerBatch: Int

    public init(chunkRows: Int = 64, settleEntries: Int = 32, resultsPerBatch: Int = 16) {
      self.chunkRows = max(1, chunkRows)
      self.settleEntries = max(1, settleEntries)
      self.resultsPerBatch = max(1, resultsPerBatch)
    }
  }
}

// A chunk is sized per scope, whose types set a row's cost; a settling slice and a batch per kind, an entry costing what its deltas do.
public enum SlicedStep: Sendable, Hashable {
  case chunk(ScopeRef)
  case settle
  case results
}

// Measured, a step that took `t` of `s` offered and held the writer `h` sizes the next t × aim ÷ h: at most 2s, below s only past the aim.
public struct WriterSlices: Sendable {
  // Half of WRITER_SLICE_MS, so a step that held within the aim and then doubles still holds within the budget.
  static let aim = Duration.milliseconds(Constants.writerSliceMs / 2)
  // Far above what one aim holds on any device: it only stops steps too quick for the clock to see from growing without end.
  static let ceiling = 4_096

  let isMeasured: Bool
  let start: WriterSlicing.Sizes
  var chunkRows: [ScopeRef: Int] = [:]
  var settleEntries: Int
  var resultsPerBatch: Int

  public init(_ slicing: WriterSlicing) {
    switch slicing {
    case .measured:
      isMeasured = true
      start = WriterSlicing.Sizes()
    case .fixed(let sizes):
      isMeasured = false
      start = sizes
    }
    settleEntries = start.settleEntries
    resultsPerBatch = start.resultsPerBatch
  }

  public func size(_ step: SlicedStep) -> Int {
    switch step {
    case .chunk(let scope): chunkRows[scope] ?? start.chunkRows
    case .settle: settleEntries
    case .results: resultsPerBatch
    }
  }

  // A step took `taken` rows or entries and held the writer `held`: measured, the next of its kind is sized by it.
  public mutating func record(_ step: SlicedStep, took taken: Int, held: Duration) {
    guard isMeasured else { return }
    let next = Self.next(offered: size(step), took: taken, held: held)
    switch step {
    case .chunk(let scope): chunkRows[scope] = next
    case .settle: settleEntries = next
    case .results: resultsPerBatch = next
    }
  }

  // A step that took nothing says nothing of the rate, and a hold too short for the clock to see doubles the size.
  static func next(offered size: Int, took taken: Int, held: Duration) -> Int {
    guard taken > 0 else { return size }
    let upper = min(2 * size, ceiling)
    guard held > .zero else { return upper }
    let fits = Double(taken) * (aim / held)
    let fitting = fits < Double(upper) ? Int(fits) : upper
    return held > aim ? max(1, fitting) : max(size, fitting)
  }
}
