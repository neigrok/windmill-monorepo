import Foundation

// A stamp is "physicalMs:counter:actor", ordered by milliseconds, then counter, then actor.

public struct Hlc: Comparable, Hashable, Sendable, Codable, CustomStringConvertible {
    public let milliseconds: Int64
    public let counter: Int
    public let actor: String

    public init(milliseconds: Int64, counter: Int, actor: String) {
        self.milliseconds = milliseconds
        self.counter = counter
        self.actor = actor
    }

    // Unparseable text reads as the zero stamp, which loses every race.
    public init(_ text: String) {
        let parts = text.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, let ms = Int64(parts[0]), let count = Int(parts[1]) else {
            self.init(milliseconds: 0, counter: 0, actor: "")
            return
        }
        self.init(milliseconds: ms, counter: count, actor: String(parts[2]))
    }

    public static let zero = Hlc(milliseconds: 0, counter: 0, actor: "")

    public var description: String { "\(milliseconds):\(counter):\(actor)" }

    public static func < (lhs: Hlc, rhs: Hlc) -> Bool {
        if lhs.milliseconds != rhs.milliseconds { return lhs.milliseconds < rhs.milliseconds }
        if lhs.counter != rhs.counter { return lhs.counter < rhs.counter }
        return lhs.actor < rhs.actor
    }

    public init(from decoder: Decoder) throws {
        self.init(try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }
}

// Monotonic: the last minted millisecond is the floor, so a backwards clock jump still mints forward.
public final class HlcClock: @unchecked Sendable {
    private let actor: String
    private let now: @Sendable () -> Int64
    private let lock = NSLock()
    private var lastMilliseconds: Int64 = 0
    private var counter = 0

    public init(actor: String, now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.actor = actor
        self.now = now
    }

    public func mint() -> Hlc {
        lock.withLock {
            let milliseconds = max(now(), lastMilliseconds)
            counter = milliseconds == lastMilliseconds ? counter + 1 : 0
            lastMilliseconds = milliseconds
            return Hlc(milliseconds: milliseconds, counter: counter, actor: actor)
        }
    }

    // Random: two installs must never share a device id.
    public static func deviceActor(defaults: UserDefaults = .standard, key: String = "wm.device.actor") -> String {
        if let existing = defaults.string(forKey: key) { return existing }
        let minted = "d-" + UUID().uuidString.prefix(8).lowercased()
        defaults.set(minted, forKey: key)
        return minted
    }
}
