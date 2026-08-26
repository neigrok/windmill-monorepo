import SwiftUI
import WindmillPlatform

public struct JournalModule: ProductModule {
    public let id = "journal"
    public let label = "Journal"
    public let symbol = "note.text"

    private let device: URL

    public init(device: URL = PageCache.deviceDirectory()) {
        self.device = device
    }

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

    public func hubLine(_ account: Account) -> HubLine {
        let today = pages(of: account).page(on: .today())
        guard let today, today.isWritten else {
            return HubLine(eyebrow: "Tonight", headline: "The cursor’s waiting.")
        }
        let words = today.wordCount
        return HubLine(eyebrow: "Tonight",
                       headline: "You’ve written today.",
                       meta: "\(words) \(words == 1 ? "word" : "words") so far")
    }

    // The seat is in the file name, so a read cannot reach another seat's pages.
    private func pages(of account: Account) -> PageCache {
        PageCache(seat: account.user?.id, in: device)
    }
}
