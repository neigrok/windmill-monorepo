import Foundation
import WindmillPlatform

// One file per seat, the seat in the file name, so no seat's store can read another seat's bytes.
// Every write lands here marked `needsPush` and loses the mark only once the server answers.

public final class PageCache {
    public struct Entry: Codable, Equatable {
        public var page: Page
        public var needsPush: Bool
    }

    private let url: URL
    private var entries: [String: Entry]

    // Bumped when the shape of a stored page changes. v1 held mood 1...5 / energy 1...3 with 0
    // meaning unset; v2 holds 0...10 with null meaning unset, so a v1 file read as v2 would report
    // every unanswered scale as a recorded zero. Old files are read once, migrated, and removed.
    private static let version = "v2"
    // Read once on open and retired, never written again.
    private static let legacyFile = "windmill-journal-pages.json"
    // Where its unsent pages wait; no seat opens this name.
    private static let quarantineFile = "windmill-journal-pages-\(version)-unclaimed.json"
    // The same store under its v1 name. Nothing reads it after the bump, so it is carried over whole.
    private static let version1QuarantineFile = "windmill-journal-pages-unclaimed.json"

    public init(url: URL) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        entries = (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    // `seat` is the signed-in user's id, nil for nobody signed in. `deviceHolds` is who this device
    // holds a SESSION for — the Keychain's answer, not this seat's.
    public convenience init(seat: String?, in directory: URL = PageCache.deviceDirectory(),
                            deviceHolds: @escaping @autoclosure () -> String? = KeychainSessions().readUser()?.id) {
        PageCache.carryQuarantineForward(in: directory)
        PageCache.retireLegacyStore(in: directory, heldBy: deviceHolds)
        PageCache.carryVersion1Forward(for: seat, in: directory)
        self.init(url: directory.appendingPathComponent(PageCache.fileName(forSeat: seat)))
    }

    public static func deviceDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    // The seat id is a path component: anything not plainly an id is dropped, or a separator or `..`
    // opens another seat's file. The `u.` prefix keeps a seat named `anon` or `unclaimed` off those files.
    static func fileName(forSeat seat: String?) -> String {
        guard let seat else { return "windmill-journal-pages-\(version)-anon.json" }
        return "windmill-journal-pages-\(version)-u.\(safe(seat)).json"
    }

    private static func safe(_ seat: String) -> String {
        seat.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    // The names this seat wore before the version bump, newest first. Both are read once, migrated
    // onto the 0...10 scales, folded into the v2 file, and removed.
    private static func version1Files(forSeat seat: String?) -> [String] {
        guard let seat else { return ["windmill-journal-pages-anon.json"] }
        return ["windmill-journal-pages-u.\(safe(seat)).json", "windmill-journal-pages-\(safe(seat)).json"]
    }

    // Quarantine is the one store designed never to lose a page, so the version bump migrates it rather
    // than orphaning it. Days already waiting in v2 keep their bytes; the v1 file goes only once it landed.
    static func carryQuarantineForward(in directory: URL) {
        let source = directory.appendingPathComponent(version1QuarantineFile)
        guard FileManager.default.fileExists(atPath: source.path) else { return }
        let quarantine = directory.appendingPathComponent(quarantineFile)
        var waiting = decode(quarantine)
        for (day, entry) in decodeVersion1(source) where waiting[day] == nil { waiting[day] = entry }
        guard let encoded = try? JSONEncoder().encode(waiting) else { return }
        do {
            try encoded.write(to: quarantine, options: .atomic)
        } catch {
            return
        }
        try? FileManager.default.removeItem(at: source)
    }

    private static func carryVersion1Forward(for seat: String?, in directory: URL) {
        let sources = version1Files(forSeat: seat)
            .map(directory.appendingPathComponent)
            .filter { FileManager.default.fileExists(atPath: $0.path) }
        guard !sources.isEmpty else { return }

        let theirs = PageCache(url: directory.appendingPathComponent(fileName(forSeat: seat)))
        for source in sources {
            for (_, entry) in decodeVersion1(source) { theirs.store(entry.page, needsPush: entry.needsPush) }
        }
        guard theirs.flush() else { return }
        for source in sources { try? FileManager.default.removeItem(at: source) }
    }

    // Unsent pages go to the seat whose SESSION this device holds, or to quarantine if it holds none.
    // The file is removed only once they have landed, so a refused write is retried on the next open.
    static func retireLegacyStore(in directory: URL, heldBy deviceHolds: () -> String?) {
        let legacy = directory.appendingPathComponent(legacyFile)
        guard let data = try? Data(contentsOf: legacy) else { return }
        let held = migrated((try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:])
        let owed = held.filter { $0.value.needsPush }

        guard keep(owed, in: directory, heldBy: deviceHolds()) else { return }
        try? FileManager.default.removeItem(at: legacy)
    }

    private static func keep(_ owed: [String: Entry], in directory: URL, heldBy seat: String?) -> Bool {
        guard let seat else {
            let quarantine = directory.appendingPathComponent(quarantineFile)
            var waiting = decode(quarantine)
            for (day, entry) in owed where waiting[day] == nil { waiting[day] = entry }
            guard let encoded = try? JSONEncoder().encode(waiting) else { return false }
            do {
                try encoded.write(to: quarantine, options: .atomic)
            } catch {
                return false
            }
            return true
        }
        let theirs = PageCache(url: directory.appendingPathComponent(fileName(forSeat: seat)))
        for entry in owed.values { theirs.store(entry.page, needsPush: true) }
        return theirs.flush()
    }

    // Reading is not claiming: nothing releases these to a seat without a person saying so.
    public static func quarantinedPages(in directory: URL = PageCache.deviceDirectory()) -> [Page] {
        decode(directory.appendingPathComponent(quarantineFile))
            .values.map(\.page).sorted { $0.day < $1.day }
    }

    private static func decode(_ url: URL) -> [String: Entry] {
        let data = (try? Data(contentsOf: url)) ?? Data()
        return (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    private static func decodeVersion1(_ url: URL) -> [String: Entry] {
        migrated(decode(url))
    }

    // The same mapping the server migration runs: v1's five mood steps land on the odd positions of
    // the new ramp, v1's three energy steps on the centre of each third, and both zeroes on unset.
    private static func migrated(_ entries: [String: Entry]) -> [String: Entry] {
        entries.mapValues { entry in
            var page = entry.page
            page.mood = page.mood.flatMap { (1...5).contains($0) ? 2 * $0 - 1 : nil }
            page.energy = page.energy.flatMap { [1: 2, 2: 5, 3: 8][$0] }
            return Entry(page: page, needsPush: entry.needsPush)
        }
    }

    public var pages: [Page] {
        entries.values.map(\.page).sorted { $0.day < $1.day }
    }

    public func page(on day: LocalDay) -> Page? {
        entries[day.iso]?.page
    }

    // Oldest first, so a claim replays in order.
    public var pending: [Page] {
        entries.values.filter(\.needsPush).map(\.page).sorted { $0.day < $1.day }
    }

    // Keeps whichever stamp is greater, as the server decides it.
    @discardableResult
    public func store(_ page: Page, needsPush: Bool) -> Page {
        let held = entries[page.day.iso]
        let winner = Page.winner(of: page, and: held?.page)

        // A local edit always owes; a remote page settles the debt only by beating what was held.
        let heldPageSurvived = held?.needsPush == true && winner.stamp == held?.page.stamp
        entries[page.day.iso] = Entry(page: winner, needsPush: needsPush || heldPageSurvived)
        return winner
    }

    // An ack must not clear the debt outright: a newer local write may be waiting and is still owed.
    public func markPushed(_ day: LocalDay, winner: Page) {
        let held = entries[day.iso]
        // Strictly newer, not "at least as new": an ack usually returns the stamp just sent.
        let newerWriteIsWaiting = held?.needsPush == true && (held?.page.stamp ?? .zero) > winner.stamp
        entries[day.iso] = Entry(page: Page.winner(of: winner, and: held?.page), needsPush: newerWriteIsWaiting)
    }

    // Answers whether the device took the bytes.
    @discardableResult
    public func flush() -> Bool {
        guard let data = try? JSONEncoder().encode(entries) else { return false }
        do {
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    // Call only once the arriving seat's file has taken the drafts and flushed them.
    public func discard() {
        entries = [:]
        try? FileManager.default.removeItem(at: url)
    }
}
