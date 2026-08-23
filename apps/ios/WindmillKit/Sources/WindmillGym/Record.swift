import Foundation

// The wire shape of `GET /v1/gym/exercises/{id}/record` and the one page it draws — the native twin of
// backend/products/gym/domain/Record.h. No number here is computed: an estimate arrives with the mark or is absent.

// `e1rm` is present exactly where Epley is defined.
public struct MovementMark: Equatable, Codable, Sendable {
    public let weightKg: Double
    public let reps: Int
    public let atMs: Int64  // the SESSION's start, never the set's own instant
    public let e1rm: Double?

    public init(weightKg: Double, reps: Int, atMs: Int64, e1rm: Double? = nil) {
        self.weightKg = weightKg
        self.reps = reps
        self.atMs = atMs
        self.e1rm = e1rm
    }

    enum CodingKeys: String, CodingKey {
        case weightKg, reps, e1rm
        case atMs = "at"
    }
}

// One training day: the session and its sets in performed order, warmups already dropped by the read.
public struct TrainingDay: Equatable, Codable, Sendable, Identifiable {
    public let sessionId: String
    public let startedAtMs: Int64
    public let sets: [TrainingSet]

    public init(sessionId: String, startedAtMs: Int64, sets: [TrainingSet] = []) {
        self.sessionId = sessionId
        self.startedAtMs = startedAtMs
        self.sets = sets
    }

    public var id: String { sessionId }

    enum CodingKeys: String, CodingKey {
        case sessionId, sets
        case startedAtMs = "startedAt"
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try fields.decode(String.self, forKey: .sessionId)
        startedAtMs = try fields.decode(Int64.self, forKey: .startedAtMs)
        sets = try fields.decodeIfPresent([TrainingSet].self, forKey: .sets) ?? []
    }
}

// Every list is omitted when empty and every count is always there.
public struct MovementRecord: Equatable, Codable, Sendable {
    public let exercise: Exercise
    public let routineCount: Int
    // In program order; `routineCount` is exactly this list's length.
    public let routines: [String]
    public let sessionCount: Int
    public let bestE1rm: MovementMark?
    public let heaviest: MovementMark?
    public let e1rmSeries: [MovementMark]  // oldest first, the last twelve weeks
    public let records: [MovementMark]  // NEWEST first, lifetime
    public let recentDays: [TrainingDay]  // NEWEST first, at most ten

    public init(exercise: Exercise, routineCount: Int = 0, routines: [String] = [],
                sessionCount: Int = 0,
                bestE1rm: MovementMark? = nil, heaviest: MovementMark? = nil,
                e1rmSeries: [MovementMark] = [], records: [MovementMark] = [],
                recentDays: [TrainingDay] = []) {
        self.exercise = exercise
        self.routineCount = routineCount
        self.routines = routines
        self.sessionCount = sessionCount
        self.bestE1rm = bestE1rm
        self.heaviest = heaviest
        self.e1rmSeries = e1rmSeries
        self.records = records
        self.recentDays = recentDays
    }

    enum CodingKeys: String, CodingKey {
        case exercise, routineCount, routines, sessionCount, bestE1rm, heaviest, e1rmSeries
        case records, recentDays
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        exercise = try fields.decode(Exercise.self, forKey: .exercise)
        routineCount = try fields.decodeIfPresent(Int.self, forKey: .routineCount) ?? 0
        routines = try fields.decodeIfPresent([String].self, forKey: .routines) ?? []
        sessionCount = try fields.decodeIfPresent(Int.self, forKey: .sessionCount) ?? 0
        bestE1rm = try fields.decodeIfPresent(MovementMark.self, forKey: .bestE1rm)
        heaviest = try fields.decodeIfPresent(MovementMark.self, forKey: .heaviest)
        e1rmSeries = try fields.decodeIfPresent([MovementMark].self, forKey: .e1rmSeries) ?? []
        records = try fields.decodeIfPresent([MovementMark].self, forKey: .records) ?? []
        recentDays = try fields.decodeIfPresent([TrainingDay].self, forKey: .recentDays) ?? []
    }
}

public enum Record {
    // The device holds the sets and the account holds the estimates, so an absent e1RM means two different things
    // depending on which answered.
    public enum Source: Equatable, Sendable {
        case theLog
        case thisDevice
    }

    public struct Answer: Equatable {
        public let record: MovementRecord
        public let source: Source

        public init(_ record: MovementRecord, from source: Source) {
            self.record = record
            self.source = source
        }
    }

    public enum NoChart: Equatable, Sendable {
        case onThisDevice  // the device answered, and it computes no estimate at all
        case neverWorked  // logged, but never in a working set — nothing here counts one
        case unloaded  // every working set at or below zero, where Epley says nothing
        case outsideWindow  // a standing best, and nothing inside the twelve weeks
    }

    // The server cuts the series before it is sent; this only names what arrived.
    public static let windowWeeks = 12

    public struct Tile: Equatable {
        public let caption: String
        public let value: String
        public let under: String
    }

    public enum Mark: Equatable {
        case best, passed, ordinary
    }

    public struct Bar: Equatable, Identifiable {
        // The instant cannot be the id: two sessions can share a start, and duplicate `ForEach` ids are undefined.
        public let id: Int
        public let atMs: Int64
        public let height: Double  // 0…1 across the window's own range
        public let mark: Mark
    }

    // `opened` and `closed` carry each end's date and value: this chart's baseline is not zero.
    public struct Chart: Equatable {
        public let bars: [Bar]
        public let window: String
        public let opened: String
        public let closed: String
    }

    public struct Row: Equatable, Identifiable {
        public let id: Int  // its place on the ladder, newest first
        public let effort: String
        public let estimate: String?
        public let when: String
    }

    public struct Day: Equatable, Identifiable {
        public let id: String
        public let when: String
        public let sets: String
    }

    public struct Page: Equatable {
        public let source: Source
        public let name: String
        public let subhead: String
        public let best: Tile?
        public let heaviest: Tile?
        public let chart: Chart?
        public let noChart: NoChart?
        public let records: [Row]
        public let days: [Day]
        public let proof: [Proof]

        // A movement worked only in drop sets is not this: it has days to draw.
        public var neverLogged: Bool { heaviest == nil && days.isEmpty }
    }

    public static func page(_ record: MovementRecord, now: Int64, from source: Source = .theLog) -> Page {
        let chart = chart(record)
        return Page(
            source: source,
            name: record.exercise.name,
            subhead: subhead(record),
            best: record.bestE1rm.flatMap { best in
                best.e1rm.map {
                    Tile(caption: "best e1RM", value: Readout.weight($0),
                         under: "\(Readout.when(best.atMs, now: now)) · \(effort(best))")
                }
            },
            heaviest: record.heaviest.map {
                Tile(caption: "heaviest", value: Readout.weight($0.weightKg),
                     under: "kg · for \($0.reps)")
            },
            chart: chart,
            noChart: chart == nil ? why(record, from: source) : nil,
            records: record.records.enumerated().map { place, mark in
                Row(id: place, effort: effort(mark),
                    estimate: mark.e1rm.map { "e1RM \(Readout.weight($0))" },
                    when: Readout.when(mark.atMs, now: now))
            },
            days: record.recentDays.compactMap { day in
                guard !day.sets.isEmpty else { return nil }
                return Day(id: day.sessionId, when: Readout.when(day.startedAtMs, now: now),
                           sets: day.sets.map(effort).joined(separator: " · "))
            },
            proof: proof(record, from: source))
    }

    public struct Proof: Equatable, Identifiable {
        public let label: String
        public let said: String

        public var id: String { label }
    }

    // A fact with nothing to say is left out rather than printed as a zero.
    // The alias line is the log's to promise: a page this device answered may not make it.
    public static func proof(_ record: MovementRecord, from source: Source = .theLog) -> [Proof] {
        var proven: [Proof] = []
        if record.sessionCount > 0 {
            proven.append(Proof(label: "sessions", said: "\(record.sessionCount) · unchanged"))
        }
        if !record.records.isEmpty {
            let marks = record.records.count == 1 ? "1 PR" : "\(record.records.count) PRs"
            let kept = record.bestE1rm?.e1rm.map { " · e1RM \(Readout.weight($0)) kept" } ?? ""
            proven.append(Proof(label: "records", said: marks + kept))
        }
        if !record.routines.isEmpty {
            proven.append(Proof(label: "routines", said: record.routines.joined(separator: " · ")))
        }
        if source == .theLog {
            proven.append(Proof(label: "old name", said: "searchable as an alias"))
        }
        return proven
    }

    // Equipment is omitted rather than blanked when the catalog row carries none.
    private static func subhead(_ record: MovementRecord) -> String {
        var said: [String] = []
        if !record.exercise.equipment.isEmpty { said.append(record.exercise.equipment) }
        said.append(record.routineCount == 0
                        ? "in no routine"
                        : "in \(record.routineCount) routine\(record.routineCount == 1 ? "" : "s")")
        said.append(sessions(record))
        return said.joined(separator: " · ")
    }

    // The count is over working sets and the days are not, so a movement worked only in drops is in the days and no count.
    private static func sessions(_ record: MovementRecord) -> String {
        guard record.sessionCount == 0 else { return Readout.sessionCount(record.sessionCount) }
        guard record.recentDays.contains(where: { !$0.sets.isEmpty }) else { return "never logged" }
        return "no working sets"
    }

    // In the order the facts overrule each other: who answered, then the window, then whether it was ever worked.
    private static func why(_ record: MovementRecord, from source: Source) -> NoChart {
        guard source == .theLog else { return .onThisDevice }
        guard record.bestE1rm == nil else { return .outsideWindow }
        guard record.sessionCount > 0 else { return .neverWorked }
        return .unloaded
    }

    // nil where the series is empty: a movement nobody worked, or one whose every load sits at or below zero.
    private static func chart(_ record: MovementRecord) -> Chart? {
        let points = record.e1rmSeries.compactMap { mark in mark.e1rm.map { (mark.atMs, $0) } }
        guard let first = points.first, let last = points.last else { return nil }
        return Chart(bars: bars(points, best: record.bestE1rm?.atMs,
                                passed: Set(record.records.map(\.atMs))),
                     window: "\(windowWeeks) weeks",
                     opened: "\(Readout.date(first.0)) · \(Readout.weight(first.1))",
                     closed: "\(Readout.date(last.0)) · \(Readout.weight(last.1))")
    }

    // The baseline floats a third of the window's span below its lowest session; a series that never moved is drawn down
    // the middle rather than divided by nothing.
    private static func bars(_ points: [(Int64, Double)], best: Int64?, passed: Set<Int64>) -> [Bar] {
        let values = points.map(\.1)
        let low = values.min() ?? 0
        let high = values.max() ?? 0
        let floor = low - (high - low) / 3
        return points.enumerated().map { place, point in
            Bar(id: place,
                atMs: point.0,
                height: high > floor ? (point.1 - floor) / (high - floor) : 0.5,
                mark: point.0 == best ? .best : (passed.contains(point.0) ? .passed : .ordinary))
        }
    }

    // A zero load is the absence of one, so a chin-up's mark reads as its reps; −20 prints as a load.
    private static func effort(_ mark: MovementMark) -> String {
        effort(weightKg: mark.weightKg, reps: mark.reps)
    }

    private static func effort(_ set: TrainingSet) -> String {
        let done = effort(weightKg: set.weightKg, reps: set.reps)
        guard set.kind != .working else { return done }
        return "\(done) \(set.kind.rawValue)"
    }

    private static func effort(weightKg: Double, reps: Int) -> String {
        guard weightKg != 0 else { return "\(reps) reps" }
        return Readout.effort(weightKg: weightKg, reps: reps)
    }
}
