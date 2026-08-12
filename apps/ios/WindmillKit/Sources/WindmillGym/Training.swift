import Foundation

// The gym domain as this device holds it — the native twin of backend/products/gym/domain/Training.h
// and the codec in adapters/json/TrainingJson, grouped the way the backend groups it so the two
// statements of one model can be read side by side. Instants are epoch-ms, weights are kg in a
// SIGNED Double (band-assisted work sits below zero, and that is a point on the number line rather
// than a mode), and every id is minted here, on the device.
//
// Three rules run through the whole file:
//   · AN ABSENT OPTIONAL IS OMITTED, never null. That is the module's wire convention, and it is
//     also what this device writes to its own disk — so one row travels both ways with no second
//     vocabulary to keep in step. Swift's synthesized encoder omits a nil optional, which is the
//     rule already; nothing here has to spell it.
//   · A FIELD THE SERVER OWNS IS NOT ON A WRITE. Set numbers, plan snapshots and last-trained
//     stamps are stamped by the store, and a client that sent one would be claiming a fact it does
//     not own. The write bodies at the foot of this file carry what a device knows and no more.
//   · A READ DEFAULTS RATHER THAN THROWS wherever a default is honest. The decoder is a plain
//     JSONDecoder with no key strategy (WindmillApi), so every wire name is spelled out in
//     CodingKeys — and a field the server adds or stops sending must not turn a finished workout
//     into `.malformed`.

public enum SetKind: String, Codable, Sendable, CaseIterable {
    case warmup, working, drop, failure

    // A kind this build has never heard of reads as `working`, which is also the server's default
    // for a set that names none. Folding it to `warmup` instead would be the quiet way to lose a
    // lift: warmups are excluded from history, from the prefill and from every record rule.
    public init(parsing text: String) {
        self = SetKind(rawValue: text) ?? .working
    }
}

// A movement with a stable identity — never a typed string, which is the whole reason the catalog
// exists. `pattern` and `equipment` stay Strings rather than enums on purpose: the backend may seed
// a pattern this build has never compiled, and a strict client would answer that by refusing to
// draw the catalog at all.
public struct Exercise: Equatable, Codable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let pattern: String
    public let equipment: String
    public let stepKg: Double?
    public let custom: Bool

    public init(id: String, name: String, pattern: String = "", equipment: String = "",
                stepKg: Double? = nil, custom: Bool = false) {
        self.id = id
        self.name = name
        self.pattern = pattern
        self.equipment = equipment
        self.stepKg = stepKg
        self.custom = custom
    }

    enum CodingKeys: String, CodingKey {
        case id, name, pattern, equipment, stepKg, custom
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        id = try fields.decode(String.self, forKey: .id)
        name = try fields.decodeIfPresent(String.self, forKey: .name) ?? ""
        pattern = try fields.decodeIfPresent(String.self, forKey: .pattern) ?? ""
        equipment = try fields.decodeIfPresent(String.self, forKey: .equipment) ?? ""
        stepKg = try fields.decodeIfPresent(Double.self, forKey: .stepKg)
        custom = try fields.decodeIfPresent(Bool.self, forKey: .custom) ?? false
    }
}

// One line of the plan a session was started against. `weightKg` absent means the routine wrote no
// target — "whatever you did last time" — and the prefill falls through to the log for it, so an
// absence here is a real instruction and never a zero.
//
// `reps` is absent the same way and means MAX: a chin-up taken to whatever it gives that day. It is
// not a zero, it is not a blank, and it asks the prefill for nothing.
public struct PlanEntry: Equatable, Codable, Sendable {
    public let exerciseId: String
    public let sets: Int
    public let reps: Int?
    public let weightKg: Double?
    public let restSeconds: Int?

    public init(exerciseId: String, sets: Int, reps: Int? = nil,
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

// The routine as it stood the moment Start was pressed. Signed in the SERVER freezes it off the
// routine's own row — a client-composed copy would freeze whatever that client last read, which is
// exactly the staleness the snapshot exists to prevent. Signed out this device IS the routine's
// only shelf, so the local start composes it off that only copy: the same rule, nothing to be
// stale against. `routine` is the name that day of the program had then, and a rename since must
// not rewrite what the log says about the past.
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

    enum CodingKeys: String, CodingKey {
        case id, routineId, plan
        case startedAtMs = "startedAt"
        case finishedAtMs = "finishedAt"
    }
}

// One set, exactly as the log stores it. `setNumber` is the log's own count of this movement in this
// session and is absent while this device is the only place the row exists — but the queue's
// `needsPush` is the authority on whether it is still owed, and nothing may read the two as one
// fact. `note` is a String and never optional on the wire, so an absent one is empty, not missing.
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

    // The same set under a fresh id, for the one repair a spent id allows. Everything the lifter
    // actually did travels unchanged — a remint moves the idempotency key and nothing else.
    public func reminted(as id: String) -> TrainingSet {
        TrainingSet(id: id, exerciseId: exerciseId, setNumber: setNumber, weightKg: weightKg,
                    reps: reps, kind: kind, rpe: rpe, note: note, completedAtMs: completedAtMs)
    }

    // THE CORRECTION RULE, and it is the same one the backend states in domain/Training.cpp: the fix
    // carries the three things a thumb can move and everything else is COPIED across, visibly. The
    // id, the movement, the number and the instant are what make this the SAME set — a body that
    // moved one of them would be logging a different one under a repair's name.
    public func corrected(by fix: SetFix) -> TrainingSet {
        TrainingSet(id: id, exerciseId: exerciseId, setNumber: setNumber, weightKg: fix.weightKg,
                    reps: fix.reps, kind: fix.kind, rpe: rpe, note: note, completedAtMs: completedAtMs)
    }

    // The same set with its instant repaired into the wire's bound (`Instants`). The claim replays
    // through this so a broken local clock cannot jam a whole session behind a terminal 400.
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

// The heaviest WORKING set of a session, ties going to the reps. Absent for a session holding no
// working set — a warmup-only session has no top set, and a zero pretending to be one would be a
// load nobody lifted.
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

// A row of the log. The wire is FLAT — the session's own fields with the row's facts beside them —
// so this decodes the session off the same container rather than from a nested key that is not
// there.
//
// `closedItself` is drawn where it is a fact worth having — the session detail says so under the
// clock, because a four-hour span that ended in a rule rather than in a tap is a phone left running
// and not a workout that lasted that long. `topSet` is decoded and NOT drawn on this surface: the
// log row prints the estimate over it instead (§G16) and the detail lists every set anyway, so the
// heaviest one over that list would be the same fact twice. It stays on the model because the web's
// row draws it and one wire shape is one wire shape.
//
// THE THREE FACTS §G16's ROW READS ARE THE LAST THREE, and none of them is `setCount`: the log
// printed that beside a top set the store had already filtered to WORKING, so a session's "sets"
// counted warmups and its top set did not. `setCount` keeps its own meaning — every set, every kind
// — and its own consumers. Each of the three is optional and an ABSENT one draws nothing at all:
// `topE1rm` is the domain's best Epley over EVERY working set — not over the heaviest one — and
// Epley is the domain's, one copy per language and none of them Swift, so a session this device is
// still holding alone has a working count and a tonnage and no estimate.
//
// `record` is the gold dot (§G16), and it is a BOOL the server always sends rather than an optional:
// false is the answer on ~190 rows in 200. It is judged against the log AS IT IS NOW and never
// frozen at finish — a correction (§G18) moves records, and a dot that lied after a fix would be
// worse than no dot. It defaults to false for the rows this device composes itself, because the
// three record rules are claims against a history the device does not hold: no dot there is an
// omission, which a local read may make, and never an assertion, which it may not.
public struct SessionSummary: Equatable, Codable, Sendable, Identifiable {
    public let session: Session
    public let setCount: Int
    public let exercises: [String]
    public let topSet: TopSet?
    // True when the four-hour rule closed the session rather than a tap. The store INFERS it — it is
    // not a column — from `finishedAt` landing exactly on the last set's instant, which is that
    // rule's signature. A manual finish on the same millisecond is a coincidence whose whole cost is
    // one wrong subtitle.
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

// The prefill read, answered by the store: the newest FINISHED session holding this movement, its
// working sets in order, warmups already dropped. A movement trained for the first time comes back
// as the movement and nothing else — a fact, not a fault — so `session == nil` is what says there is
// no history, and an absent REPLY means something else entirely: the log did not answer.
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

// `targetReps` absent is the routine declining to name one — `3 × max`, a movement taken to whatever
// it gives that day. The same absence the plan snapshot carries, because the snapshot is frozen off
// these rows.
public struct RoutineEntry: Equatable, Codable, Sendable {
    public let position: Int
    public let exerciseId: String
    public let targetSets: Int
    public let targetReps: Int?
    public let targetWeightKg: Double?
    public let restSeconds: Int?

    public init(position: Int, exerciseId: String, targetSets: Int, targetReps: Int? = nil,
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

// A written-down day of the program. Entry ORDER is the routine order; `position` is 1-based and
// dense and comes back from the server, so nothing here re-derives it. `lastTrainedAtMs` is absent
// until the routine has been trained once — the list sorts by it, and a never-trained routine sorts
// on the absence rather than on a zero pretending to be 1970.
public struct Routine: Equatable, Codable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let position: Int
    public let lastTrainedAtMs: Int64?
    public let entries: [RoutineEntry]

    public init(id: String, name: String, position: Int,
                lastTrainedAtMs: Int64? = nil, entries: [RoutineEntry] = []) {
        self.id = id
        self.name = name
        self.position = position
        self.lastTrainedAtMs = lastTrainedAtMs
        self.entries = entries
    }

    // Newest-trained first, and never by when they were made — that is how a lifter picks one, and
    // it is the order `GET /v1/gym/routines` already answers in (PgTrainingRepository, last_trained
    // DESC NULLS LAST then position). Stated here as well because the device's own unclaimed
    // routines are folded in AFTER the served ones, and one list may not read in two orders.
    public static func byLastTrained(_ routines: [Routine]) -> [Routine] {
        routines.sorted { left, right in
            let trained = (left.lastTrainedAtMs ?? .min, right.lastTrainedAtMs ?? .min)
            guard trained.0 == trained.1 else { return trained.0 > trained.1 }
            return left.position < right.position
        }
    }

    // The mid-session change offer, applied (screen 8). Read-modify-write is the whole shape: the
    // routine that comes back is this one with a single target moved, and a movement the routine
    // does not hold leaves it untouched — the offer is only ever raised against a planned weight,
    // so an entry that is not there means the offer was answered for some other routine.
    public func retargeting(_ exerciseId: String, toWeightKg weightKg: Double) -> Routine {
        Routine(id: id, name: name, position: position, lastTrainedAtMs: lastTrainedAtMs,
                entries: entries.map { entry in
                    guard entry.exerciseId == exerciseId else { return entry }
                    return RoutineEntry(position: entry.position, exerciseId: entry.exerciseId,
                                        targetSets: entry.targetSets, targetReps: entry.targetReps,
                                        targetWeightKg: weightKg, restSeconds: entry.restSeconds)
                })
    }

    enum CodingKeys: String, CodingKey {
        case id, name, position, entries
        case lastTrainedAtMs = "lastTrainedAt"
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        id = try fields.decode(String.self, forKey: .id)
        name = try fields.decodeIfPresent(String.self, forKey: .name) ?? ""
        position = try fields.decodeIfPresent(Int.self, forKey: .position) ?? 0
        lastTrainedAtMs = try fields.decodeIfPresent(Int64.self, forKey: .lastTrainedAtMs)
        entries = try fields.decodeIfPresent([RoutineEntry].self, forKey: .entries) ?? []
    }
}

// The finish screen and the session-detail readout, computed by the DOMAIN so web and iOS can never
// disagree about which line is the loud one. Three facts, at most one record, and a comparison that
// is a fact with a direction rather than a grade. `slight` is the honest silence: too few working
// sets to say anything, and `record` and `against` are both absent behind it.
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

// A mark that was passed. `previous` is what it beat, and it is required by construction: with no
// prior history there is no record, because a first entry is not a record and claiming otherwise
// devalues every later one.
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

// This session against the last one on the same routine, matched on the TOP WORKING SET of a shared
// movement and never on volume — four light sets must not beat three heavy ones.
public struct Against: Equatable, Codable, Sendable {
    // What was done: the top working set and how many of them.
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

    // What was written down. `weightKg` and `reps` are optional for the same reason PlanEntry's are:
    // a routine line may name sets alone and leave the load to last time and the reps to the day,
    // and a strict read would fail the whole finish screen on a plan that did exactly that.
    public struct Target: Equatable, Codable, Sendable {
        public let sets: Int
        public let reps: Int?
        public let weightKg: Double?

        public init(sets: Int, reps: Int? = nil, weightKg: Double? = nil) {
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

// THE PREFILL — the number in front of the lifter before they touch anything, and the reason this is
// a training log and not a form. Three sources in a fixed order, and the one that loses is still on
// screen. The web's copy went with its logger on 2026-08-09 (§11), so this rule has one home.
//
// The asymmetry in "last time" is deliberate — the weight comes from the LAST working set, where the
// lifter actually ended up, and the reps from the FIRST, before fatigue cut them.
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

    // `todaySets` is this movement's sets in this session, performed order. The sticky carry-forward
    // follows the thumb — but only across WORKING sets: a 40 kg ramp-up is not what the next set is
    // aimed at, and carrying it would drag the dial down the ladder the lifter just climbed. After a
    // warmup the number falls back to the plan's target, which is exactly where the working set goes.
    //
    // A plan that names no rep target asks for NOTHING here. It is not a zero: an absent target means
    // max, and the reps fall through to last time the same way an absent weight does.
    //
    // The rep floor belongs where the number is MINTED and not only on the button that moves it
    // (Ladder.bumpReps clamps the same way). Every source here is someone else's data — a queued set
    // from a build before the floor moved, a plan snapshot, a session logged months ago — and a 0
    // arriving from any of them opens the pad on a value the server refuses. Weight gets no such
    // clamp on purpose: the load is signed and unbounded by design.
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

// THE WRITE BODIES. Each carries what a device knows and no more — no set number, no plan snapshot,
// no last-trained stamp, because those are the server's to stamp and a client that sent one would be
// claiming a fact it does not own.

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

// A CORRECTION (§G18), and it carries the three things the sheet lets a thumb move and nothing else.
// Not `exerciseId` — a set logged against the wrong movement is a different repair and the design
// does not draw it — and not `completedAt` or `setNumber`, which are the log's own account of when
// this set happened and where it sits in the movement's run. The server refuses every other key by
// name rather than ignoring it.
//
// All three ride on every fix rather than only the ones that moved: the sheet holds the whole set and
// knows what it should now read, so "unchanged" has no second spelling here to get wrong. The wire
// reads an absent field as "leave what is stored", which is the same answer arrived at differently.
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

// Start. `joinOpenSession` is omitted by a LIVE start always: the default JOINS whatever session is
// already open, so a lost race and a borrowed second device both land in the live workout in one
// round trip. `false` means "create exactly this session, which is not now" — backfill on the web,
// and the claim replay here, where the join default once silently filed a past session's sets into
// a workout that was running (gym ARCHITECTURE.md §11's shipped bug).
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

// A custom movement, created from the picker's `Create "{query}"`. `stepKg` is omitted to take the
// equipment's default — the ladder is the server's to decide for a movement nobody has weighed.
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

// A rename, and it carries ONE field on purpose: the pattern, the equipment and the step are facts
// about the movement rather than about what this account calls it, and a body that resent them would
// let a rename quietly re-classify somebody else's seeded row. The server refuses any other key.
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
    // No `position`: entry ORDER is the routine order, and a client that numbered its own lines
    // would be sending the server a fact the server derives — twice, and eventually differently.
    public struct Entry: Equatable, Codable, Sendable {
        public let exerciseId: String
        public let targetSets: Int
        public let targetReps: Int?
        public let targetWeightKg: Double?
        public let restSeconds: Int?

        public init(exerciseId: String, targetSets: Int, targetReps: Int? = nil,
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

    // What a create ANSWERS, composed the way the server composes it — position 1-based and dense,
    // in entry order. The device's own copy of the rule, for the routine kept while nobody is
    // signed in to ask.
    public var made: Routine {
        Routine(id: id, name: name, position: position,
                entries: entries.enumerated().map { index, entry in
                    RoutineEntry(position: index + 1, exerciseId: entry.exerciseId,
                                 targetSets: entry.targetSets, targetReps: entry.targetReps,
                                 targetWeightKg: entry.targetWeightKg, restSeconds: entry.restSeconds)
                })
    }

    // The whole document again, with whatever the caller changed. A routine PUT is a replace, so a
    // read-modify-write that dropped a line would delete it — this is the one conversion, and it
    // keeps the server's own order.
    public init(_ routine: Routine) {
        self.init(id: routine.id, name: routine.name, position: routine.position,
                  entries: routine.entries
                      .sorted { $0.position < $1.position }
                      .map { Entry(exerciseId: $0.exerciseId, targetSets: $0.targetSets,
                                   targetReps: $0.targetReps, targetWeightKg: $0.targetWeightKg,
                                   restSeconds: $0.restSeconds) })
    }

    // "Keep this as a routine" (screen 3) — the first routine is a by-product of the first session,
    // composed here from what was actually lifted: movements in the order performed, targetSets the
    // count of working sets, targetReps the modal reps, targetWeightKg the heaviest working load.
    //
    // WORKING SETS ONLY, strictly. A warmup, a drop and a failure are not what next week is aimed at,
    // and a 40 kg ramp-up written in as a target would put a number nobody chose on screen 6.
    //
    // A tie on the modal reps goes to the SMALLER count: a target you can beat is a fact about last
    // week, and one you cannot hit reads as a failed session every time it comes round.
    //
    // Failable because a routine with no entries is refused 400, and a session of nothing but
    // warmups has none — nothing is created until the tap, and there is nothing here to create.
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

// The wire's bound on every instant: (0, 253402300799000] — year 9999 — and finish may never come
// before start. A local timestamp outside it (a zero clock, a nanosecond slip) is REPAIRED before
// replay, because the server answers a bad instant with a terminal 400 and the claim would jam on
// it forever.
public enum Instants {
    public static let maxMs: Int64 = 253_402_300_799_000

    public static func clamped(_ ms: Int64) -> Int64 {
        min(max(ms, 1), maxMs)
    }
}

// THE IDS, minted here and never by the server. A client-minted id IS the idempotency key: a replay
// of a set that already landed answers 200 with the stored row, even after the session closed, which
// is what lets the queue send in any order, any number of times, and converge on one row per id.
//
// Sixteen hex characters behind a four-character prefix — twenty, inside the 8…64 [A-Za-z0-9_-] the
// server enforces, and 64 bits of entropy so a collision is a refusal to repair rather than a thing
// to plan around.
public enum Ids {
    public static func session() -> String { mint("ses_") }
    public static func set() -> String { mint("set_") }
    public static func routine() -> String { mint("rt_") }
    public static func exercise() -> String { mint("ex_") }

    static func mint(_ prefix: String) -> String {
        prefix + (0..<8).map { _ in String(format: "%02x", UInt8.random(in: UInt8.min...UInt8.max)) }.joined()
    }
}
