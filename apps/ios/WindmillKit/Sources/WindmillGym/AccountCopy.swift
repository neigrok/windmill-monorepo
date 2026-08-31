import Foundation

// Per-account copy of the last-served program and last-sets.
public final class AccountCopy {
    private struct Held: Codable {
        var seat: String?
        var routines: [Routine]?
        var lastSets: [LastSet]?
    }

    private let url: URL
    private var held: Held
    // The seat this room is open under, which is not the same as the seat the copy was written for.
    private var seat: String?

    public init(url: URL = AccountCopy.defaultURL()) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        held = (try? JSONDecoder().decode(Held.self, from: data)) ?? Held()
    }

    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("windmill-gym-account.json")
    }

    // A nil seat is not a seat: it is the launch before `/v1/me` answers, and the copy waits for its own
    // seat to arrive rather than being thrown away before the first read. A seat that LEAVES — a sign-out
    // under a room already open — takes the copy with it, and another account's arrival replaces it.
    public func open(under seat: String?) {
        let departing = self.seat != nil && seat == nil
        self.seat = seat
        if departing {
            held = Held()
            flush()
            return
        }
        guard let seat, held.seat != seat else { return }
        held = Held(seat: seat)
        flush()
    }

    // Answered for the seat the copy was written for and for nobody else.
    private var mine: Bool { seat != nil && seat == held.seat }

    public var routines: [Routine] { mine ? (held.routines ?? []) : [] }

    // nil until a read has landed.
    public var lastSets: [LastSet]? { mine ? held.lastSets : nil }

    public func hold(routines: [Routine]) {
        guard mine, held.routines != routines else { return }
        held.routines = routines
        flush()
    }

    public func hold(lastSets: [LastSet]) {
        guard mine, held.lastSets != lastSets else { return }
        held.lastSets = lastSets
        flush()
    }

    private func flush() {
        guard let data = try? JSONEncoder().encode(held) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
