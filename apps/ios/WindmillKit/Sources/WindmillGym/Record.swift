import Foundation

// A MOVEMENT'S RECORD — the wire shape of `GET /v1/gym/exercises/{id}/record` and the one page it
// draws (§H). The native twin of backend/products/gym/domain/Record.h, and it stands where the
// statistics board used to: what a lifter wanted from a dashboard is ONE movement's arc, reached by
// tapping its name, and never a room to visit when you are not training.
//
// The retired board's refusals came with it and are the load-bearing half:
//   · no volume, anywhere. Band-assisted work logs a negative load, so `weight × reps` falls as a
//     lifter gets stronger, and four light sets outrank three heavy ones.
//   · no muscle groups and no taxonomy for one, no streak, no duration axis, and nothing here is a
//     grade — no score, no percentage, nothing green and nothing red.
//   · no dashboard: no volume-by-muscle-group, no fatigue score, no percentile against strangers.
//
// NOTHING HERE COMPUTES A NUMBER THE SERVER DID NOT ALREADY DECIDE. Epley lives in one place per
// language and this is not it: an estimate arrives with the mark or is ABSENT from it, and where it
// is absent the page draws no tile, no bar and no chart frame with a dash in it. That is the whole
// of the bodyweight case — a chin-up at 0 kg and a band-assisted pull-up at −20 have no honest
// one-rep estimate, so they have no e1RM anything.

// A mark and the set that holds it: the two standing bests, every point of the series, and every
// record on the ladder are all this one shape. `e1rm` is present exactly where Epley is defined.
public struct MovementMark: Equatable, Codable, Sendable {
    public let weightKg: Double
    public let reps: Int
    public let atMs: Int64              // the SESSION's start, never the set's own instant
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

// One training day of this movement — the session it was worked in and its sets in performed order,
// warmups already dropped. A warmup counts toward nothing in this product, and a page that listed
// one beside a working set would be showing a ramp-up as work.
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

// EVERY LIST IS OMITTED WHEN EMPTY and every count is always there, so a movement in the catalog
// nobody has ever lifted answers 200 with two zeros and nothing else — which is a real and common
// case, not a failed read. `routineCount` is zero for a movement no program names, and that zero is
// a fact worth printing.
public struct MovementRecord: Equatable, Codable, Sendable {
    public let exercise: Exercise
    public let routineCount: Int
    // WHICH PROGRAMS NAME IT, in program order — the third line of §N's rename proof, and it comes
    // off THIS read rather than a second call, because a sheet that assembled its proof from three
    // requests would be three chances to show a number that was true a moment ago. `routineCount` is
    // exactly this list's length and stays because the page's subhead counts rather than names.
    public let routines: [String]
    public let sessionCount: Int
    public let bestE1rm: MovementMark?
    public let heaviest: MovementMark?
    public let e1rmSeries: [MovementMark]       // oldest first, the last twelve weeks
    public let records: [MovementMark]          // NEWEST first, lifetime
    public let recentDays: [TrainingDay]        // NEWEST first, at most ten

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

// THE PAGE — everything §H draws, decided once and outside a view body. The banked rule this obeys
// is Lift's: a trend computed inside a screen's body is recomputed on every keystroke elsewhere in
// the app, and a cache keyed on a collection's LENGTH goes stale the day a session is edited rather
// than added. There is no cache here at all — the screen asks the log, this shapes the answer once,
// and a second visit asks again.
public enum Record {
    // WHO ANSWERED, and it is not a detail of the transport. Two logs answer this page — the
    // account's and this device's — in the same shape and with different facts in it: the device
    // holds the sets and the account holds the estimates, because Epley lives in one place per
    // language and none of them is Swift. So an absent e1RM means two different things depending on
    // who is speaking, and a page that could not tell them apart would blame a barbell for a wire.
    public enum Source: Equatable, Sendable {
        case theLog
        case thisDevice
    }

    // The answer and who gave it, together, because every screen that reads one needs both.
    public struct Answer: Equatable {
        public let record: MovementRecord
        public let source: Source

        public init(_ record: MovementRecord, from source: Source) {
            self.record = record
            self.source = source
        }
    }

    // WHY THERE IS NO CHART, and the four reasons may not share a sentence — only one of them is a
    // fact about the barbell. A classification rather than the words: the copy belongs to the screen
    // that has the room's voice, and one of these reads differently depending on who is signed in.
    public enum NoChart: Equatable, Sendable {
        case onThisDevice       // the device answered, and it computes no estimate at all
        case neverWorked        // logged, but never in a working set — nothing here counts one
        case unloaded           // every working set at or below zero, where Epley says nothing
        case outsideWindow      // a standing best, and nothing inside the twelve weeks
    }

    // TWELVE WEEKS, and the window is the SERVER'S: `kRecordWindowMs` cuts the series before it is
    // sent, so this NAMES what arrived rather than cutting it a second time. The number is the
    // retired board's own — twelve weeks is what fits across a phone as bars a thumb-width apart —
    // and the web's record page states the same one.
    public static let windowWeeks = 12

    // A tile is a value with the set that made it under it (§H). `under` is not a caption for the
    // number: it is the other half of the fact, and the heaviest tile's is the unit and the reps.
    public struct Tile: Equatable {
        public let caption: String
        public let value: String
        public let under: String
    }

    // WHAT A BAR IS, and it is not a decoration: a session that passed every session before it is
    // lit, and the one holding the standing best is gold — the same gold the log's row and the
    // finish screen use, and at most one of them on the chart.
    public enum Mark: Equatable {
        case best, passed, ordinary
    }

    public struct Bar: Equatable, Identifiable {
        // ITS PLACE IN THE WINDOW, and the id a `ForEach` follows. The INSTANT cannot be one: two
        // sessions can share a start — `start_session` takes a client-supplied instant, so an agent
        // filing two workouts on one moment is an ordinary use of this product's own thesis — and
        // two rows sharing an id in a `ForEach` is undefined behaviour.
        public let id: Int
        public let atMs: Int64
        public let height: Double       // 0…1 across the window's own range
        public let mark: Mark
    }

    // BARS, NOT A LINE: a training log is discrete events, and a line between them implies days that
    // never happened. `opened` and `closed` carry each end's DATE AND ITS VALUE, because a phone has
    // no scrub and no hover and this chart's baseline is not zero — see `bars` below.
    public struct Chart: Equatable {
        public let bars: [Bar]
        public let window: String
        public let opened: String
        public let closed: String
    }

    public struct Row: Equatable, Identifiable {
        public let id: Int              // its place on the ladder, newest first — see `Bar.id`
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
        // What §N's rename sheet proves, decided with everything else on this page: the sheet opens
        // over THIS page and off THIS read, so it never asks the log a second question to answer a
        // question the first answer already held.
        public let proof: [Proof]

        // A movement in the catalog nobody has ever lifted AT ALL — the picker's `never logged`. It
        // is a fact and a common one, and the page says it plainly rather than drawing empty
        // furniture. A movement worked only in drop sets is NOT this: it has days to draw, and this
        // page prints them.
        public var neverLogged: Bool { heaviest == nil && days.isEmpty }
    }

    // `from` is the log unless it is said otherwise, because a `MovementRecord` is the wire's own
    // shape — the device's answer is the exception and it names itself at the one call site that
    // makes one.
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

    // ONE LINE OF §N SCREEN 32'S PROOF — a label and what is true of it.
    public struct Proof: Equatable, Identifiable {
        public let label: String
        public let said: String

        public var id: String { label }
    }

    // THE PROOF THAT NOTHING IS LOST, and every line of it comes off the record read the page behind
    // the sheet has ALREADY made. Not one number here is a constant: a sheet whose whole job is to
    // prove would be asserting something it never checked, on the one screen that cannot afford to.
    //
    // A FACT WITH NOTHING TO SAY IS LEFT OUT rather than printed as a zero. A movement nobody has
    // lifted has no sessions line and no records line; one no program names has no routines line.
    // The block that is left still proves what it claims, and `0 · unchanged` proves nothing.
    //
    // THE ALIAS LINE IS THE LOG'S TO PROMISE. The alias table is per account and the server writes
    // it on the rename — so a page THIS DEVICE answered may not make that promise: a movement still
    // on the shelf is renamed in place, the old name is simply gone, and the picker has nothing to
    // find it by. The absence is an omission, which a device read may make; the line would be an
    // assertion, which it may not.
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

    // `barbell · in 2 routines · 34 sessions` (§H). The equipment is omitted rather than blanked
    // when the catalog row carries none, and a movement in no program says so — zero routines is a
    // real answer to "where does this live in my week", not a missing one.
    private static func subhead(_ record: MovementRecord) -> String {
        var said: [String] = []
        if !record.exercise.equipment.isEmpty { said.append(record.exercise.equipment) }
        said.append(record.routineCount == 0
                        ? "in no routine"
                        : "in \(record.routineCount) routine\(record.routineCount == 1 ? "" : "s")")
        said.append(sessions(record))
        return said.joined(separator: " · ")
    }

    // THE COUNT IS OVER WORKING SETS AND THE DAYS ARE NOT, which is deliberate on both sides of the
    // wire (domain/Record.h states the same difference): every number in this product is over
    // working sets, while a list of what you did that dropped a drop set would be claiming to be
    // complete and not be. So a movement worked only in drops is in the days and in no count — and
    // `never logged` over a page listing what was logged would be the page contradicting itself two
    // lines apart.
    private static func sessions(_ record: MovementRecord) -> String {
        guard record.sessionCount == 0 else { return Readout.sessionCount(record.sessionCount) }
        guard record.recentDays.contains(where: { !$0.sets.isEmpty }) else { return "never logged" }
        return "no working sets"
    }

    // WHY THERE IS NO CHART, decided here for the reason everything else on this page is decided
    // here. The order is the order the facts overrule each other: who answered comes first, because
    // this device computes no estimate for any movement; then the window, because a standing best
    // with nothing recent is a fact about twelve weeks and not about the lift; then whether the
    // movement was ever WORKED, because a page whose every set was a drop has no estimate for a
    // reason that has nothing to do with the load on the bar.
    private static func why(_ record: MovementRecord, from source: Source) -> NoChart {
        guard source == .theLog else { return .onThisDevice }
        guard record.bestE1rm == nil else { return .outsideWindow }
        guard record.sessionCount > 0 else { return .neverWorked }
        return .unloaded
    }

    // No series, no chart — never an empty frame and never a dash where a bar would go. The series
    // arrives empty for the two cases that are one fact: a movement nobody has worked, and one whose
    // every load sits at or below zero, where Epley says nothing at all.
    private static func chart(_ record: MovementRecord) -> Chart? {
        let points = record.e1rmSeries.compactMap { mark in mark.e1rm.map { (mark.atMs, $0) } }
        guard let first = points.first, let last = points.last else { return nil }
        return Chart(bars: bars(points, best: record.bestE1rm?.atMs,
                                passed: Set(record.records.map(\.atMs))),
                     window: "\(windowWeeks) weeks",
                     opened: "\(Readout.date(first.0)) · \(Readout.weight(first.1))",
                     closed: "\(Readout.date(last.0)) · \(Readout.weight(last.1))")
    }

    // THE FLOOR IS A THIRD OF THE WINDOW'S OWN SPAN BELOW ITS LOWEST SESSION, so the quietest week
    // still draws a bar a thumb can see and the arc is the shape of twelve weeks. Measuring from
    // zero is the rule for COUNTS — a count has a true zero and a bar chart on a floating baseline
    // overstates every difference on it — but an e1RM is a mark on a scale nobody starts at, and
    // from zero a whole training block is one flat wall. The price of the floating baseline is paid
    // in the axis line: both ends print their own value, because this surface has no hover.
    //
    // A series that never moved is drawn down the middle rather than pinned to an edge by a
    // divide-by-nothing, and one session is one bar — a chart of a single point is honest.
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

    // ONE SPELLING OF A SET ON THIS PAGE, and the tiles, the ladder and the recent days all read it:
    // a zero load is not a load but the ABSENCE of one, so a chin-up's mark reads as its reps —
    // `Readout.target`'s own rule about a target of zero, in the one other place gym meets it. A
    // band-assisted −20 is a real point on this number line and prints as one.
    private static func effort(_ mark: MovementMark) -> String {
        effort(weightKg: mark.weightKg, reps: mark.reps)
    }

    // A set on a recent day carries its KIND when it is not a working one, exactly as the session
    // read back names it: a drop set counts toward nothing in this product, and one printed like the
    // working sets beside it would be showing a back-off as work.
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
