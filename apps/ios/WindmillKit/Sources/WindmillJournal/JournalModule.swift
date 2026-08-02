import SwiftUI
import WindmillPlatform

// Journal's one seam into the superapp — the native twin of the `journalRoutes` table the web shell
// composes. Everything the product is sits behind this; the app knows only that a room exists.

public struct JournalModule: ProductModule {
    public let id = "journal"
    public let label = "Journal"
    public let symbol = "note.text"     // the web shell's 'notebook-pen', in this platform's set

    public init() {}

    public func room(_ account: Account) -> AnyView {
        AnyView(JournalRoom(account: account))
    }
}
