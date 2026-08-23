import Foundation
import WindmillPlatform

// A calendar day in the device's own zone, never UTC; the ISO text sorts into date order.
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

    // Calendar arithmetic, never fixed milliseconds: a day is 23 or 25 hours twice a year.
    public func advanced(by days: Int, calendar: Calendar = .current) -> LocalDay {
        guard let date = calendar.date(byAdding: .day, value: days, to: startOfDay(calendar)) else { return self }
        return LocalDay(date, calendar: calendar)
    }

    // Floored at a second so an early wake cannot spin.
    public static func untilTomorrow(now: Date = Date(), calendar: Calendar = .current) -> TimeInterval {
        let midnight = LocalDay(now, calendar: calendar).advanced(by: 1, calendar: calendar).startOfDay(calendar)
        return max(midnight.timeIntervalSince(now), 1)
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

// Both scales are 0...10 where 0 is a real answer; `nil` is the unanswered state, stored as SQL NULL.
// Out of range narrows to nil rather than being rejected — a storage typo must not lose the page.
public enum Scale {
    public static func narrow(_ value: Int?) -> Int? {
        guard let value, (0...10).contains(value) else { return nil }
        return value
    }

    // The strip records eleven; every read-only glyph reads five bands of mood and three of energy.
    public static func moodBand(_ score: Int) -> Int {
        switch score {
        case ...1: return 1
        case 2, 3: return 3
        case 4, 5, 6: return 5
        case 7, 8: return 7
        default: return 9
        }
    }

    public static func energyBars(_ score: Int) -> Int {
        switch score {
        case ...3: return 0
        case 4, 5, 6: return 1
        case 7, 8: return 2
        default: return 3
        }
    }
}

// A spoken page carries no audio; source is the only trace it was talked.
public enum Source: String, Codable, Sendable {
    case typed, spoken

    public init(parsing text: String) { self = text == "spoken" ? .spoken : .typed }
}

// One page per local day; `stamp` is the sole convergence key, greater stamp wins.
public struct Page: Equatable, Codable, Sendable {
    public var day: LocalDay
    public var body: String
    public var mood: Int?
    public var energy: Int?
    public var source: Source
    public var stamp: Hlc
    public var updatedAtMs: Int64

    public init(day: LocalDay, body: String = "", mood: Int? = nil, energy: Int? = nil,
                source: Source = .typed, stamp: Hlc = .zero, updatedAtMs: Int64 = 0) {
        self.day = day
        self.body = body
        self.mood = Scale.narrow(mood)
        self.energy = Scale.narrow(energy)
        self.source = source
        self.stamp = stamp
        self.updatedAtMs = updatedAtMs
    }

    // A mood with no words still counts as written, and a recorded zero is a mood.
    public var isWritten: Bool { !body.isEmpty || mood != nil || energy != nil }

    public var wordCount: Int {
        body.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
    }

    // Ties keep the page already held.
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
        // The contract narrows, it never rejects — and narrowing has to happen at the container, because
        // a decimal, a string or a bool throws before `Scale.narrow` is ever reached, and a throw here
        // costs the reader the whole document: every other page in a list, every other day in a cache.
        mood = Scale.narrow((try? fields.decodeIfPresent(Int.self, forKey: .mood)) ?? nil)
        energy = Scale.narrow((try? fields.decodeIfPresent(Int.self, forKey: .energy)) ?? nil)
        source = Source(parsing: try fields.decodeIfPresent(String.self, forKey: .source) ?? "typed")
        stamp = Hlc(try fields.decodeIfPresent(String.self, forKey: .stamp) ?? "0:0:")
        updatedAtMs = try fields.decodeIfPresent(Int64.self, forKey: .updatedAtMs) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: CodingKeys.self)
        try fields.encode(day, forKey: .day)
        try fields.encode(body, forKey: .body)
        try fields.encode(mood, forKey: .mood)
        try fields.encode(energy, forKey: .energy)
        try fields.encode(source.rawValue, forKey: .source)
        try fields.encode(stamp, forKey: .stamp)
        try fields.encode(updatedAtMs, forKey: .updatedAtMs)
    }
}
