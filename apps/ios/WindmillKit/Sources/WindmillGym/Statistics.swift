import Foundation

// STATISTICS — the wire shape of `GET /v1/gym/stats` and the one rule that turns it into something a
// phone can draw. The native twin of backend/products/gym/domain/Statistics.h, and its list of
// REFUSALS is the load-bearing half:
//
//   · no volume, anywhere. Band-assisted work logs a negative load, so `weight × reps` falls as a
//     lifter gets stronger, and four light sets outrank three heavy ones.
//   · no muscle groups and no taxonomy for one. Pattern is the only classification gym has and it is
//     single-valued on purpose; a bench set counted into chest AND triceps is the bug the schema was
//     written against.
//   · no streak, no cardio, no duration axis, and nothing here is a grade — no score, no percentage,
//     nothing green and nothing red. Every line below is a fact with a direction, which is the finish
//     screen's rule applied to a longer window.
//
// Nothing in this file computes a number the server did not already decide. Epley lives in one place
// per language and this is not it: an estimate arrives with the point or is absent from it.

public struct TrainingWeek: Equatable, Codable, Sendable, Identifiable {
    public let startedAtMs: Int64
    public let sessions: Int
    public let workingSets: Int

    public init(startedAtMs: Int64, sessions: Int, workingSets: Int) {
        self.startedAtMs = startedAtMs
        self.sessions = sessions
        self.workingSets = workingSets
    }

    public var id: Int64 { startedAtMs }

    enum CodingKeys: String, CodingKey {
        case sessions, workingSets
        case startedAtMs = "startedAt"
    }
}

// One session's top working set of one movement. `e1rm` is absent exactly where Epley is undefined —
// a chin-up at 0 kg and a band-assisted pull-up at −20 have no honest one-rep estimate — so a
// movement Epley cannot speak for is drawn on its loads, or on its reps when the load never moves
// either (`Stats.Axis`), rather than on a line of invented numbers.
public struct MovementPoint: Equatable, Codable, Sendable {
    public let atMs: Int64
    public let weightKg: Double
    public let reps: Int
    public let e1rm: Double?

    public init(atMs: Int64, weightKg: Double, reps: Int, e1rm: Double? = nil) {
        self.atMs = atMs
        self.weightKg = weightKg
        self.reps = reps
        self.e1rm = e1rm
    }

    enum CodingKeys: String, CodingKey {
        case weightKg, reps, e1rm
        case atMs = "at"
    }
}

// A standing best and the set that holds it — the prior halves of the finish screen's record rules,
// asked with no session to compare against. There is no third one: "more reps at a load you have
// used before" is a comparison, and with nothing to compare against every mark already IS the best
// reps ever done at its load.
public struct MovementBest: Equatable, Codable, Sendable {
    public let weightKg: Double
    public let reps: Int
    public let atMs: Int64
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

// `bestE1rm` is chosen BY having an estimate, so its own is always there; `heaviest` is chosen by
// load, so a bodyweight movement's carries none.
public struct MovementProgress: Equatable, Codable, Sendable, Identifiable {
    public let exerciseId: String
    public let lastTrainedAtMs: Int64
    public let points: [MovementPoint]
    public let bestE1rm: MovementBest?
    public let heaviest: MovementBest?

    public init(exerciseId: String, lastTrainedAtMs: Int64, points: [MovementPoint] = [],
                bestE1rm: MovementBest? = nil, heaviest: MovementBest? = nil) {
        self.exerciseId = exerciseId
        self.lastTrainedAtMs = lastTrainedAtMs
        self.points = points
        self.bestE1rm = bestE1rm
        self.heaviest = heaviest
    }

    public var id: String { exerciseId }

    enum CodingKeys: String, CodingKey {
        case exerciseId, points, bestE1rm, heaviest
        case lastTrainedAtMs = "lastTrainedAt"
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        exerciseId = try fields.decode(String.self, forKey: .exerciseId)
        lastTrainedAtMs = try fields.decodeIfPresent(Int64.self, forKey: .lastTrainedAtMs) ?? 0
        points = try fields.decodeIfPresent([MovementPoint].self, forKey: .points) ?? []
        bestE1rm = try fields.decodeIfPresent(MovementBest.self, forKey: .bestE1rm)
        heaviest = try fields.decodeIfPresent(MovementBest.self, forKey: .heaviest)
    }
}

// Weeks run Monday to Monday in UTC and arrive contiguous — a week nobody trained is present and
// zero, because the gap is the fact. They span the first trained week to the LAST TRAINED one, which
// is not necessarily the week the reader is standing in, so nothing here is ever labelled "this
// week": the span prints the dates it actually holds.
public struct TrainingStatistics: Equatable, Codable, Sendable {
    public let weeks: [TrainingWeek]
    public let movements: [MovementProgress]

    public init(weeks: [TrainingWeek] = [], movements: [MovementProgress] = []) {
        self.weeks = weeks
        self.movements = movements
    }

    enum CodingKeys: String, CodingKey {
        case weeks, movements
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        weeks = try fields.decodeIfPresent([TrainingWeek].self, forKey: .weeks) ?? []
        movements = try fields.decodeIfPresent([MovementProgress].self, forKey: .movements) ?? []
    }
}

// THE BOARD — everything the statistics screen draws, decided once, outside a view body. The banked
// rule this obeys is Lift's: a trend computed inside a landing screen's body is recomputed on every
// keystroke elsewhere in the app, and a cache keyed on a collection's LENGTH goes stale the day a
// session is edited rather than added. There is no cache here at all — the screen asks the log, this
// shapes the answer once, and a second visit asks again.
public enum Stats {
    // One row of bars, normalised to ITS OWN peak and never to a shared axis: sessions and working
    // sets are counts of different things, and one axis across both is the chart that made Lift's
    // progress tab unreadable. The peak travels with the row because a phone has no hover and no
    // scrub — without it a bar's height means nothing at all.
    public struct Series: Equatable {
        public let label: String
        public let peak: String
        public let heights: [Double]        // 0…1, one per week, oldest first
    }

    public struct Weeks: Equatable {
        public let sets: Series
        public let sessions: Series
        public let span: String
    }

    // WHICH AXIS A MOVEMENT'S LINE IS DRAWN ON, decided by the data and never by a setting — the
    // native statement of stats.js `axisOf`/`valueOf`, tested in the order the web tests it. Three
    // cases, and the third is the one a chin-up needs:
    //   · every point carries an estimate — the line is e1RM, the movement's own strength curve
    //   · an estimate is missing somewhere but the load MOVES — the line is the top set's load, the
    //     honest axis across the assisted → bodyweight → weighted crossing that left Epley undefined
    //   · the load never moves — then the load is not the story and the reps are. A point is already
    //     the heaviest set of its session, ties going to more reps, so at one fixed load the top set
    //     IS the best set of reps at it, and drawing the load would be drawing a constant.
    enum Axis: Equatable {
        case e1rm, load, reps

        init(of points: [MovementPoint]) {
            if !points.isEmpty, points.allSatisfy({ $0.e1rm != nil }) {
                self = .e1rm
                return
            }
            if Set(points.map(\.weightKg)).count > 1 {
                self = .load
                return
            }
            self = .reps
        }

        var unit: String {
            switch self {
            case .e1rm: return "e1RM"
            case .load: return "load"
            case .reps: return "reps"
            }
        }

        // The estimate cannot be missing on the axis that was chosen BY every point having one, so
        // the fallback is unreachable — and a zero there would be a number nobody lifted rather than
        // a crash on the statistics screen.
        func value(of point: MovementPoint) -> Double {
            switch self {
            case .e1rm: return point.e1rm ?? 0
            case .load: return point.weightKg
            case .reps: return Double(point.reps)
            }
        }
    }

    // One movement's line. `unit` names which of the three the axis picked, because they are not the
    // same fact and a reader who is not told reads a chin-up's 8 → 12 as kilograms.
    public struct Line: Equatable, Identifiable {
        public let id: String
        public let movement: String
        public let value: String
        public let unit: String
        public let lastTrained: String
        public let heights: [Double]        // 0…1, oldest first
        public let span: String
        public let bests: [String]
    }

    public struct Board: Equatable {
        public let weeks: Weeks?
        public let lines: [Line]

        public var isEmpty: Bool { weeks == nil && lines.isEmpty }
    }

    // Twelve weeks is what fits across a phone as bars a thumb-width apart. The window is taken off
    // the END of the series — the recent weeks are the ones a lifter is asking about — and the span
    // line prints the two dates it landed on rather than claiming a period.
    public static let weeksShown = 12

    public static func board(_ statistics: TrainingStatistics, catalog: [Exercise],
                             now: Int64, weeksShown: Int = Stats.weeksShown) -> Board {
        Board(weeks: weeks(statistics.weeks, showing: weeksShown),
              lines: statistics.movements.compactMap { line($0, catalog: catalog, now: now) })
    }

    static func weeks(_ weeks: [TrainingWeek], showing limit: Int) -> Weeks? {
        let shown = Array(weeks.suffix(max(0, limit)))
        guard let first = shown.first, let last = shown.last else { return nil }
        return Weeks(
            sets: series("Working sets", shown.map(\.workingSets)),
            sessions: series("Sessions", shown.map(\.sessions)),
            span: shown.count == 1
                ? "1 week · \(Readout.day(first.startedAtMs, utc: true))"
                : "\(shown.count) weeks · \(Readout.day(first.startedAtMs, utc: true)) → \(Readout.day(last.startedAtMs, utc: true))"
        )
    }

    // Bars are counts, so they are measured FROM ZERO — a bar chart on a floating baseline overstates
    // every difference on it. A week with nothing in it draws no bar at all, which is what makes a
    // gap read as a gap against the baseline rule under the row.
    private static func series(_ label: String, _ values: [Int]) -> Series {
        let peak = values.max() ?? 0
        guard peak > 0 else { return Series(label: label, peak: "peak 0", heights: values.map { _ in 0 }) }
        return Series(label: label, peak: "peak \(peak)",
                      heights: values.map { Double($0) / Double(peak) })
    }

    static func line(_ movement: MovementProgress, catalog: [Exercise], now: Int64) -> Line? {
        // The server builds a movement out of its points, so one with none cannot arrive. A line with
        // nothing to draw is left out rather than drawn as an empty frame with a name over it.
        guard !movement.points.isEmpty else { return nil }
        let axis = Axis(of: movement.points)
        let values = movement.points.map(axis.value(of:))

        return Line(
            id: movement.exerciseId,
            movement: Readout.movement(movement.exerciseId, in: catalog),
            value: Readout.weight(values[values.count - 1]),
            unit: axis.unit,
            lastTrained: "trained \(Readout.ago(movement.lastTrainedAtMs, now: now))",
            heights: normalised(values),
            span: span(values),
            bests: bests(movement.bestE1rm, movement.heaviest)
        )
    }

    // A LINE is normalised to its own min and max, where a bar row is normalised from zero: a
    // progression from 82.5 to 96.9 drawn against a zero baseline is a flat line, and the whole
    // content of a sparkline is the shape. A movement that has never moved is honestly flat, drawn
    // down the middle rather than pinned to one edge by a divide-by-nothing.
    private static func normalised(_ values: [Double]) -> [Double] {
        guard let low = values.min(), let high = values.max() else { return [] }
        guard high > low else { return values.map { _ in 0.5 } }
        return values.map { ($0 - low) / (high - low) }
    }

    // The two endpoints, which is everything a sparkline says on a surface with no hover — and a
    // direction rather than a delta, because a delta is one subtraction away from a score.
    private static func span(_ values: [Double]) -> String {
        let count = Readout.sessionCount(values.count)
        guard values.count > 1 else { return "\(count) · \(Readout.weight(values[0]))" }
        return "\(count) · \(Readout.weight(values[0])) → \(Readout.weight(values[values.count - 1]))"
    }

    // ONE SET OFTEN HOLDS BOTH MARKS — a lifter adding 2.5 kg a week tops their estimate and their
    // load on the same set every time — so the common case is one line and not two saying the same
    // day twice. A zero load is not a load: a chin-up's best reads as its reps, which is the finish
    // screen's own rule about the absence of a weight.
    private static func bests(_ bestE1rm: MovementBest?, _ heaviest: MovementBest?) -> [String] {
        if let best = bestE1rm, let estimate = best.e1rm, let load = heaviest, sameSet(best, load) {
            return ["best \(effort(best)) · e1RM \(Readout.weight(estimate)) kg · \(Readout.day(best.atMs))"]
        }
        var lines: [String] = []
        if let best = bestE1rm, let estimate = best.e1rm {
            lines.append("best e1RM \(Readout.weight(estimate)) kg · \(effort(best)) · \(Readout.day(best.atMs))")
        }
        if let load = heaviest {
            lines.append("heaviest \(effort(load)) · \(Readout.day(load.atMs))")
        }
        return lines
    }

    private static func sameSet(_ left: MovementBest, _ right: MovementBest) -> Bool {
        left.weightKg == right.weightKg && left.reps == right.reps && left.atMs == right.atMs
    }

    private static func effort(_ best: MovementBest) -> String {
        guard best.weightKg != 0 else { return "\(best.reps) reps" }
        return Readout.effort(weightKg: best.weightKg, reps: best.reps)
    }
}
