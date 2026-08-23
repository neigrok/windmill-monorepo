import SwiftUI

// Product-neutral: nothing here may name a product.

@MainActor
public protocol ProductModule {
    var id: String { get }
    var label: String { get }
    var symbol: String { get }          // SF Symbol, for the switcher
    var presence: Presence { get }

    func room(_ account: Account) -> AnyView

    func hubLine(_ account: Account) -> HubLine

    var entry: EntryDoor { get }

    func holdings(_ account: Account) -> Holdings
}

public struct EntryDoor {
    public let verb: String     // "Write tonight"
    public let line: String     // "a blank page that remembers"
    public let made: String     // "Your first page is written."
    public let back: String     // "Back to writing"

    // What this room needs before it can be worked in; nil opens straight onto work.
    public let caveat: String?

    public init(verb: String, line: String, made: String, back: String, caveat: String? = nil) {
        self.verb = verb
        self.line = line
        self.made = made
        self.back = back
        self.caveat = caveat
    }
}

public struct Holdings: Equatable {
    public let count: Int
    public let noun: String

    public init(count: Int, noun: String) {
        self.count = count
        self.noun = noun
    }

    public static let none = Holdings(count: 0, noun: "")
    public var isEmpty: Bool { count == 0 }

    // Naive pluralisation: every noun takes a plain -s.
    public var phrase: String { "\(count) \(noun)\(count == 1 ? "" : "s")" }
}

public struct HubLine {
    public let eyebrow: String          // "Next up", "Tonight", "Session running"
    public let headline: String
    public let meta: String?
    public let running: Bool

    public init(eyebrow: String, headline: String, meta: String? = nil, running: Bool = false) {
        self.eyebrow = eyebrow
        self.headline = headline
        self.meta = meta
        self.running = running
    }
}

public struct ShellActions {
    public var openYou: () -> Void = {}
    public var openSwitcher: () -> Void = {}
    public var goHome: () -> Void = {}

    public init(openYou: @escaping () -> Void = {}, openSwitcher: @escaping () -> Void = {},
                goHome: @escaping () -> Void = {}) {
        self.openYou = openYou
        self.openSwitcher = openSwitcher
        self.goHome = goHome
    }
}

// A room's current skin, so the shell capsule laid over it can be dressed to match.
public struct RoomChromePreference: PreferenceKey {
    public static let defaultValue = ColorScheme.light
    public static func reduce(value: inout ColorScheme, nextValue: () -> ColorScheme) {
        value = nextValue()
    }
}

public extension View {
    func roomChrome(_ scheme: ColorScheme) -> some View {
        preference(key: RoomChromePreference.self, value: scheme)
    }
}

private struct ShellActionsKey: EnvironmentKey {
    static let defaultValue = ShellActions()
}

public extension EnvironmentValues {
    var shellActions: ShellActions {
        get { self[ShellActionsKey.self] }
        set { self[ShellActionsKey.self] = newValue }
    }
}

// `.elsewhere` products have no room on this device, but stay mounted and listed.
public enum Presence {
    case here
    case elsewhere(url: URL, line: String)
}

public extension ProductModule {
    var presence: Presence { .here }

    func holdings(_ account: Account) -> Holdings { .none }

    // From `presence` when the room lives on another surface, else from `entry`.
    var caveat: String? {
        if case .elsewhere(_, let line) = presence { return line }
        return entry.caveat
    }
}

// `user` nil means nobody has signed in: a product must still open and work, only without sync.
// `verified` false means the seat stands on the device's last-known user; rooms key their connect on `seat`.
public struct Account {
    public let api: WindmillApi
    public let user: User?
    public let verified: Bool

    public var isSignedIn: Bool { user != nil }
    public var seat: Seat { Seat(userId: user?.id, verified: verified) }

    public struct Seat: Equatable {
        public let userId: String?
        public let verified: Bool
    }

    public init(api: WindmillApi, user: User?, verified: Bool = true) {
        self.api = api
        self.user = user
        self.verified = verified
    }
}

public struct User: Codable, Equatable {
    public let id: String
    public let email: String
    public let name: String

    public init(id: String, email: String, name: String) {
        self.id = id
        self.email = email
        self.name = name
    }
}
