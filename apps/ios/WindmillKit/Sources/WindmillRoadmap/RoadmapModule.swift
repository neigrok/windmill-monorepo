import SwiftUI
import WindmillPlatform

public struct RoadmapModule: ProductModule {
    public let id = "roadmap"
    public let label = "Roadmap"
    public let symbol = "point.3.connected.trianglepath.dotted"

    public init() {}

    public var presence: Presence {
        .elsewhere(
            url: URL(string: "https://windmill.works/#/")!,
            line: "Your trees are on the web. The tree canvas isn't built for the phone yet."
        )
    }

    public func room(_ account: Account) -> AnyView {
        AnyView(ElsewhereRoom(product: self))
    }

    public func hubLine(_ account: Account) -> HubLine {
        HubLine(eyebrow: "Next up", headline: "Your trees are on the web.", meta: "not on the phone yet")
    }

    public let entry = EntryDoor(
        verb: "Plan something big",
        line: "a goal, broken into steps you can see",
        made: "Your tree is planted.",
        back: "Back to my tree"
    )
}
