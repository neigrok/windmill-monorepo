import SwiftUI
import WindmillPlatform

// Journal's one seam into the superapp — the native twin of the `journalRoutes` table the web shell
// composes. Everything the product is sits behind this; the shell knows only that a room exists and
// what one line it lends the hub.

public struct JournalModule: ProductModule {
    public let id = "journal"
    public let label = "Journal"
    public let symbol = "note.text"     // the web shell's 'notebook-pen', in this platform's set

    public init() {}

    public func room(_ account: Account) -> AnyView {
        AnyView(JournalRoom(account: account))
    }

    // Read straight off the device rather than the network: the hub is the first frame of a cold
    // launch, and a front door that waited for a round trip would be a front door you wait at.
    public func hubLine(_ account: Account) -> HubLine {
        let today = PageCache().page(on: .today())
        guard let today, today.isWritten else {
            return HubLine(eyebrow: "Tonight", headline: "The cursor's waiting.")
        }
        let words = today.wordCount
        return HubLine(eyebrow: "Tonight",
                       headline: "You've written today.",
                       meta: "\(words) \(words == 1 ? "word" : "words") so far")
    }
}
