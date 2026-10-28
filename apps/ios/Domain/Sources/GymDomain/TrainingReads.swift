import DomainKit
import SyncAPI
import SyncCore

public enum GymVolume {
  public static func total(_ parts: [VolumePart]) -> Double? {
    var total = 0.0
    for part in parts.sorted(by: { $0.id.utf8.lexicographicallyPrecedes($1.id.utf8) }) {
      guard let kg = part.kg else { return nil }
      total += kg
      guard total.isFinite else { return nil }
    }
    return total
  }

  public static func of(_ sets: [TrainingSet], catalogue: Catalogue) -> Double? {
    total(sets.map { VolumePart(id: $0.id.json.jcsText, weightKg: $0.weightKg, reps: $0.reps,
                               loadCount: catalogue.find($0.exerciseId)?.loadCount) })
  }
}

public struct EstimateScore: Comparable, Sendable {
  public static let zero = EstimateScore()
  let digits: [UInt8]
  let exponent: Int

  init() { digits = [48]; exponent = 0 }

  public init(weightKg: Double, reps: Int) {
    precondition(weightKg.isFinite && weightKg >= 0 && (1...10).contains(reps))
    let value = Quantum(0.01)!.rounded(weightKg)
    if value == 0 { self = .zero; return }
    let parts = JSON.Number(value)!.description.split(separator: "e")
    let mantissa = parts[0].split(separator: ".")
    var power = (parts.count == 2 ? Int(parts[1])! : 0) + 2 - (mantissa.count == 2 ? mantissa[1].count : 0)
    var product = Array(mantissa.joined().utf8)
    while product.first == 48 { product.removeFirst() }
    var carry = 0
    let factor = reps == 1 ? 30 : 30 + reps
    for index in product.indices.reversed() {
      let number = Int(product[index] - 48) * factor + carry
      product[index] = UInt8(48 + number % 10)
      carry = number / 10
    }
    if carry > 0 { product = Array(String(carry).utf8) + product }
    while product.last == 48 { product.removeLast(); power += 1 }
    digits = product
    exponent = power
  }

  public static func < (left: Self, right: Self) -> Bool {
    if left.digits == [48] || right.digits == [48] { return left.digits == [48] && right.digits != [48] }
    let length = left.digits.count + left.exponent
    let rightLength = right.digits.count + right.exponent
    if length != rightLength { return length < rightLength }
    for index in 0..<max(left.digits.count, right.digits.count) {
      let a = index < left.digits.count ? left.digits[index] : 48
      let b = index < right.digits.count ? right.digits[index] : 48
      if a != b { return a < b }
    }
    return false
  }
}

public enum GymEstimate {
  static func qualifies(weightKg: Double, reps: Int, rpe: Double?) -> Bool {
    weightKg.isFinite && weightKg > 0 && (1...10).contains(reps) && (rpe.map { $0.isFinite && $0 >= 7 } ?? true)
  }

  public static func value(weightKg: Double, reps: Int, rpe: Double? = nil) -> Double? {
    guard qualifies(weightKg: weightKg, reps: reps, rpe: rpe) else { return nil }
    let value = reps == 1 ? weightKg : weightKg * (1 + Double(reps) / 30)
    return value.isFinite ? value : nil
  }

  public static func score(weightKg: Double, reps: Int, rpe: Double? = nil) -> EstimateScore? {
    guard qualifies(weightKg: weightKg, reps: reps, rpe: rpe) else { return nil }
    return EstimateScore(weightKg: weightKg, reps: reps)
  }

  public static func stated(_ e1rm: Double) -> Double { Quantum(0.1)!.rounded(e1rm) }

  public static func top(_ sets: [TrainingSet]) -> Double? {
    let eligible = sets.filter { qualifies(weightKg: $0.weightKg, reps: $0.reps, rpe: $0.rpe) }
    guard eligible.allSatisfy({ $0.e1rm != nil }) else { return nil }
    return eligible.compactMap(\.e1rm).max()
  }
}

public struct SessionReadout: Equatable, Sendable {
  public let sessionId: ID<Session>
  public let name: String?
  public let durationMs: Int64?
  public let workingSetCount: Int
  public let movementCount: Int
  public let volumeKg: Double?
  public let topE1rm: Double?

  public init(session: Session, sets: [TrainingSet], catalogue: Catalogue) {
    let sets = sets.filter { $0.sessionId == session.id }
    sessionId = session.id
    name = session.name
    durationMs = session.finishedAt.map { max(0, $0.ms - session.startedAt.ms) }
    workingSetCount = sets.count
    movementCount = Set(sets.map(\.exerciseId)).count
    volumeKg = GymVolume.of(sets, catalogue: catalogue)
    topE1rm = GymEstimate.top(sets)
  }
}

public struct LastTime: Equatable, Sendable {
  public let exerciseId: ID<Exercise>
  public let session: Session?
  public let sets: [TrainingSet]
  public let isComplete: Bool
  public var routine: String? { session?.name }
  public var isFirstTime: Bool { isComplete && session == nil }

  public init(exerciseId: ID<Exercise>, session: Session? = nil, sets: [TrainingSet] = [], isComplete: Bool = true) {
    self.exerciseId = exerciseId
    self.session = session
    self.sets = sets
    self.isComplete = isComplete
  }

  public static func of(_ exerciseId: ID<Exercise>, log: TrainingLog) -> LastTime {
    for session in log.drawnSessions where !session.isOpen {
      let sets = log.sets(session: session.id).filter { $0.exerciseId == exerciseId }
      if !sets.isEmpty { return LastTime(exerciseId: exerciseId, session: session, sets: sets, isComplete: log.firstPullComplete) }
    }
    return LastTime(exerciseId: exerciseId, isComplete: log.firstPullComplete)
  }
}

public struct Prefill: Equatable, Sendable {
  public static let emptyBarKg = 20.0
  public static let emptyBarReps = 5
  public let weightKg: Double
  public let reps: Int

  public init(weightKg: Double = emptyBarKg, reps: Int = emptyBarReps) {
    self.weightKg = weightKg
    self.reps = max(1, reps)
  }

  public static func of(todaySets: [TrainingSet], planEntry: PlannedExercise?, lastTime: LastTime?) -> Prefill {
    let scheme = planEntry?.sets ?? []
    let sticky = todaySets.last
    let history = lastTime?.sets ?? []
    let straight = scheme.first.map { first in scheme.allSatisfy { $0 == first } } ?? true
    if !scheme.isEmpty && !straight {
      let slot = todaySets.count < scheme.count ? scheme[todaySets.count] : nil
      let lastNth = todaySets.count < history.count ? history[todaySets.count] : nil
      return Prefill(weightKg: slot?.weightKg ?? lastNth?.weightKg ?? sticky?.weightKg ?? emptyBarKg,
                     reps: slot?.reps ?? lastNth?.reps ?? sticky?.reps ?? emptyBarReps)
    }
    if let sticky { return Prefill(weightKg: sticky.weightKg, reps: sticky.reps) }
    let planned = scheme.first
    return Prefill(weightKg: planned?.weightKg ?? history.last?.weightKg ?? emptyBarKg,
                   reps: planned?.reps ?? history.first?.reps ?? emptyBarReps)
  }
}

public struct PerformedFact: Equatable, Sendable {
  public let setId: ID<TrainingSet>
  public let weightKg: Double
  public let reps: Int
  public let rpe: Double?

  public init(_ set: TrainingSet) { setId = set.id; weightKg = set.weightKg; reps = set.reps; rpe = set.rpe }
  public var json: JSON { .object(omittingNil: ["setId": setId.json, "weightKg": .of(weightKg), "reps": JSON(reps), "rpe": rpe.map { .of($0) }]) }
}

public struct EstimatedFact: Equatable, Sendable {
  public let performed: PerformedFact
  public let e1rm: Double?
  public var setId: ID<TrainingSet> { performed.setId }
  public var weightKg: Double { performed.weightKg }
  public var reps: Int { performed.reps }
  public var rpe: Double? { performed.rpe }
  public var score: EstimateScore { GymEstimate.score(weightKg: weightKg, reps: reps, rpe: rpe) ?? .zero }

  public init(_ set: TrainingSet, e1rm: Double?) { performed = PerformedFact(set); self.e1rm = e1rm }
  public var json: JSON {
    .object(omittingNil: ["setId": setId.json, "weightKg": .of(weightKg), "reps": JSON(reps), "rpe": rpe.map { .of($0) }, "e1rm": .of(e1rm)])
  }
}

public struct MovementSessionFact: Equatable, Sendable {
  public let exerciseId: ID<Exercise>
  public let workingSetCount: Int
  public let heaviest: PerformedFact
  public let mostReps: PerformedFact
  public let estimate: EstimatedFact?
  public let bodyweightReps: PerformedFact?
  public var estimatesComplete: Bool = true
  public var json: JSON {
    .object(omittingNil: ["exerciseId": exerciseId.json, "workingSetCount": JSON(workingSetCount), "heaviest": heaviest.json, "estimate": estimate?.json,
                         "estimatesComplete": estimatesComplete ? nil : .bool(false)])
  }
}

public struct ProgressSession: Equatable, Sendable {
  public let sessionId: ID<Session>
  public let startedAt: Instant
  public let movements: [MovementSessionFact]
  public var json: JSON { ["sessionId": sessionId.json, "startedAt": JSON(startedAt.ms), "movements": .array(movements.map(\.json))] }
}

public struct StatsProgress: Equatable, Sendable {
  public let asOf: Instant
  public let sessions: [ProgressSession]
  public let isComplete: Bool

  public init(log: TrainingLog, asOf: Instant? = nil) {
    self.asOf = asOf ?? log.moment.now
    isComplete = log.firstPullComplete
    var sessions: [ProgressSession] = []
    for session in log.drawnSessions where !session.isOpen {
      let groups = Dictionary(grouping: log.sets(session: session.id), by: \.exerciseId)
      var movements: [MovementSessionFact] = []
      for exerciseId in groups.keys.sorted() {
        let sets = groups[exerciseId] ?? []
        guard let heaviest = sets.sorted(by: { a, b in
          if a.weightKg != b.weightKg { return a.weightKg > b.weightKg }
          return a.reps == b.reps ? a.id < b.id : a.reps > b.reps
        }).first, let mostReps = sets.sorted(by: { a, b in
          if a.reps != b.reps { return a.reps > b.reps }
          return a.weightKg == b.weightKg ? a.id < b.id : a.weightKg > b.weightKg
        }).first else { continue }
        let estimates = sets.filter { GymEstimate.qualifies(weightKg: $0.weightKg, reps: $0.reps, rpe: $0.rpe) }
          .map { EstimatedFact($0, e1rm: $0.e1rm) }
        let estimate = estimates.sorted { $0.score == $1.score ? $0.setId < $1.setId : $0.score > $1.score }.first
        let bodyweightReps = sets.filter { $0.weightKg == 0 }.sorted { $0.reps == $1.reps ? $0.id < $1.id : $0.reps > $1.reps }.first
        movements.append(MovementSessionFact(exerciseId: exerciseId, workingSetCount: sets.count,
                                             heaviest: PerformedFact(heaviest), mostReps: PerformedFact(mostReps), estimate: estimate,
                                             bodyweightReps: bodyweightReps.map(PerformedFact.init),
                                             estimatesComplete: estimates.allSatisfy { $0.e1rm != nil }))
      }
      if !movements.isEmpty { sessions.append(ProgressSession(sessionId: session.id, startedAt: session.startedAt, movements: movements)) }
    }
    self.sessions = sessions.sorted { $0.startedAt == $1.startedAt ? $0.sessionId < $1.sessionId : $0.startedAt < $1.startedAt }
  }

  public var json: JSON { ["asOf": JSON(asOf.ms), "sessions": .array(sessions.map(\.json))] }

  public func movement(_ exerciseId: ID<Exercise>) -> MovementProgress {
    MovementProgress(exerciseId: exerciseId, isComplete: isComplete, sessions: sessions.compactMap { session in
      session.movements.first { $0.exerciseId == exerciseId }.map { MovementProgress.Point(id: session.sessionId, startedAt: session.startedAt, fact: $0) }
    })
  }

  public func consistency(now: Instant, zone: any Zone) -> Int? {
    guard isComplete else { return nil }
    let today = LocalDay(now, in: zone)
    let monday = today.adding(days: 1 - today.weekday)
    let weeks = Set(sessions.map { session in
      let day = LocalDay(session.startedAt, in: zone)
      return day.adding(days: 1 - day.weekday)
    })
    guard weeks.count >= 2 else { return nil }
    let count = (0..<4).filter { weeks.contains(monday.adding(days: -7 * $0)) }.count
    return count == 0 ? nil : count
  }
}

public struct MovementProgress: Equatable, Sendable {
  public static let gapDays = 21
  public struct Point: Equatable, Sendable {
    public let id: ID<Session>
    public let startedAt: Instant
    public let fact: MovementSessionFact
  }

  public struct Gap: Equatable, Sendable {
    public let before: Point
    public let after: Point
  }

  public let exerciseId: ID<Exercise>
  public let sessions: [Point]
  public let isComplete: Bool

  public init(exerciseId: ID<Exercise>, isComplete: Bool = true, sessions: [Point]) {
    self.exerciseId = exerciseId
    self.isComplete = isComplete
    self.sessions = sessions.sorted { $0.startedAt == $1.startedAt ? $0.id < $1.id : $0.startedAt < $1.startedAt }
  }

  public var estimatesComplete: Bool { sessions.allSatisfy { $0.fact.estimatesComplete } }
  public var estimates: [Point] { estimatesComplete ? sessions.filter { $0.fact.estimate?.e1rm != nil } : [] }
  public var latest: Point? { estimates.last }
  public var best: Point? {
    guard isComplete && estimatesComplete else { return nil }
    return estimates.sorted { a, b in
      let left = a.fact.estimate!.score, right = b.fact.estimate!.score
      if left != right { return left > right }
      return a.startedAt == b.startedAt ? a.id < b.id : a.startedAt < b.startedAt
    }.first
  }
  public var heaviest: Point? {
    guard isComplete else { return nil }
    return sessions.sorted { a, b in
      if a.fact.heaviest.weightKg != b.fact.heaviest.weightKg { return a.fact.heaviest.weightKg > b.fact.heaviest.weightKg }
      if a.fact.heaviest.reps != b.fact.heaviest.reps { return a.fact.heaviest.reps > b.fact.heaviest.reps }
      return a.startedAt == b.startedAt ? a.id < b.id : a.startedAt < b.startedAt
    }.first
  }
  public var mostReps: Point? {
    guard isComplete else { return nil }
    return sessions.sorted { a, b in
      if a.fact.mostReps.reps != b.fact.mostReps.reps { return a.fact.mostReps.reps > b.fact.mostReps.reps }
      if a.fact.mostReps.weightKg != b.fact.mostReps.weightKg { return a.fact.mostReps.weightKg > b.fact.mostReps.weightKg }
      return a.startedAt == b.startedAt ? a.id < b.id : a.startedAt < b.startedAt
    }.first
  }
  public var bodyweightReps: Point? {
    guard isComplete else { return nil }
    return sessions.filter { $0.fact.bodyweightReps != nil }.sorted { a, b in
      let left = a.fact.bodyweightReps!.reps, right = b.fact.bodyweightReps!.reps
      if left != right { return left > right }
      return a.startedAt == b.startedAt ? a.id < b.id : a.startedAt < b.startedAt
    }.first
  }
  public var records: [Point] {
    guard isComplete && estimatesComplete else { return [] }
    var records: [Point] = []
    for point in estimates where records.isEmpty || GymEstimate.stated(point.fact.estimate!.e1rm!) >
      GymEstimate.stated(records.last!.fact.estimate!.e1rm!) { records.append(point) }
    return records
  }

  public func window(now: Instant, zone: any Zone) -> MovementProgress {
    let start = LocalDay(now, in: zone).adding(days: -84)
    return MovementProgress(exerciseId: exerciseId, isComplete: isComplete, sessions: sessions.filter { $0.startedAt <= now && LocalDay($0.startedAt, in: zone) >= start })
  }

  public func hasChart(in zone: any Zone) -> Bool {
    guard isComplete && estimatesComplete else { return false }
    let points = estimates
    guard points.count >= 4, let first = points.first, let last = points.last else { return false }
    return LocalDay(first.startedAt, in: zone).days(until: LocalDay(last.startedAt, in: zone)) >= 21
  }

  public func gaps(in zone: any Zone) -> [Gap] {
    let points = estimates
    return zip(points, points.dropFirst()).compactMap { before, after in
      LocalDay(before.startedAt, in: zone).days(until: LocalDay(after.startedAt, in: zone)) > Self.gapDays ? Gap(before: before, after: after) : nil
    }
  }
}

// The log's new bests: a movement's first estimate is its baseline; a new best beats the best before it as stated.
public struct ProgressRecords: Equatable, Sendable {
  public struct Record: Equatable, Sendable {
    public let point: MovementProgress.Point
    public let previous: MovementProgress.Point
    public let estimate: Double
    public let gain: Double
  }
  public let progress: StatsProgress
  public let movements: [ID<Exercise>: [Record]]
  public let sessions: Set<ID<Session>>

  public init(_ progress: StatsProgress) {
    self.progress = progress
    var series: [ID<Exercise>: [(point: MovementProgress.Point, estimate: Double)]] = [:]
    for session in progress.sessions where progress.isComplete {
      for fact in session.movements {
        guard progress.movement(fact.exerciseId).estimatesComplete,
              let estimate = fact.estimate?.e1rm else { continue }
        let point = MovementProgress.Point(id: session.sessionId, startedAt: session.startedAt, fact: fact)
        series[fact.exerciseId, default: []].append((point, GymEstimate.stated(estimate)))
      }
    }
    var movements: [ID<Exercise>: [Record]] = [:]
    for (id, estimates) in series {
      guard var best = estimates.first else { continue }
      var run: [Record] = []
      for next in estimates.dropFirst() {
        let gain = GymEstimate.stated(next.estimate - best.estimate)
        guard gain > 0 else { continue }
        run.append(Record(point: next.point, previous: best.point, estimate: next.estimate, gain: gain))
        best = next
      }
      if !run.isEmpty { movements[id] = run }
    }
    self.movements = movements
    sessions = Set(movements.values.flatMap { $0.map(\.point.id) })
  }
}

extension TrainingLog {
  public func readout(session id: ID<Session>) -> SessionReadout? {
    drawnSessions.first { $0.id == id }.map { SessionReadout(session: $0, sets: sets(session: id), catalogue: catalogue) }
  }
  public func lastTime(for exerciseId: ID<Exercise>) -> LastTime { LastTime.of(exerciseId, log: self) }
  public var progress: StatsProgress { StatsProgress(log: self) }
}

public enum Readout {
  public static let noRoutine = "Free workout"
  public static let openTarget = "open"
  static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

  public static func weight(_ kg: Double, units: GymUnits = .kg) -> String {
    let value = WeightLadder.round(units.display(kg))
    guard let number = JSON.Number(value) else { return "—" }
    return String(number.description.map { $0 == "-" ? "−" : $0 })
  }

  public static func effort(weightKg: Double, reps: Int, units: GymUnits = .kg) -> String { "\(weight(weightKg, units: units)) × \(reps)" }
  public static func estimatedWeight(_ e1rm: Double, units: GymUnits = .kg) -> String {
    weight(GymEstimate.stated(units == .lb ? e1rm / GymUnits.kilogramsPerPound : e1rm))
  }
  public static func estimate(_ e1rm: Double, units: GymUnits = .kg) -> String { "e1RM \(estimatedWeight(e1rm, units: units))" }
  public static func repTarget(_ reps: Int?) -> String { reps.map(String.init) ?? "max" }
  public static func setTarget(_ set: SetTarget) -> String { "\(set.weightKg.map { weight($0) } ?? "last") × \(repTarget(set.reps))" }
  public static func ladder(_ sets: [SetTarget]) -> String { sets.map(setTarget).joined(separator: " · ") }

  public static func target(_ sets: [SetTarget]?) -> String {
    guard let sets, !sets.isEmpty else { return openTarget }
    let reps = sets.compactMap(\.reps)
    let loads = sets.compactMap(\.weightKg).map(WeightLadder.round)
    let repColumn: String
    if let low = reps.min(), let high = reps.max() {
      repColumn = reps.count < sets.count ? "\(low)–max" : low == high ? String(low) : "\(low)–\(high)"
    } else { repColumn = "max" }
    var loadColumn = ""
    if let low = loads.min(), let high = loads.max() {
      let load = loads.count < sets.count ? "\(weight(low))–last" : low == high ? weight(low) : "\(weight(low))–\(weight(high))"
      loadColumn = " · \(load)"
    }
    return "\(sets.count) × \(repColumn)\(loadColumn)"
  }

  public static func loadUnit(equipment: String?, loadCount: Int) -> String {
    switch equipment {
    case "dumbbell": return loadCount == 2 ? "kg each" : "kg"
    case "barbell", "machine": return "kg total"
    case "bodyweight": return "kg added"
    default: return "kg"
    }
  }

  public static func tonnes(_ kg: Double) -> String? {
    guard kg.isFinite, kg > 0 else { return nil }
    let tonnes = Quantum(0.1)!.rounded(kg / 1000)
    guard tonnes > 0 else { return nil }
    let digits = JSON.Number(tonnes)!.description
    return "\(digits.contains(".") || digits.contains("e") ? digits : digits + ".0") t"
  }

  public static func duration(_ milliseconds: Int64) -> String {
    let minutes = max(1, milliseconds / 60_000)
    return minutes < 60 ? "\(minutes)m" : "\(minutes / 60)h \(minutes % 60 < 10 ? "0" : "")\(minutes % 60)m"
  }

  public static func briefDay(_ instant: Instant, now: Instant, zone: any Zone) -> String {
    let day = LocalDay(instant, in: zone)
    let today = LocalDay(now, in: zone)
    if day == today { return "today" }
    let date = "\(day.day) \(months[day.month - 1])"
    return day.year == today.year ? date : "\(date) \(day.year)"
  }

  public static func ago(_ instant: Instant, now: Instant, zone: any Zone) -> String {
    ago(days: LocalDay(instant, in: zone).days(until: LocalDay(now, in: zone)))
  }

  public static func ago(days: Int) -> String {
    if days <= 0 { return "today" }
    return days == 1 ? "yesterday" : "\(days) days ago"
  }
}
