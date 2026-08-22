import SwiftUI
import WindmillPlatform

// Journal's one seam into the superapp — the native twin of the `journalRoutes` table the web shell
// composes. Everything the product is sits behind this; the shell knows only that a room exists and
// what one line it lends the hub.

public struct JournalModule: ProductModule {
    public let id = "journal"
    public let label = "Journal"
    public let symbol = "note.text"     // the web shell's 'notebook-pen', in this platform's set

    // Where this device keeps its journal. A parameter because the two reads below open a file, and
    // a test that could not say which file would be reading the simulator's own.
    private let device: URL

    public init(device: URL = PageCache.deviceDirectory()) {
        self.device = device
    }

    // Plain verbs, and journal's own vocabulary: a page, never an "entry" (canon §9 forbids the
    // word). The flow board's "3 entries" is the shell borrowing a word this product doesn't use.
    public let entry = EntryDoor(
        verb: "Write tonight",
        line: "a blank page that remembers",
        made: "Your first page is written.",
        back: "Back to writing"
    )

    public func holdings(_ account: Account) -> Holdings {
        Holdings(count: pages(of: account).pages.filter(\.isWritten).count, noun: "page")
    }

    public func room(_ account: Account) -> AnyView {
        AnyView(JournalRoom(account: account))
    }

    // Read straight off the device rather than the network: the hub is the first frame of a cold
    // launch, and a front door that waited for a round trip would be a front door you wait at.
    public func hubLine(_ account: Account) -> HubLine {
        let today = pages(of: account).page(on: .today())
        guard let today, today.isWritten else {
            return HubLine(eyebrow: "Tonight", headline: "The cursor's waiting.")
        }
        let words = today.wordCount
        return HubLine(eyebrow: "Tonight",
                       headline: "You've written today.",
                       meta: "\(words) \(words == 1 ? "word" : "words") so far")
    }

    // The pages of WHOEVER IS SITTING HERE, and nobody else's. The hub used to open the one unkeyed
    // cache, so a signed-out front door reported the last account's word count, and that tile was
    // the first thing the next person to hold the phone saw (audit MOBILE-1). It obeys the room's
    // rule because it is the same rule: the seat is in the file name, so this read cannot reach
    // another seat's pages even if it wanted to.
    private func pages(of account: Account) -> PageCache {
        PageCache(seat: account.user?.id, in: device)
    }
}
