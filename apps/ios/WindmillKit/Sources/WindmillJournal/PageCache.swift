import Foundation
import WindmillPlatform

// The pages as this device holds them. Canon §11 says offline writing works and says so, and canon
// §2 (auth) says signing in claims what you already wrote rather than gating you from writing it —
// both of those are the same requirement: the device is a real place a page can live, not a cache
// in front of the server.
//
// So every write lands here FIRST and is marked `needsPush`; the network is what happens next, or
// later, or on sign-in. A page loses its mark only when the server has answered with the winner.
// The whole cache is held in memory (a window of days of prose is kilobytes) and flushed to one
// atomic file, so a read during a draw is never disk-bound.
//
// ONE FILE PER SEAT, AND THE SEAT IS IN THE FILE NAME. Pages belong to the account that read or
// wrote them, so a cache is opened for one seat — `windmill-journal-pages-<userId>.json`, or
// `windmill-journal-pages-anon.json` for the writing done while nobody is signed in — and never
// reads another seat's bytes at all. Until 2026-08-22 every page this phone had ever seen lived in
// one unkeyed file: after a sign-out the canvas still showed the previous person's prose, the next
// account to sign in was drawn their days, and the first keystroke PUT them into that account on
// the log (audit MOBILE-1, proven end to end against a live server). A filter over one shared file
// would have closed that only where somebody remembered to write one; a file name closes it
// everywhere — after a crash, after a kill, on a launch that runs no hook at all — because there is
// no path by which one seat's store can read another seat's bytes.
//
// Two things cross a seat, and neither crosses on its own:
//   · the anonymous claim — pages written while nobody was signed in follow the person who signs in
//     (PageStore.carryTheAnonymousClaim), which is the whole promise of the anonymous-first door;
//   · the QUARANTINE — the unsent pages recovered from the old unkeyed file, which no seat opens.

public final class PageCache {
    public struct Entry: Codable, Equatable {
        public var page: Page
        public var needsPush: Bool
    }

    private let url: URL
    private var entries: [String: Entry]

    // The unkeyed file every phone that ran journal before 2026-08-22 still holds. Read once, on the
    // first open under the new code, and retired — never written again. See retireLegacyStore.
    private static let legacyFile = "windmill-journal-pages.json"
    // Where the unsent pages out of that file wait. No seat opens this name: nothing in it is drawn
    // on a canvas or sent anywhere.
    private static let quarantineFile = "windmill-journal-pages-unclaimed.json"

    public init(url: URL) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        entries = (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    // The one door the app opens a cache through. `seat` is the signed-in user's id, or nil for
    // "nobody is signed in" — there is no default, because nothing may open the device tier without
    // naming whose it is.
    //
    // `deviceHolds` is a different question and is only ever asked once, on the upgrade that retires
    // the old unkeyed file: WHO IS THIS DEVICE HOLDING A SESSION FOR — which is the Keychain's
    // answer, not this seat's. It is an autoclosure because on every other open there is no legacy
    // file and the Keychain is never touched.
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

    // The seat's id IS a path component here, so anything that is not plainly an id is dropped from
    // it: a separator or a `..` in that string would open a file in another directory — or another
    // seat's — which is the one thing this whole file exists to make impossible.
    //
    // And an account's id is written under `u.`, exactly as gym's shelves and Android's keys write
    // theirs. Without the prefix the reserved names are only out of reach because account ids happen
    // to be uuids: a seat called `anon` or `unclaimed` would have opened the anonymous file or the
    // quarantine. A prefix makes that structural rather than a fact about id formats.
    static func fileName(forSeat seat: String?) -> String {
        guard let seat else { return "windmill-journal-pages-anon.json" }
        let safe = seat.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
        return "windmill-journal-pages-u.\(safe).json"
    }

    // The un-prefixed per-seat name, written only by builds from inside this wave (2026-08-22, before
    // the prefix landed) — carried over rather than orphaned, because a file nothing opens is a
    // person's pages nothing opens. Delete this once no such build is in anybody's hands.
    private static func carryOverTheUnprefixedFile(for seat: String, in directory: URL) {
        let safe = seat.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
        let unprefixed = directory.appendingPathComponent("windmill-journal-pages-\(safe).json")
        guard FileManager.default.fileExists(atPath: unprefixed.path) else { return }
        let theirs = PageCache(url: directory.appendingPathComponent(fileName(forSeat: seat)))
        for (_, entry) in decode(unprefixed) { theirs.store(entry.page, needsPush: entry.needsPush) }
        guard theirs.flush() else { return }
        try? FileManager.default.removeItem(at: unprefixed)
    }

    // THE UNKEYED FILE, DEALT WITH ONCE. What is in it is unsent prose plus a cached copy of some
    // account's 60-day window, and the file name never said whose — so the question the migration
    // has to answer is who wrote it, and there is exactly one honest source for that: WHOSE SESSION
    // THIS DEVICE IS HOLDING. A phone that still holds a session was being used by that person when
    // it upgraded, and their unsent pages are theirs; they go to their file and are still owed, so
    // the next connect sends them and nobody has to be asked anything.
    //
    // A phone holding NO session cannot say. "Nobody is signed in now" is not "nobody wrote this" —
    // it is just as likely to be the last account's work after a sign-out, which is MOBILE-1 exactly,
    // with the migration doing the leaking. Those pages go to a name no seat opens and wait there
    // for a person's yes.
    //
    // The cached window is dropped either way: it is one range read away from the account it came
    // from, so nothing is lost, and an unattributable copy of somebody's journal is not something to
    // keep on a device that may have changed hands.
    //
    // The legacy file is removed only once the pages have LANDED somewhere. A device that refused
    // the write keeps it, and the next open tries again rather than dropping unsent prose.
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

    // What is waiting in quarantine, oldest first. Reading it is not claiming it: these pages belong
    // to whoever wrote them on this phone before scoping existed, and the only honest way to release
    // one is a person saying so out loud in front of a list of days and word counts. This app has no
    // screen that asks yet — journal has no settings surface here (README: gym reaches its own from
    // a row at the foot of home) — so nothing releases them and nothing may: quarantined and
    // unreachable beats delivered to a stranger.
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

    // Everything written here that the server has not acknowledged — the queue a reconnect or a
    // sign-in drains, oldest first so a claim replays in the order it was lived.
    public var pending: [Page] {
        entries.values.filter(\.needsPush).map(\.page).sorted { $0.day < $1.day }
    }

    // Store a page, keeping whichever stamp is greater. Convergence is decided on the device in
    // exactly the way the server decides it, so a page arriving twice by two routes (a range read
    // and a PUT reply) can never flap.
    @discardableResult
    public func store(_ page: Page, needsPush: Bool) -> Page {
        let held = entries[page.day.iso]
        let winner = Page.winner(of: page, and: held?.page)

        // Whether this device still OWES the server a write. A local edit always owes. An arriving
        // remote page settles the debt only by beating what we were holding — if our unsent page is
        // still the winner, it is still unsent.
        let heldPageSurvived = held?.needsPush == true && winner.stamp == held?.page.stamp
        entries[page.day.iso] = Entry(page: winner, needsPush: needsPush || heldPageSurvived)
        return winner
    }

    // The server has answered for a write we sent. That is just a remote page arriving, so it goes
    // through the one rule above rather than clearing the debt outright — because by the time a
    // reply lands the writer may already have typed something newer, and THAT page is still owed.
    // Clearing it here would drop the last thing someone typed if the app died next.
    public func markPushed(_ day: LocalDay, winner: Page) {
        let held = entries[day.iso]
        // Strictly newer, not "at least as new": the acknowledged write usually comes back with the
        // very stamp we sent, and treating that as unsettled would leave every successful write
        // owed forever and re-push it on every reconnect.
        let newerWriteIsWaiting = held?.needsPush == true && (held?.page.stamp ?? .zero) > winner.stamp
        entries[day.iso] = Entry(page: Page.winner(of: winner, and: held?.page), needsPush: newerWriteIsWaiting)
    }

    // Whether the device took the bytes. The answer is the caller's rather than a courtesy: the
    // legacy migration may only let go of the old file once these pages are somewhere else.
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

    // The anonymous file, emptied — called only once the arriving seat's own file has TAKEN the
    // drafts and flushed them (PageStore.carryTheAnonymousClaim). Deleting first would lose the
    // writing of anyone whose device refused the bytes at exactly that moment.
    public func discard() {
        entries = [:]
        try? FileManager.default.removeItem(at: url)
    }
}
