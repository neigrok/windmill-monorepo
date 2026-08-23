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

// nil seat is signed out.
    public func open(under seat: String?) {
        guard held.seat != seat else { return }
        held = Held(seat: seat)
        flush()
    }

    public var routines: [Routine] { held.routines ?? [] }

// nil until a read has landed.
    public var lastSets: [LastSet]? { held.lastSets }

    public func hold(routines: [Routine]) {
        guard held.seat != nil, held.routines != routines else { return }
        held.routines = routines
        flush()
    }

    public func hold(lastSets: [LastSet]) {
        guard held.seat != nil, held.lastSets != lastSets else { return }
        held.lastSets = lastSets
        flush()
    }

    private func flush() {
        guard let data = try? JSONEncoder().encode(held) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
