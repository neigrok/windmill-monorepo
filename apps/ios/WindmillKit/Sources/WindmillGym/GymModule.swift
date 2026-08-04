import SwiftUI
import WindmillPlatform

// Gym is mounted and its first real rule already lives here (Ladder.swift, pinned to
// packages/api-contract/gym-ladder.json) — but the phone is where the OPEN SESSION is meant to be
// logged, and that logger is not built. Claiming a room before it can take a set would be the
// dishonest half of shipping early, so the module says what it is instead.

public struct GymModule: ProductModule {
    public let id = "gym"
    public let label = "Gym"
    public let symbol = "figure.strengthtraining.traditional"

    public init() {}

    public var presence: Presence {
        .elsewhere(
            url: URL(string: "https://windmill.works/#/gym")!,
            line: "The log is on the web. Logging a session from your phone is next, and isn't built yet."
        )
    }

    public func room(_ account: Account) -> AnyView {
        AnyView(ElsewhereRoom(product: self))
    }

    // The one line it lends the hub. Until the room is built this says where the product works
    // today — the front door must not imply a room that opens onto nothing.
    public func hubLine(_ account: Account) -> HubLine {
        HubLine(eyebrow: "The log", headline: "Your log is on the web.", meta: "not on the phone yet")
    }

    public let entry = EntryDoor(
        verb: "Log a workout",
        line: "sets and weights, two taps each",
        made: "Your first session is logged.",
        back: "Back to the log"
    )
}
