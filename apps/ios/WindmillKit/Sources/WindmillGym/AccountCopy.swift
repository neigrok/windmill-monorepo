import Foundation

// THE ACCOUNT AS THIS DEVICE LAST READ IT — the program and the picker's last lines, kept under the
// seat that read them. A signed-in phone in a basement connects SIGNED IN (the platform keeps the
// seat through a launch the log never answered), and what it draws is what the log last said:
// account routines and last-sets from here, catalog names from DeviceCatalog's file, the settings
// from LocalLog's shelf. Without this file that phone opened on an empty home over a program it
// had read a hundred times.
//
// It is DeviceCatalog's sibling and follows its rules. WHOSE it is is part of the file — a routine
// is one account's, and a phone lent to the next lifter must not draw the first one's program — so a
// file another seat wrote is let go of unread. Nothing here is the truth: the log is, every read that
// lands overwrites it whole, and nothing is ever REPLAYED out of it — the shelf that replays is
// LocalLog, and this file is never asked what the log has not heard. A file this build cannot read
// opens EMPTY, because an empty program is the worst it was ever allowed to cost.
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

    // Opened under whoever is signed in. Nobody — `nil` — has no account and no copy, and a copy
    // some seat left behind is let go of here rather than drawn under the wrong name.
    public func open(under seat: String?) {
        guard held.seat != seat else { return }
        held = Held(seat: seat)
        flush()
    }

    // The account's routines as last served — never the device's own shelf, which LocalLog holds
    // and the claim replays. Empty is an honest answer only once a read has landed; before that the
    // room draws the shelf alone.
    public var routines: [Routine] { held.routines ?? [] }

    // Nil until a read has landed under this seat: the picker draws no meta rather than telling a
    // lifter of ten years they have never squatted.
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
