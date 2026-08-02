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
}
