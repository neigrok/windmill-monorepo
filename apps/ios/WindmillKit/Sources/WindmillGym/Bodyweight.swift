import Foundation
import WindmillPlatform

// A weigh-in is one number on one local calendar day, and the day is its identity: a second write for the same
// `dateLocal` is a correction, decided by `recordedAt` — the newer of the two wins, on the server and on this device.
// Kilograms everywhere; the unit toggle does not convert on this phone, and the room says so in its own words.
public struct BodyweightEntry: Equatable, Codable, Sendable, Identifiable {
    public let dateLocal: String
    public let weightKg: Double
    public let recordedAt: Int64

    public init(dateLocal: String, weightKg: Double, recordedAt: Int64) {
        self.dateLocal = dateLocal
        self.weightKg = weightKg
        self.recordedAt = recordedAt
    }

    public var id: String { dateLocal }

    enum CodingKeys: String, CodingKey {
        case dateLocal, weightKg, recordedAt
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        dateLocal = try fields.decode(String.self, forKey: .dateLocal)
        weightKg = try fields.decode(Double.self, forKey: .weightKg)
        recordedAt = try fields.decodeIfPresent(Int64.self, forKey: .recordedAt) ?? 0
    }

    // Which of two writes for one day stands: the later `recordedAt`, and on a tie the one already held.
    public func supersedes(_ held: BodyweightEntry) -> Bool {
        recordedAt > held.recordedAt
    }
}

public struct BodyweightWrite: Equatable, Encodable, Sendable {
    public let weightKg: Double
    public let recordedAt: Int64

    public init(weightKg: Double, recordedAt: Int64) {
        self.weightKg = weightKg
        self.recordedAt = recordedAt
    }
}

public enum Bodyweight {
    public static let minKg = 20.0
    public static let maxKg = 400.0
    // A line joins two dots only when they are this close; a missed week is the thing worth seeing.
    public static let gapDays = 7

    public static let title = "Bodyweight"
    public static let chip = "Weigh in"
    public static let sheetTitle = "Weigh in"
    public static let save = "Save"
    public static let hint = "comma or point, both read as a decimal"
    public static let notANumber = "That is not a number yet."
    public static let oneDecimalPoint = "One decimal point only."
    public static let outOfBounds = "Between 20 and 400 kg — check the number."
    public static let notAForecast = "A weigh-in is not a forecast — today or earlier."
    public static let gapRule = "no line is drawn across a gap longer than seven days"
    public static let deleteRow = "Delete weigh-in"
    public static let deleteTitle = "Delete this weigh-in?"
    public static let deleteConfirm = "Delete"
    public static let deleteKeep = "Keep it"
    // The settings screen's own words for the unit toggle this phone does not apply.
    public static let drawsKg = "Not on this phone yet — this room still draws kg."
    public static let dateRow = "Date"

    public enum Window: String, CaseIterable, Sendable {
        case ninetyDays = "90 days"
        case all = "All"

        // Printed on the chart, beside the rule, so the window shown is never silent.
        public var printed: String {
            switch self {
            case .ninetyDays: return "last 90 days"
            case .all: return "the whole series"
            }
        }
    }

    // Two decimals at most, trailing zeros stripped: 82.4, 82.45, 82.
    public static func format(_ kg: Double) -> String {
        let rounded = (kg * 100).rounded() / 100
        guard rounded.isFinite else { return "—" }
        if rounded == rounded.rounded() { return String(Int(rounded)) }
        var text = String(format: "%.2f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        return text
    }

    // `82.4 kg · 3 days ago` for the newest weigh-in up to today; nil draws nothing — never a dash, never a zero.
    // A row dated after today (a clock behind the log's, a row another surface let through) is never the reading.
    public static func reading(_ entries: [BodyweightEntry], today: String) -> String? {
        guard let latest = latest(entries, today: today) else { return nil }
        return "\(format(latest.weightKg)) kg · \(ago(latest.dateLocal, today: today))"
    }

    public static func latest(_ entries: [BodyweightEntry], today: String) -> BodyweightEntry? {
        entries.filter { $0.dateLocal <= today }.max { $0.dateLocal < $1.dateLocal }
    }

    public static func ago(_ dateLocal: String, today: String) -> String {
        let days = daysBetween(dateLocal, today) ?? 0
        if days <= 0 { return "today" }
        if days == 1 { return "yesterday" }
        return "\(days) days ago"
    }

    // A weigh-in is what happened: a day after the device's local today is refused at the field and at the store.
    public static func dateRefusal(_ dateLocal: String, today: String) -> String? {
        guard isDateLocal(dateLocal) else { return "could not read that date" }
        return dateLocal > today ? notAForecast : nil
    }

    public struct Reading: Equatable, Sendable {
        public let value: Double?
        public let refusal: String?

        public var isValid: Bool { value != nil }
    }

    // Refusals one at a time, in the order a typist meets them; comma and point both read as the decimal, and a
    // signed number is a number — a negative one is out of bounds, not unreadable.
    public static func read(_ text: String) -> Reading {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalised = raw.replacingOccurrences(of: ",", with: ".")
        guard normalised.filter({ $0 == "." }).count <= 1 else {
            return Reading(value: nil, refusal: oneDecimalPoint)
        }
        let unsigned = normalised.hasPrefix("-") || normalised.hasPrefix("+") ? String(normalised.dropFirst()) : normalised
        guard !unsigned.isEmpty, unsigned.allSatisfy({ $0.isNumber || $0 == "." }),
              let value = Double(normalised), value.isFinite else {
            return Reading(value: nil, refusal: notANumber)
        }
        let rounded = (value * 100).rounded() / 100
        guard rounded >= minKg, rounded <= maxKg else {
            return Reading(value: nil, refusal: outOfBounds)
        }
        return Reading(value: rounded, refusal: nil)
    }

    // ── the local calendar day ─────────────────────────────────────────────────────────────────

    public static func dateLocal(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    // A real date in `YYYY-MM-DD`, or nil: the server refuses anything else and so does the store.
    public static func date(of dateLocal: String, calendar: Calendar = .current) -> Date? {
        let pieces = dateLocal.split(separator: "-", omittingEmptySubsequences: false)
        guard pieces.count == 3, pieces[0].count == 4, pieces[1].count == 2, pieces[2].count == 2,
              let year = Int(pieces[0]), let month = Int(pieces[1]), let day = Int(pieces[2]) else { return nil }
        var parts = DateComponents()
        parts.year = year
        parts.month = month
        parts.day = day
        parts.hour = 12
        guard let made = calendar.date(from: parts) else { return nil }
        let back = calendar.dateComponents([.year, .month, .day], from: made)
        guard back.year == year, back.month == month, back.day == day else { return nil }
        return made
    }

    public static func isDateLocal(_ dateLocal: String) -> Bool {
        date(of: dateLocal) != nil
    }

    // Calendar days from `from` to `to`; nil when either is not a date.
    public static func daysBetween(_ from: String, _ to: String, calendar: Calendar = .current) -> Int? {
        guard let start = date(of: from, calendar: calendar), let end = date(of: to, calendar: calendar) else {
            return nil
        }
        return calendar.dateComponents([.day], from: calendar.startOfDay(for: start),
                                       to: calendar.startOfDay(for: end)).day
    }


    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    // `7 Jul`, spelled rather than localised so a locale cannot reorder it.
    public static func dayMonth(_ dateLocal: String) -> String {
        let pieces = dateLocal.split(separator: "-")
        guard pieces.count == 3, let month = Int(pieces[1]), let day = Int(pieces[2]) else { return dateLocal }
        return "\(day) \(months[max(0, min(11, month - 1))])"
    }

    public static func dayMonthYear(_ dateLocal: String) -> String {
        let pieces = dateLocal.split(separator: "-")
        guard pieces.count == 3, let year = Int(pieces[0]) else { return dateLocal }
        return "\(dayMonth(dateLocal)) \(year)"
    }

    // `Tue 4 Aug`, for a day the sheet has fixed.
    public static func weekdayDayMonth(_ dateLocal: String, calendar: Calendar = .current) -> String {
        guard let day = date(of: dateLocal, calendar: calendar) else { return dateLocal }
        return Readout.day(Int64(day.timeIntervalSince1970 * 1000))
    }

    // ── the chart ──────────────────────────────────────────────────────────────────────────────

    public struct Gap: Equatable, Sendable, Identifiable {
        // The last dot before the gap and the first after it — the same two days web and Android name.
        public let from: String
        public let to: String

        public var id: String { from }
        public var label: String { "no weigh-in · \(Bodyweight.dayMonth(from)) – \(Bodyweight.dayMonth(to))" }
    }

    // A dot per measurement; `runs` are the dots a segment may join, in order; `gaps` are the spans left empty.
    public struct Chart: Equatable, Sendable {
        public let window: Window
        public let points: [BodyweightEntry]
        public let runs: [[BodyweightEntry]]
        public let gaps: [Gap]
        public let low: Double
        public let high: Double

        public var isEmpty: Bool { points.isEmpty }

        // The window and what it holds, printed on the chart: `last 90 days · 12 weigh-ins`.
        public var label: String {
            "\(window.printed) · \(points.count == 1 ? "1 weigh-in" : "\(points.count) weigh-ins")"
        }
    }

    // Ascending, never a day after today; the narrow window is the 90 calendar days ending today.
    public static func windowed(_ entries: [BodyweightEntry], window: Window, today: String) -> [BodyweightEntry] {
        let ascending = entries.filter { $0.dateLocal <= today }.sorted { $0.dateLocal < $1.dateLocal }
        guard window == .ninetyDays else { return ascending }
        return ascending.filter { (daysBetween($0.dateLocal, today) ?? 0) < 90 }
    }

    public static func chart(_ entries: [BodyweightEntry], window: Window, today: String) -> Chart {
        let points = windowed(entries, window: window, today: today)
        var runs: [[BodyweightEntry]] = []
        var gaps: [Gap] = []
        for point in points {
            guard let previous = runs.last?.last else {
                runs.append([point])
                continue
            }
            let apart = daysBetween(previous.dateLocal, point.dateLocal) ?? 0
            if apart <= gapDays {
                runs[runs.count - 1].append(point)
                continue
            }
            gaps.append(Gap(from: previous.dateLocal, to: point.dateLocal))
            runs.append([point])
        }
        let weights = points.map(\.weightKg)
        let least = weights.min() ?? 0
        let most = weights.max() ?? 0
        // The series' own range plus padding, so a kilo of movement is visible and a flat series is not a wall.
        let padding = max(0.5, (most - least) * 0.15)
        return Chart(window: window, points: points, runs: runs, gaps: gaps,
                     low: least - padding, high: most + padding)
    }

    // What the chart screen says when the window holds nothing; nil while it holds a dot.
    public static func emptyWindow(_ chart: Chart) -> String? {
        guard chart.isEmpty else { return nil }
        return chart.window == .ninetyDays ? "no weigh-in in the last 90 days" : "no weigh-in yet"
    }
}
