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

    // Read once on open and retired, never written again.
    private static let legacyFile = "windmill-journal-pages.json"
    // Where its unsent pages wait; no seat opens this name.
    private static let quarantineFile = "windmill-journal-pages-unclaimed.json"

    public init(url: URL) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        entries = (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    // `seat` is the signed-in user's id, nil for nobody signed in. `deviceHolds` is who this device
    // holds a SESSION for — the Keychain's answer, not this seat's.
    public convenience init(seat: String?, in directory: URL = PageCache.deviceDirectory(),
                            deviceHolds: @escaping @autoclosure () -> String? = KeychainSessions().readUser()?.id) {
        PageCache.retireLegacyStore(in: directory, heldBy: deviceHolds)
        if let seat { PageCache.carryOverTheUnprefixedFile(for: seat, in: directory) }
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
        guard let seat else { return "windmill-journal-pages-anon.json" }
        let safe = seat.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
        return "windmill-journal-pages-u.\(safe).json"
    }

    // Delete once no build writing the un-prefixed name is in anybody's hands.
    private static func carryOverTheUnprefixedFile(for seat: String, in directory: URL) {
        let safe = seat.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
        let unprefixed = directory.appendingPathComponent("windmill-journal-pages-\(safe).json")
        guard FileManager.default.fileExists(atPath: unprefixed.path) else { return }
        let theirs = PageCache(url: directory.appendingPathComponent(fileName(forSeat: seat)))
        for (_, entry) in decode(unprefixed) { theirs.store(entry.page, needsPush: entry.needsPush) }
        guard theirs.flush() else { return }
        try? FileManager.default.removeItem(at: unprefixed)
    }

    // Unsent pages go to the seat whose SESSION this device holds, or to quarantine if it holds none.
    // The file is removed only once they have landed, so a refused write is retried on the next open.
    static func retireLegacyStore(in directory: URL, heldBy deviceHolds: () -> String?) {
        let legacy = directory.appendingPathComponent(legacyFile)
        guard let data = try? Data(contentsOf: legacy) else { return }
        let held = (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
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
