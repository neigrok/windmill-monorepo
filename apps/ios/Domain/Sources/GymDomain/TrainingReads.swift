import DomainKit
import SyncAPI
import SyncCore

public enum GymEstimate {
  public static func value(weightKg: Double, reps: Int, kind: String = "working", rpe: Double? = nil) -> Double? {
    guard kind == "working", weightKg.isFinite, weightKg > 0, (1...10).contains(reps),
          rpe.map({ $0.isFinite && $0 >= 7 }) ?? true else { return nil }
    return reps == 1 ? weightKg : weightKg * (1 + Double(reps) / 30)
  }
}

public struct SessionReadout: Equatable, Sendable {
  public let sessionId: ID<Session>
  public let name: String?
  public let durationMs: Int64?
  public let workingSetCount: Int
  public let movementCount: Int
  public let volumeKg: Double
  public let topE1rm: Double?

  public init(session: Session, sets: [TrainingSet]) {
    let sets = sets.filter { $0.sessionId == session.id }
    let working = sets.filter { $0.kind == "working" }
    sessionId = session.id
    name = session.name
    durationMs = session.finishedAt.map { max(0, $0.ms - session.startedAt.ms) }
    workingSetCount = working.count
    movementCount = Set(sets.map(\.exerciseId)).count
    volumeKg = working.reduce(0) { $0 + $1.volumeKg }
    topE1rm = working.compactMap(\.e1rm).max()
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
      let sets = log.sets(session: session.id).filter { $0.exerciseId == exerciseId && $0.kind != "warmup" }
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
    let working = todaySets.filter { $0.kind == "working" }
    let sticky = working.last
    let history = lastTime?.sets ?? []
    let straight = scheme.first.map { first in scheme.allSatisfy { $0 == first } } ?? true
    if !scheme.isEmpty && !straight {
      let slot = working.count < scheme.count ? scheme[working.count] : nil
      let pastWorking = history.filter { $0.kind == "working" }
      let lastNth = working.count < pastWorking.count ? pastWorking[working.count] : nil
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
  public let e1rm: Double
  public var setId: ID<TrainingSet> { performed.setId }
  public var weightKg: Double { performed.weightKg }
  public var reps: Int { performed.reps }
  public var rpe: Double? { performed.rpe }

  public init(_ set: TrainingSet, e1rm: Double) { performed = PerformedFact(set); self.e1rm = e1rm }
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
  public var json: JSON {
    .object(omittingNil: ["exerciseId": exerciseId.json, "workingSetCount": JSON(workingSetCount), "heaviest": heaviest.json, "estimate": estimate?.json])
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
      let groups = Dictionary(grouping: log.sets(session: session.id).filter { $0.kind == "working" }, by: \.exerciseId)
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
        let estimates = sets.compactMap { set in set.e1rm.map { EstimatedFact(set, e1rm: $0) } }
        let estimate = estimates.sorted { $0.e1rm == $1.e1rm ? $0.setId < $1.setId : $0.e1rm > $1.e1rm }.first
        movements.append(MovementSessionFact(exerciseId: exerciseId, workingSetCount: sets.count,
                                             heaviest: PerformedFact(heaviest), mostReps: PerformedFact(mostReps), estimate: estimate))
      }
      if !movements.isEmpty { sessions.append(ProgressSession(sessionId: session.id, startedAt: session.startedAt, movements: movements)) }
    }
    self.sessions = sessions.sorted { $0.startedAt == $1.startedAt ? $0.sessionId < $1.sessionId : $0.startedAt < $1.startedAt }
  }

  public init(_ read: Reader) throws { self.init(log: try TrainingLog(read)) }

  public var json: JSON { ["asOf": JSON(asOf.ms), "sessions": .array(sessions.map(\.json))] }

  public func movement(_ exerciseId: ID<Exercise>) -> MovementProgress {
    MovementProgress(exerciseId: exerciseId, isComplete: isComplete, sessions: sessions.compactMap { session in
      session.movements.first { $0.exerciseId == exerciseId }.map { MovementProgress.Point(id: session.sessionId, startedAt: session.startedAt, fact: $0) }
    })
  }

  public func sessionEstimate(_ id: ID<Session>) -> Double? {
    sessions.first { $0.sessionId == id }?.movements.compactMap { $0.estimate?.e1rm }.max()
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

  public var estimates: [Point] { sessions.filter { $0.fact.estimate != nil } }
  public var latest: Point? { estimates.last }
  public var best: Point? {
    guard isComplete else { return nil }
    return estimates.sorted { a, b in
      let left = a.fact.estimate!.e1rm, right = b.fact.estimate!.e1rm
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
  public var records: [Point] {
    guard isComplete else { return [] }
    var records: [Point] = []
    for point in estimates where point.fact.estimate!.e1rm > (records.last?.fact.estimate?.e1rm ?? 0) { records.append(point) }
    return records
  }

  public func window(now: Instant, zone: any Zone) -> MovementProgress {
    let start = LocalDay(now, in: zone).adding(days: -84)
    return MovementProgress(exerciseId: exerciseId, isComplete: isComplete, sessions: sessions.filter { $0.startedAt <= now && LocalDay($0.startedAt, in: zone) >= start })
  }

  public func hasChart(in zone: any Zone) -> Bool {
    guard isComplete else { return false }
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

extension TrainingLog {
  public func readout(session id: ID<Session>) -> SessionReadout? {
    drawnSessions.first { $0.id == id }.map { SessionReadout(session: $0, sets: sets(session: id)) }
  }
  public func lastTime(for exerciseId: ID<Exercise>) -> LastTime { LastTime.of(exerciseId, log: self) }
  public var progress: StatsProgress { StatsProgress(log: self) }
}

public enum Readout {
  public static let noRoutine = "Free session"
  public static let openTarget = "open"
  static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

  public static func weight(_ kg: Double, units: GymUnits = .kg) -> String {
    let value = WeightLadder.round(units.display(kg))
    guard value.isFinite else { return String(value) }
    let hundredths = Int((abs(value) * 100).rounded(.toNearestOrAwayFromZero))
    let whole = String(hundredths / 100)
    let tail = hundredths % 100
    let digits = tail == 0 ? whole : tail % 10 == 0 ? "\(whole).\(tail / 10)" : "\(whole).\(tail < 10 ? "0" : "")\(tail)"
    return (value < 0 ? "−" : "") + digits
  }

  public static func effort(weightKg: Double, reps: Int, units: GymUnits = .kg) -> String { "\(weight(weightKg, units: units)) × \(reps)" }
  public static func estimatedWeight(_ e1rm: Double, units: GymUnits = .kg) -> String {
    let displayed = units == .lb ? e1rm / GymUnits.kilogramsPerPound : e1rm
    return weight(Quantum(0.1)!.rounded(displayed))
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

  public static func tonnes(_ kg: Double) -> String? {
    guard kg.isFinite, kg > 0 else { return nil }
    let tenths = Int((kg / 100).rounded(.toNearestOrAwayFromZero))
    return tenths > 0 ? "\(tenths / 10).\(tenths % 10) t" : nil
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
    let days = LocalDay(instant, in: zone).days(until: LocalDay(now, in: zone))
    if days <= 0 { return "today" }
    return days == 1 ? "yesterday" : "\(days) days ago"
  }
}
