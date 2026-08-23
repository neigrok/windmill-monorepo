import Foundation

// Instants are epoch-ms, weights are signed kg (below zero is band-assisted), an absent optional is
// omitted and never null, and every id is minted here.

public enum SetKind: String, Codable, Sendable, CaseIterable {
    case warmup, working, drop, failure

    // An unknown kind reads as `working`. Warmups are excluded from history, prefill and records.
    public init(parsing text: String) {
        self = SetKind(rawValue: text) ?? .working
    }
}

// `pattern` and `equipment` stay Strings: the backend may seed a value this build has not compiled.
public struct Exercise: Equatable, Codable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let pattern: String
    public let equipment: String
    public let stepKg: Double?
    public let custom: Bool
    // Newest first, at most five; omitted on the wire when empty.
    public let aliases: [String]

    public init(id: String, name: String, pattern: String = "", equipment: String = "",
                stepKg: Double? = nil, custom: Bool = false, aliases: [String] = []) {
        self.id = id
        self.name = name
        self.pattern = pattern
        self.equipment = equipment
        self.stepKg = stepKg
        self.custom = custom
        self.aliases = aliases
    }

    enum CodingKeys: String, CodingKey {
        case id, name, pattern, equipment, stepKg, custom, aliases
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        id = try fields.decode(String.self, forKey: .id)
        name = try fields.decodeIfPresent(String.self, forKey: .name) ?? ""
        pattern = try fields.decodeIfPresent(String.self, forKey: .pattern) ?? ""
        equipment = try fields.decodeIfPresent(String.self, forKey: .equipment) ?? ""
        stepKg = try fields.decodeIfPresent(Double.self, forKey: .stepKg)
        custom = try fields.decodeIfPresent(Bool.self, forKey: .custom) ?? false
        aliases = try fields.decodeIfPresent([String].self, forKey: .aliases) ?? []
    }

    public func answersTo(_ term: String) -> Bool {
        let wanted = term.lowercased()
        return aliases.contains { $0.lowercased().contains(wanted) }
    }
}

// Absent `weightKg` names no target, absent `reps` means max, absent `sets` is the open line, which
// carries no reps and no weight either. None of the three is ever a zero.
public struct PlanEntry: Equatable, Codable, Sendable {
    public let exerciseId: String
    public let sets: Int?
    public let reps: Int?
    public let weightKg: Double?
    public let restSeconds: Int?

    public var isOpen: Bool { sets == nil }

    public init(exerciseId: String, sets: Int? = nil, reps: Int? = nil,
                weightKg: Double? = nil, restSeconds: Int? = nil) {
        self.exerciseId = exerciseId
        self.sets = sets
        self.reps = reps
        self.weightKg = weightKg
        self.restSeconds = restSeconds
    }

    enum CodingKeys: String, CodingKey {
        case exerciseId, sets, reps, weightKg, restSeconds
    }
}

// The routine frozen at Start; `routine` is its name at that instant.
public struct PlanSnapshot: Equatable, Codable, Sendable {
    public let routine: String
    public let entries: [PlanEntry]

    public init(routine: String, entries: [PlanEntry]) {
        self.routine = routine
        self.entries = entries
    }

    public func entry(for exerciseId: String) -> PlanEntry? {
        entries.first { $0.exerciseId == exerciseId }
    }

    enum CodingKeys: String, CodingKey {
        case routine, entries
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        routine = try fields.decodeIfPresent(String.self, forKey: .routine) ?? ""
        entries = try fields.decodeIfPresent([PlanEntry].self, forKey: .entries) ?? []
    }
}

public struct Session: Equatable, Codable, Sendable, Identifiable {
    public let id: String
    public let startedAtMs: Int64
    public let finishedAtMs: Int64?
    public let routineId: String?
    public let plan: PlanSnapshot?

    public init(id: String, startedAtMs: Int64, finishedAtMs: Int64? = nil,
                routineId: String? = nil, plan: PlanSnapshot? = nil) {
        self.id = id
        self.startedAtMs = startedAtMs
        self.finishedAtMs = finishedAtMs
        self.routineId = routineId
        self.plan = plan
    }

    public var isOpen: Bool { finishedAtMs == nil }

    // An open session idle this long ended at its last set, or at its start if it has none.
    public static let autoCloseMs: Int64 = 4 * 60 * 60 * 1000

    public func autoCloseAt(lastSetAtMs: Int64?, nowMs: Int64) -> Int64? {
        guard isOpen else { return nil }
        let lastActivityMs = lastSetAtMs ?? startedAtMs
        guard nowMs >= lastActivityMs + Self.autoCloseMs else { return nil }
        return lastActivityMs
    }

    enum CodingKeys: String, CodingKey {
        case id, routineId, plan
        case startedAtMs = "startedAt"
        case finishedAtMs = "finishedAt"
    }
}

// `setNumber` is absent while the log has no row; the queue entry's `needsPush` is the authority on
// whether it is still owed. `note` is never optional on the wire, so absent is empty, not missing.
public struct TrainingSet: Equatable, Codable, Sendable, Identifiable {
    public let id: String
    public let exerciseId: String
    public let setNumber: Int?
    public let weightKg: Double
    public let reps: Int
    public let kind: SetKind
    public let rpe: Double?
    public let note: String
    public let completedAtMs: Int64

    public init(id: String, exerciseId: String, setNumber: Int? = nil, weightKg: Double, reps: Int,
                kind: SetKind = .working, rpe: Double? = nil, note: String = "", completedAtMs: Int64) {
        self.id = id
        self.exerciseId = exerciseId
        self.setNumber = setNumber
        self.weightKg = weightKg
        self.reps = reps
        self.kind = kind
        self.rpe = rpe
        self.note = note
        self.completedAtMs = completedAtMs
    }

    // A remint moves the idempotency key and nothing else.
    public func reminted(as id: String) -> TrainingSet {
        TrainingSet(id: id, exerciseId: exerciseId, setNumber: setNumber, weightKg: weightKg,
                    reps: reps, kind: kind, rpe: rpe, note: note, completedAtMs: completedAtMs)
    }

    public func corrected(by fix: SetFix) -> TrainingSet {
        TrainingSet(id: id, exerciseId: exerciseId, setNumber: setNumber, weightKg: fix.weightKg,
                    reps: fix.reps, kind: fix.kind, rpe: rpe, note: note, completedAtMs: completedAtMs)
    }

    // The instant repaired into the wire's bound, so a broken local clock cannot jam the claim.
    public var clamped: TrainingSet {
        let repaired = Instants.clamped(completedAtMs)
        guard repaired != completedAtMs else { return self }
        return TrainingSet(id: id, exerciseId: exerciseId, setNumber: setNumber, weightKg: weightKg,
                           reps: reps, kind: kind, rpe: rpe, note: note, completedAtMs: repaired)
    }

    enum CodingKeys: String, CodingKey {
        case id, exerciseId, setNumber, weightKg, reps, kind, rpe, note
        case completedAtMs = "completedAt"
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        id = try fields.decode(String.self, forKey: .id)
        exerciseId = try fields.decode(String.self, forKey: .exerciseId)
        setNumber = try fields.decodeIfPresent(Int.self, forKey: .setNumber)
        weightKg = try fields.decode(Double.self, forKey: .weightKg)
        reps = try fields.decode(Int.self, forKey: .reps)
        kind = SetKind(parsing: try fields.decodeIfPresent(String.self, forKey: .kind) ?? "working")
        rpe = try fields.decodeIfPresent(Double.self, forKey: .rpe)
        note = try fields.decodeIfPresent(String.self, forKey: .note) ?? ""
        completedAtMs = try fields.decode(Int64.self, forKey: .completedAtMs)
    }

    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: CodingKeys.self)
        try fields.encode(id, forKey: .id)
        try fields.encode(exerciseId, forKey: .exerciseId)
        try fields.encodeIfPresent(setNumber, forKey: .setNumber)
        try fields.encode(weightKg, forKey: .weightKg)
        try fields.encode(reps, forKey: .reps)
        try fields.encode(kind.rawValue, forKey: .kind)
        try fields.encodeIfPresent(rpe, forKey: .rpe)
        try fields.encode(note, forKey: .note)
        try fields.encode(completedAtMs, forKey: .completedAtMs)
    }
}

public struct SessionDetail: Equatable, Codable, Sendable {
    public let session: Session
    public let sets: [TrainingSet]

    public init(session: Session, sets: [TrainingSet]) {
        self.session = session
        self.sets = sets
    }

    enum CodingKeys: String, CodingKey {
        case session, sets
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        session = try fields.decode(Session.self, forKey: .session)
        sets = try fields.decodeIfPresent([TrainingSet].self, forKey: .sets) ?? []
    }
}

// The heaviest working set, ties going to the reps. Absent when the session holds none.
public struct TopSet: Equatable, Codable, Sendable {
    public let weightKg: Double
    public let reps: Int

    public init(weightKg: Double, reps: Int) {
        self.weightKg = weightKg
        self.reps = reps
    }

    enum CodingKeys: String, CodingKey {
        case weightKg, reps
    }
}

// The wire is flat — the session's own fields with the row's facts beside them — so the session
// decodes off the same container. `setCount` counts every kind; `workingSetCount`, `tonnageKg` and
// `topE1rm` are absent when unknown.
public struct SessionSummary: Equatable, Codable, Sendable, Identifiable {
    public let session: Session
    public let setCount: Int
    public let exercises: [String]
    public let topSet: TopSet?
    // Inferred, not stored: `finishedAt` landing exactly on the last set's instant.
    public let closedItself: Bool
    public let workingSetCount: Int?
    public let tonnageKg: Double?
    public let topE1rm: Double?
    public let record: Bool

    public init(session: Session, setCount: Int = 0, exercises: [String] = [],
                topSet: TopSet? = nil, closedItself: Bool = false,
                workingSetCount: Int? = nil, tonnageKg: Double? = nil, topE1rm: Double? = nil,
                record: Bool = false) {
        self.session = session
        self.setCount = setCount
        self.exercises = exercises
        self.topSet = topSet
        self.closedItself = closedItself
        self.workingSetCount = workingSetCount
        self.tonnageKg = tonnageKg
        self.topE1rm = topE1rm
        self.record = record
    }

    public var id: String { session.id }

    enum CodingKeys: String, CodingKey {
        case setCount, exercises, topSet, closedItself, workingSetCount, tonnageKg, topE1rm, record
    }

    public init(from decoder: Decoder) throws {
        session = try Session(from: decoder)
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        setCount = try fields.decodeIfPresent(Int.self, forKey: .setCount) ?? 0
        exercises = try fields.decodeIfPresent([String].self, forKey: .exercises) ?? []
        topSet = try fields.decodeIfPresent(TopSet.self, forKey: .topSet)
        closedItself = try fields.decodeIfPresent(Bool.self, forKey: .closedItself) ?? false
        workingSetCount = try fields.decodeIfPresent(Int.self, forKey: .workingSetCount)
        tonnageKg = try fields.decodeIfPresent(Double.self, forKey: .tonnageKg)
        topE1rm = try fields.decodeIfPresent(Double.self, forKey: .topE1rm)
        record = try fields.decodeIfPresent(Bool.self, forKey: .record) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        try session.encode(to: encoder)
        var fields = encoder.container(keyedBy: CodingKeys.self)
        try fields.encode(setCount, forKey: .setCount)
        try fields.encode(exercises, forKey: .exercises)
        try fields.encodeIfPresent(topSet, forKey: .topSet)
        try fields.encode(closedItself, forKey: .closedItself)
        try fields.encodeIfPresent(workingSetCount, forKey: .workingSetCount)
        try fields.encodeIfPresent(tonnageKg, forKey: .tonnageKg)
        try fields.encodeIfPresent(topE1rm, forKey: .topE1rm)
        try fields.encode(record, forKey: .record)
    }
}

// The newest finished session holding this movement, its non-warmup rows in order. `session == nil`
// says there is no history.
public struct LastTime: Equatable, Codable, Sendable {
    public let exerciseId: String
    public let session: Session?
    public let routine: String?
    public let sets: [TrainingSet]

    public init(exerciseId: String, session: Session? = nil, routine: String? = nil,
                sets: [TrainingSet] = []) {
        self.exerciseId = exerciseId
        self.session = session
        self.routine = routine
        self.sets = sets
    }

    public var isFirstTime: Bool { session == nil }

    enum CodingKeys: String, CodingKey {
        case exerciseId, session, routine, sets
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        exerciseId = try fields.decode(String.self, forKey: .exerciseId)
        session = try fields.decodeIfPresent(Session.self, forKey: .session)
        routine = try fields.decodeIfPresent(String.self, forKey: .routine)
        sets = try fields.decodeIfPresent([TrainingSet].self, forKey: .sets) ?? []
    }
}

// `at` is the session's start, not the set's own instant. Sparse: a movement with no line here has
// never been trained by this account.
public struct LastSet: Equatable, Codable, Sendable, Identifiable {
    public let exerciseId: String
    public let weightKg: Double
    public let reps: Int
    public let atMs: Int64

    public var id: String { exerciseId }

    public init(exerciseId: String, weightKg: Double, reps: Int, atMs: Int64) {
        self.exerciseId = exerciseId
        self.weightKg = weightKg
        self.reps = reps
        self.atMs = atMs
    }

    enum CodingKeys: String, CodingKey {
        case exerciseId, weightKg, reps
        case atMs = "at"
    }
}

// Absent `targetReps` is max. Absent `targetSets` is the open row, which carries no reps and no
// weight either; the server refuses the half-open line. Rest is still allowed on an open row.
public struct RoutineEntry: Equatable, Codable, Sendable {
    public let position: Int
    public let exerciseId: String
    public let targetSets: Int?
    public let targetReps: Int?
    public let targetWeightKg: Double?
    public let restSeconds: Int?

    public var isOpen: Bool { targetSets == nil }

    public init(position: Int, exerciseId: String, targetSets: Int? = nil, targetReps: Int? = nil,
                targetWeightKg: Double? = nil, restSeconds: Int? = nil) {
        self.position = position
        self.exerciseId = exerciseId
        self.targetSets = targetSets
        self.targetReps = targetReps
        self.targetWeightKg = targetWeightKg
        self.restSeconds = restSeconds
    }

    enum CodingKeys: String, CodingKey {
        case position, exerciseId, targetSets, targetReps, targetWeightKg, restSeconds
    }
}

// Entry order is the routine order; `position` is 1-based, dense and server-assigned. Absent
// `lastTrainedAtMs` means never trained, and the list sorts on that absence rather than on a zero.
public struct Routine: Equatable, Codable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let position: Int
    public let lastTrainedAtMs: Int64?
    public let entries: [RoutineEntry]
    // Newest first. Rides only on `GET /v1/gym/routines/{id}`; empty on every row of the list read.
    public let history: [RoutineEvent]

    public var isUntested: Bool { lastTrainedAtMs == nil }

    public init(id: String, name: String, position: Int,
                lastTrainedAtMs: Int64? = nil, entries: [RoutineEntry] = [],
                history: [RoutineEvent] = []) {
        self.id = id
        self.name = name
        self.position = position
        self.lastTrainedAtMs = lastTrainedAtMs
        self.entries = entries
        self.history = history
    }

    // Newest-trained first, then position.
    public static func byLastTrained(_ routines: [Routine]) -> [Routine] {
        routines.sorted { left, right in
            let trained = (left.lastTrainedAtMs ?? .min, right.lastTrainedAtMs ?? .min)
            guard trained.0 == trained.1 else { return trained.0 > trained.1 }
            return left.position < right.position
        }
    }

    // Addressed by position, not movement: a program may hold the same movement twice. nil is nothing
    // to write — the position is gone, names another movement, or is open.
    public func retargeting(position: Int, exerciseId: String, toWeightKg weightKg: Double) -> Routine? {
        guard let entry = entries.first(where: { $0.position == position }),
              entry.exerciseId == exerciseId, !entry.isOpen else { return nil }
        let moved = RoutineEntry(position: entry.position, exerciseId: entry.exerciseId,
                                 targetSets: entry.targetSets, targetReps: entry.targetReps,
                                 targetWeightKg: weightKg, restSeconds: entry.restSeconds)
        return Routine(id: id, name: name, position: self.position, lastTrainedAtMs: lastTrainedAtMs,
                       entries: entries.map { $0.position == position ? moved : $0 },
                       history: history)
    }

    enum CodingKeys: String, CodingKey {
        case id, name, position, entries, history
        case lastTrainedAtMs = "lastTrainedAt"
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        id = try fields.decode(String.self, forKey: .id)
        name = try fields.decodeIfPresent(String.self, forKey: .name) ?? ""
        position = try fields.decodeIfPresent(Int.self, forKey: .position) ?? 0
        lastTrainedAtMs = try fields.decodeIfPresent(Int64.self, forKey: .lastTrainedAtMs)
        entries = try fields.decodeIfPresent([RoutineEntry].self, forKey: .entries) ?? []
        history = try fields.decodeIfPresent([RoutineEvent].self, forKey: .history) ?? []
    }

    // Written out without its history.
    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: CodingKeys.self)
        try fields.encode(id, forKey: .id)
        try fields.encode(name, forKey: .name)
        try fields.encode(position, forKey: .position)
        try fields.encodeIfPresent(lastTrainedAtMs, forKey: .lastTrainedAtMs)
        try fields.encode(entries, forKey: .entries)
    }
}

// `created` is always there and always last. An absent `by` means the lifter's own hand, a named door
// means an agent. An unknown kind reads as `.unknown` and is dropped rather than folded into either.
public struct RoutineEvent: Equatable, Decodable, Sendable {
    public enum Kind: String, Decodable, Sendable {
        case created, proposal, unknown

        public init(parsing text: String) {
            self = Kind(rawValue: text) ?? .unknown
        }
    }

    public let kind: Kind
    public let atMs: Int64
    public let by: String?
    public let movements: Int?
    public let proposal: ProposalHead?

    public init(kind: Kind, atMs: Int64, by: String? = nil, movements: Int? = nil,
                proposal: ProposalHead? = nil) {
        self.kind = kind
        self.atMs = atMs
        self.by = by
        self.movements = movements
        self.proposal = proposal
    }

    enum CodingKeys: String, CodingKey {
        case kind, by, movements, proposal
        case atMs = "at"
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        kind = Kind(parsing: try fields.decodeIfPresent(String.self, forKey: .kind) ?? "")
        atMs = try fields.decodeIfPresent(Int64.self, forKey: .atMs) ?? 0
        by = try fields.decodeIfPresent(String.self, forKey: .by)
        movements = try fields.decodeIfPresent(Int.self, forKey: .movements)
        proposal = try fields.decodeIfPresent(ProposalHead.self, forKey: .proposal)
    }
}

// `slight` is too few working sets to say anything, and `record` and `against` are absent behind it.
public struct Review: Equatable, Codable, Sendable {
    public struct Stats: Equatable, Codable, Sendable {
        public let durationMs: Int64
        public let workingSets: Int
        public let topE1rm: Double?

        public init(durationMs: Int64, workingSets: Int, topE1rm: Double? = nil) {
            self.durationMs = durationMs
            self.workingSets = workingSets
            self.topE1rm = topE1rm
        }

        enum CodingKeys: String, CodingKey {
            case durationMs, workingSets, topE1rm
        }
    }

    public let stats: Stats
    public let slight: Bool
    public let record: PersonalRecord?
    public let against: Against?

    public init(stats: Stats, slight: Bool = false,
                record: PersonalRecord? = nil, against: Against? = nil) {
        self.stats = stats
        self.slight = slight
        self.record = record
        self.against = against
    }

    enum CodingKeys: String, CodingKey {
        case stats, slight, record, against
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        stats = try fields.decode(Stats.self, forKey: .stats)
        slight = try fields.decodeIfPresent(Bool.self, forKey: .slight) ?? false
        record = try fields.decodeIfPresent(PersonalRecord.self, forKey: .record)
        against = try fields.decodeIfPresent(Against.self, forKey: .against)
    }
}

// `previous` is what the mark beat, required by construction: with no prior history there is no record.
public struct PersonalRecord: Equatable, Codable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case e1rm
        case heaviest
        case repsAtWeight = "reps-at-weight"
    }

    public let kind: Kind
    public let exerciseId: String
    public let value: Double
    public let weightKg: Double
    public let reps: Int
    public let previous: Double
    public let previousAtMs: Int64

    public init(kind: Kind, exerciseId: String, value: Double, weightKg: Double, reps: Int,
                previous: Double, previousAtMs: Int64) {
        self.kind = kind
        self.exerciseId = exerciseId
        self.value = value
        self.weightKg = weightKg
        self.reps = reps
        self.previous = previous
        self.previousAtMs = previousAtMs
    }

    enum CodingKeys: String, CodingKey {
        case kind, exerciseId, value, weightKg, reps, previous
        case previousAtMs = "previousAt"
    }
}

// Matched on the top working set of a shared movement and never on volume.
public struct Against: Equatable, Codable, Sendable {
    // The top working set and how many of them.
    public struct Effort: Equatable, Codable, Sendable {
        public let weightKg: Double
        public let reps: Int
        public let sets: Int

        public init(weightKg: Double, reps: Int, sets: Int) {
            self.weightKg = weightKg
            self.reps = reps
            self.sets = sets
        }

        enum CodingKeys: String, CodingKey {
            case weightKg, reps, sets
        }
    }

    // Every field optional: an open row has no target to be measured against.
    public struct Target: Equatable, Codable, Sendable {
        public let sets: Int?
        public let reps: Int?
        public let weightKg: Double?

        public var isOpen: Bool { sets == nil }

        public init(sets: Int? = nil, reps: Int? = nil, weightKg: Double? = nil) {
            self.sets = sets
            self.reps = reps
            self.weightKg = weightKg
        }

        enum CodingKeys: String, CodingKey {
            case sets, reps, weightKg
        }
    }

    public struct Movement: Equatable, Codable, Sendable {
        public let exerciseId: String
        public let now: Effort
        public let before: Effort?
        public let planned: Target?

        public init(exerciseId: String, now: Effort, before: Effort? = nil, planned: Target? = nil) {
            self.exerciseId = exerciseId
            self.now = now
            self.before = before
            self.planned = planned
        }

        enum CodingKeys: String, CodingKey {
            case exerciseId, now, before, planned
        }
    }

    public let sessionId: String
    public let routine: String
    public let startedAtMs: Int64
    public let movements: [Movement]

    public init(sessionId: String, routine: String, startedAtMs: Int64, movements: [Movement]) {
        self.sessionId = sessionId
        self.routine = routine
        self.startedAtMs = startedAtMs
        self.movements = movements
    }

    enum CodingKeys: String, CodingKey {
        case sessionId, routine, movements
        case startedAtMs = "startedAt"
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try fields.decode(String.self, forKey: .sessionId)
        routine = try fields.decodeIfPresent(String.self, forKey: .routine) ?? ""
        startedAtMs = try fields.decode(Int64.self, forKey: .startedAtMs)
        movements = try fields.decodeIfPresent([Movement].self, forKey: .movements) ?? []
    }
}

// Within "last time" the weight comes from the last of its rows and the reps from the first.
public struct Prefill: Equatable, Sendable {
    public static let emptyBarKg = 20.0
    public static let emptyBarReps = 5
    public static let emptyBar = Prefill(weightKg: emptyBarKg, reps: emptyBarReps)

    public let weightKg: Double
    public let reps: Int

    public init(weightKg: Double, reps: Int) {
        self.weightKg = weightKg
        self.reps = reps
    }

    // The sticky carry-forward crosses working sets only. Reps are floored at 1 — the server refuses
    // 0 — and weight takes no such clamp: the load is signed and unbounded.
    public init(todaySets: [TrainingSet], planEntry: PlanEntry?, lastTime: LastTime?) {
        if let sticky = todaySets.last(where: { $0.kind == .working }) {
            self.init(weightKg: sticky.weightKg, reps: max(1, sticky.reps))
            return
        }
        let history = lastTime?.sets ?? []
        let weight = planEntry?.weightKg ?? history.last?.weightKg ?? Prefill.emptyBarKg
        let reps = planEntry.flatMap(\.reps) ?? history.first?.reps ?? Prefill.emptyBarReps
        self.init(weightKg: weight, reps: max(1, reps))
    }
}

// The write bodies: set number, plan snapshot and last-trained stamp are the server's.

public struct SetWrite: Equatable, Codable, Sendable {
    public let id: String
    public let exerciseId: String
    public let weightKg: Double
    public let reps: Int
    public let kind: SetKind
    public let completedAtMs: Int64

    public init(_ set: TrainingSet) {
        id = set.id
        exerciseId = set.exerciseId
        weightKg = set.weightKg
        reps = set.reps
        kind = set.kind
        completedAtMs = set.completedAtMs
    }

    enum CodingKeys: String, CodingKey {
        case id, exerciseId, weightKg, reps, kind
        case completedAtMs = "completedAt"
    }
}

// All three ride on every fix, changed or not; the server refuses every other key by name.
public struct SetFix: Equatable, Codable, Sendable {
    public let weightKg: Double
    public let reps: Int
    public let kind: SetKind

    public init(weightKg: Double, reps: Int, kind: SetKind) {
        self.weightKg = weightKg
        self.reps = reps
        self.kind = kind
    }

    enum CodingKeys: String, CodingKey {
        case weightKg, reps, kind
    }
}

// Omitting `joinOpenSession` is the wire's join default, filing the sets into whatever session is
// already open. Every start this room sends says false.
public struct SessionStart: Equatable, Codable, Sendable {
    public let id: String
    public let startedAtMs: Int64
    public let routineId: String?
    public let joinOpenSession: Bool?

    public init(id: String, startedAtMs: Int64, routineId: String? = nil, joinOpenSession: Bool? = nil) {
        self.id = id
        self.startedAtMs = startedAtMs
        self.routineId = routineId
        self.joinOpenSession = joinOpenSession
    }

    enum CodingKeys: String, CodingKey {
        case id, routineId, joinOpenSession
        case startedAtMs = "startedAt"
    }
}

public struct SessionFinish: Equatable, Codable, Sendable {
    public let finishedAtMs: Int64

    public init(finishedAtMs: Int64) {
        self.finishedAtMs = finishedAtMs
    }

    enum CodingKeys: String, CodingKey {
        case finishedAtMs = "finishedAt"
    }
}

// An omitted `stepKg` takes the equipment's default.
public struct ExerciseWrite: Equatable, Codable, Sendable {
    public let id: String
    public let name: String
    public let pattern: String
    public let equipment: String
    public let stepKg: Double?

    public init(id: String = Ids.exercise(), name: String, pattern: String,
                equipment: String, stepKg: Double? = nil) {
        self.id = id
        self.name = name
        self.pattern = pattern
        self.equipment = equipment
        self.stepKg = stepKg
    }

    enum CodingKeys: String, CodingKey {
        case id, name, pattern, equipment, stepKg
    }
}

// One field only: the server refuses any other key.
public struct ExerciseRename: Equatable, Codable, Sendable {
    public let name: String

    public init(name: String) {
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case name
    }
}

public struct RoutineWrite: Equatable, Codable, Sendable {
    // No `position`: entry order is the routine order. An open line omits `targetSets` and carries no
    // reps and no weight either; a zero is refused.
    public struct Entry: Equatable, Codable, Sendable {
        public let exerciseId: String
        public let targetSets: Int?
        public let targetReps: Int?
        public let targetWeightKg: Double?
        public let restSeconds: Int?

        public var isOpen: Bool { targetSets == nil }

        public init(exerciseId: String, targetSets: Int? = nil, targetReps: Int? = nil,
                    targetWeightKg: Double? = nil, restSeconds: Int? = nil) {
            self.exerciseId = exerciseId
            self.targetSets = targetSets
            self.targetReps = targetReps
            self.targetWeightKg = targetWeightKg
            self.restSeconds = restSeconds
        }

        enum CodingKeys: String, CodingKey {
            case exerciseId, targetSets, targetReps, targetWeightKg, restSeconds
        }
    }

    public let id: String
    public let name: String
    public let position: Int
    public let entries: [Entry]

    public init(id: String, name: String, position: Int, entries: [Entry]) {
        self.id = id
        self.name = name
        self.position = position
        self.entries = entries
    }

    // Composed the way the server composes it: position 1-based and dense, in entry order.
    public var made: Routine {
        Routine(id: id, name: name, position: position,
                entries: entries.enumerated().map { index, entry in
                    RoutineEntry(position: index + 1, exerciseId: entry.exerciseId,
                                 targetSets: entry.targetSets, targetReps: entry.targetReps,
                                 targetWeightKg: entry.targetWeightKg, restSeconds: entry.restSeconds)
                })
    }

    // A routine PUT is a whole-document replace, so every line rides.
    public init(_ routine: Routine) {
        self.init(id: routine.id, name: routine.name, position: routine.position,
                  entries: routine.entries
                      .sorted { $0.position < $1.position }
                      .map { Entry(exerciseId: $0.exerciseId, targetSets: $0.targetSets,
                                   targetReps: $0.targetReps, targetWeightKg: $0.targetWeightKg,
                                   restSeconds: $0.restSeconds) })
    }

    // Movements in the order performed, `targetSets` the count of working sets, `targetReps` the modal
    // reps (a tie goes to the smaller), `targetWeightKg` the heaviest load. nil when there are none.
    public init?(named name: String, from sets: [TrainingSet], position: Int, id: String = Ids.routine()) {
        let working = sets.filter { $0.kind == .working }.sorted { $0.completedAtMs < $1.completedAtMs }
        var order: [String] = []
        for set in working where !order.contains(set.exerciseId) { order.append(set.exerciseId) }
        guard !order.isEmpty else { return nil }

        self.init(id: id, name: name, position: position, entries: order.map { exerciseId in
            let performed = working.filter { $0.exerciseId == exerciseId }
            let counts = Dictionary(grouping: performed, by: \.reps).mapValues(\.count)
            let modal = counts.sorted { left, right in
                if left.value != right.value { return left.value > right.value }
                return left.key < right.key
            }.first?.key ?? 1
            return Entry(exerciseId: exerciseId,
                         targetSets: performed.count,
                         targetReps: modal,
                         targetWeightKg: performed.map(\.weightKg).max())
        })
    }

    enum CodingKeys: String, CodingKey {
        case id, name, position, entries
    }
}

// The wire's bound on every instant. A local timestamp outside it is repaired before replay: a bad
// instant is answered with a terminal 400 and the claim would jam.
public enum Instants {
    public static let maxMs: Int64 = 253_402_300_799_000

    public static func clamped(_ ms: Int64) -> Int64 {
        min(max(ms, 1), maxMs)
    }
}

// Minted here and never by the server. A client-minted id IS the idempotency key: a replay answers
// 200 with the stored row. Inside the 8…64 [A-Za-z0-9_-] the server enforces.
public enum Ids {
    public static func session() -> String { mint("ses_") }
    public static func set() -> String { mint("set_") }
    public static func routine() -> String { mint("rt_") }
    public static func exercise() -> String { mint("ex_") }

    static func mint(_ prefix: String) -> String {
        prefix + (0..<8).map { _ in String(format: "%02x", UInt8.random(in: UInt8.min...UInt8.max)) }.joined()
    }
}
