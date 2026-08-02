import Foundation
import WindmillPlatform

// The journal's domain, mirroring backend/products/journal/domain/Page.h — the same grouping the
// backend uses (the day, the two optional scales, the page itself in one file) so the two
// statements of one model can be read side by side.

// A calendar day in the writer's own zone. Not an instant: the page for a day is the same page
// whether it is opened at 23:04 or 00:10, and the zone is always the device's, never UTC. The ISO
// shape sorts lexicographically into true date order, so `<` is exactly the canvas order.
public struct LocalDay: Hashable, Comparable, Codable, Sendable, CustomStringConvertible {
    public let iso: String

    public init?(iso: String) {
        guard LocalDay.wellFormed(iso) else { return nil }
        self.iso = iso
    }

    public init(_ date: Date, calendar: Calendar = .current) {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        iso = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    public static func today(calendar: Calendar = .current, now: Date = Date()) -> LocalDay {
        LocalDay(now, calendar: calendar)
    }

    public var description: String { iso }
    public static func < (lhs: LocalDay, rhs: LocalDay) -> Bool { lhs.iso < rhs.iso }

    // Calendar arithmetic, never 86_400_000ms arithmetic: a day is 23 or 25 hours twice a year in
    // most of the world, and a writer's page must not shift on those two nights.
    public func advanced(by days: Int, calendar: Calendar = .current) -> LocalDay {
        guard let date = calendar.date(byAdding: .day, value: days, to: startOfDay(calendar)) else { return self }
        return LocalDay(date, calendar: calendar)
    }

    public func days(since earlier: LocalDay, calendar: Calendar = .current) -> Int {
        calendar.dateComponents([.day], from: earlier.startOfDay(calendar), to: startOfDay(calendar)).day ?? 0
    }

    // The inclusive run of days [from, to], oldest first — the calendar the canvas draws, gaps and
    // all. Empty when the range is inverted, which is what makes an empty history renderable.
    public static func span(from: LocalDay, to: LocalDay, calendar: Calendar = .current) -> [LocalDay] {
        guard from <= to else { return [] }
        var days: [LocalDay] = []
        var cursor = from
        while cursor <= to {
            days.append(cursor)
            cursor = cursor.advanced(by: 1, calendar: calendar)
        }
        return days
    }

    func startOfDay(_ calendar: Calendar = .current) -> Date {
        var parts = DateComponents()
        let pieces = iso.split(separator: "-")
        parts.year = Int(pieces[0])
        parts.month = Int(pieces[1])
        parts.day = Int(pieces[2])
        return calendar.date(from: parts) ?? Date(timeIntervalSince1970: 0)
    }

    private static func wellFormed(_ iso: String) -> Bool {
        let pieces = iso.split(separator: "-")
        guard pieces.count == 3, pieces[0].count == 4, pieces[1].count == 2, pieces[2].count == 2 else { return false }
        guard let month = Int(pieces[1]), let day = Int(pieces[2]), Int(pieces[0]) != nil else { return false }
        return (1...12).contains(month) && (1...31).contains(day)
    }

    public init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let day = LocalDay(iso: text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not a YYYY-MM-DD day: \(text)"))
        }
        self = day
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(iso)
    }
}

// Mood is one hue in five steps — a scale, not five competing colours (canon §10). `none` is the
// unset state: drawn, never counted, never a failure. Energy is the same shape in three steps.
public enum Mood: Int, Codable, Sendable, CaseIterable {
    case none = 0, m1, m2, m3, m4, m5

    // Out of range clamps to none, exactly as the backend does — a bad value can only narrow,
    // never lie about what someone felt.
    public init(clamping value: Int) { self = Mood(rawValue: value) ?? .none }
    public var isSet: Bool { self != .none }
}

public enum Energy: Int, Codable, Sendable, CaseIterable {
    case none = 0, e1, e2, e3

    public init(clamping value: Int) { self = Energy(rawValue: value) ?? .none }
    public var isSet: Bool { self != .none }
}

// How the words arrived. A spoken page carries no audio — transcription happens off the page and
// the audio is discarded; source is the only trace that it was talked, not typed.
public enum Source: String, Codable, Sendable {
    case typed, spoken

    public init(parsing text: String) { self = text == "spoken" ? .spoken : .typed }
}

// The unit of the whole product: one page per local day. `stamp` is the HLC the writing device
// minted and is the sole convergence key — two devices editing the same day converge on the
// greater stamp, last-writer-wins, with no CRDT text and no room.
public struct Page: Equatable, Codable, Sendable {
    public var day: LocalDay
    public var body: String
    public var mood: Mood
    public var energy: Energy
    public var source: Source
    public var stamp: Hlc
    public var updatedAtMs: Int64

    public init(day: LocalDay, body: String = "", mood: Mood = .none, energy: Energy = .none,
                source: Source = .typed, stamp: Hlc = .zero, updatedAtMs: Int64 = 0) {
        self.day = day
        self.body = body
        self.mood = mood
        self.energy = energy
        self.source = source
        self.stamp = stamp
        self.updatedAtMs = updatedAtMs
    }

    // A day the writer touched at all. A page with a mood and no words was still a day someone
    // showed up for, so it is written — and an empty page is a gap, never a failure.
    public var isWritten: Bool { !body.isEmpty || mood.isSet || energy.isSet }

    public var wordCount: Int {
        body.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
    }

    // Last writer wins, by stamp — the single convergence rule, stated once. Ties go to the page
    // already held: an identical stamp means the same write arriving twice, and preferring the
    // incumbent keeps a re-read from looking like a change.
    public static func winner(of incoming: Page, and held: Page?) -> Page {
        guard let held else { return incoming }
        return incoming.stamp > held.stamp ? incoming : held
    }

    enum CodingKeys: String, CodingKey {
        case day, body, mood, energy, source, stamp
        case updatedAtMs = "updatedAt"
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        day = try fields.decode(LocalDay.self, forKey: .day)
        body = try fields.decodeIfPresent(String.self, forKey: .body) ?? ""
        mood = Mood(clamping: try fields.decodeIfPresent(Int.self, forKey: .mood) ?? 0)
        energy = Energy(clamping: try fields.decodeIfPresent(Int.self, forKey: .energy) ?? 0)
        source = Source(parsing: try fields.decodeIfPresent(String.self, forKey: .source) ?? "typed")
        stamp = Hlc(try fields.decodeIfPresent(String.self, forKey: .stamp) ?? "0:0:")
        updatedAtMs = try fields.decodeIfPresent(Int64.self, forKey: .updatedAtMs) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: CodingKeys.self)
        try fields.encode(day, forKey: .day)
        try fields.encode(body, forKey: .body)
        try fields.encode(mood.rawValue, forKey: .mood)
        try fields.encode(energy.rawValue, forKey: .energy)
        try fields.encode(source.rawValue, forKey: .source)
        try fields.encode(stamp, forKey: .stamp)
        try fields.encode(updatedAtMs, forKey: .updatedAtMs)
    }
}
