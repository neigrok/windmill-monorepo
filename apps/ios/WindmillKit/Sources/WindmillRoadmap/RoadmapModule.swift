import SwiftUI
import WindmillPlatform

// Roadmap is mounted but not built for this surface: the tree is a hand-rolled WebGL2 renderer with
// a collaborative room behind it, and none of that is ported. So the module says where the product
// does live, in one line, and offers the door.
//
// This is the honest alternative both to omitting the product — which would make the superapp look
// like it has fewer rooms than it has — and to a placeholder screen that implies work is happening
// here when none is.

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

    // The one line it lends the hub. Until the room is built this says where the product works
    // today — the front door must not imply a room that opens onto nothing.
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
