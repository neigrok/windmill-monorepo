import Foundation

// The device's hybrid logical clock — the mirror of backend platform/domain/Ids.h and of
// web/src/products/journal/hlc.js. It lives in the platform, not in a product, for the same reason
// it lives in platform/domain on the backend: a stamp orders any edit from any device, and knows
// nothing about what was edited.
//
// A stamp is "physicalMs:counter:actor". The counter breaks ties inside one millisecond; the actor
// is a stable per-device id, so two devices can never collide on (ms, counter). Comparison is
// exactly the server's: milliseconds, then counter, then actor as the last resort — which makes
// the winner of a two-device race a fact both sides compute identically rather than a negotiation.

public struct Hlc: Comparable, Hashable, Sendable, Codable, CustomStringConvertible {
    public let milliseconds: Int64
    public let counter: Int
    public let actor: String

    public init(milliseconds: Int64, counter: Int, actor: String) {
        self.milliseconds = milliseconds
        self.counter = counter
        self.actor = actor
    }

    // Anything unparseable reads as the zero stamp rather than throwing: a stamp arrives from
    // storage and from the wire, and a page whose stamp got corrupted must still be readable —
    // it simply loses every race, which is the safe direction to fail in.
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

// Mints this device's stamps. Monotonic by construction: a clock that jumps backwards (a timezone
// change, an NTP correction) can never mint a stamp that loses to one already sent, because the
// last minted millisecond is the floor.
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

    // The device's own id, minted once and kept. Two installs must never share one, so it is
    // random rather than derived from anything the OS might hand two apps alike.
    public static func deviceActor(defaults: UserDefaults = .standard, key: String = "wm.device.actor") -> String {
        if let existing = defaults.string(forKey: key) { return existing }
        let minted = "d-" + UUID().uuidString.prefix(8).lowercased()
        defaults.set(minted, forKey: key)
        return minted
    }
}
