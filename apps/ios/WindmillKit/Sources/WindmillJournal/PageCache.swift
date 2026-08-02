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

public final class PageCache {
    public struct Entry: Codable, Equatable {
        public var page: Page
        public var needsPush: Bool
    }

    private let url: URL
    private var entries: [String: Entry]

    public init(url: URL = PageCache.defaultURL()) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        entries = (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("windmill-journal-pages.json")
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

    public func markPushed(_ day: LocalDay, winner: Page) {
        let merged = Page.winner(of: winner, and: entries[day.iso]?.page)
        entries[day.iso] = Entry(page: merged, needsPush: false)
    }

    public func flush() {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
