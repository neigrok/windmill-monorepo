import SwiftUI

// The product-neutral seam the native superapp is built on — the mirror of web/src/shell/products.js.
// A product library conforms to ProductModule to become mountable; the app composes whichever
// modules exist behind one account. Nothing here may name a product: the moment this file says
// "journal" the one rule in STRUCTURE.md is broken.

@MainActor
public protocol ProductModule {
    var id: String { get }
    var label: String { get }
    var symbol: String { get }          // SF Symbol, for the switcher
    var presence: Presence { get }

    // The product's whole surface. AnyView is the deliberate erasure that lets the app hold
    // products of different types in one array; a module keeps its own state by putting a
    // @StateObject inside the view it returns, which the shell keeps alive across switches.
    func room(_ account: Account) -> AnyView

    // The one line this product lends the hub — the shell contract's phrase, and the whole of what
    // the front door knows about it. The shell never reaches into a product for state; it asks.
    func hubLine(_ account: Account) -> HubLine

    // What this product calls itself on the way in, and on the way out of the first run.
    var entry: EntryDoor { get }

    // How much of this product is on THIS device. Two screens spend it: the "on this device" list
    // in signed-out You (the honest version of a save-your-work nudge — it states what is at stake
    // where someone came to look, instead of interrupting to say it), and the house sheet's
    // trigger, which waits until something real exists.
    func holdings(_ account: Account) -> Holdings
}

// The words a product uses in the shell's own first-run screens. They are the product's, not the
// shell's, because only the product knows what its first real thing is called.
public struct EntryDoor {
    public let verb: String     // "Write tonight" — the door, in a plain verb
    public let line: String     // "a blank page that remembers"
    public let made: String     // "Your first page is written." — the house sheet opens with this
    public let back: String     // "Back to writing" — dismissing the house returns you to work

    // What this room needs before it can be worked in — an account, most often. Nil is the good
    // case and means the door opens straight onto work. A product whose room is on ANOTHER SURFACE
    // does not fill this in: `presence` already carries that sentence, and one fact is written once.
    public let caveat: String?

    public init(verb: String, line: String, made: String, back: String, caveat: String? = nil) {
        self.verb = verb
        self.line = line
        self.made = made
        self.back = back
        self.caveat = caveat
    }
}

// A count and the word for one of them. The noun is the PRODUCT's vocabulary and nothing else may
// choose it: journal counts pages, never "entries" (`journal/journal.md` §9 forbids the word), a
// roadmap counts trees, a gym counts sessions.
public struct Holdings: Equatable {
    public let count: Int
    public let noun: String

    public init(count: Int, noun: String) {
        self.count = count
        self.noun = noun
    }

    public static let none = Holdings(count: 0, noun: "")
    public var isEmpty: Bool { count == 0 }

    // "3 pages" · "1 tree". Naive pluralisation, and deliberately so: every noun these products own
    // takes a plain -s, and a product that ever needs otherwise can say so in its own word.
    public var phrase: String { "\(count) \(noun)\(count == 1 ? "" : "s")" }
}

// What a product says on the front door: the line that decides whether you go in. `running` is the
// one thing that can reorder the hub — unfinished work outranks planned work, so a product with
// something live sinks to the bottom of the stack, where the thumb is.
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

// The three moves the shell owns, handed down so a product can spend them without knowing what the
// shell looks like. A product places `YouSeat()` at the end of its own bar; everything else here is
// the shell's own business.
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

// How a room tells the shell what colour its skin is, so the capsule laid over it can be dressed to
// match. It has to be a channel rather than a constant on the module: journal's skin is night or day
// by the writer's choice, and gym's is steel, so "what colour is this room right now" is only
// answerable by the room, while it is drawing.
public struct RoomChromePreference: PreferenceKey {
    public static let defaultValue = ColorScheme.light
    public static func reduce(value: inout ColorScheme, nextValue: () -> ColorScheme) {
        value = nextValue()
    }
}

public extension View {
    // Called by a product's room. The shell reads it to tint the one lane it reserves.
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

// Whether a product has a surface on THIS device yet. A module answering `.elsewhere` is still
// mounted and still listed — it just says where it does live. That is what lets the switcher be
// honest about a room that is real on the web without any product having to fake a screen here.
public enum Presence {
    case here
    case elsewhere(url: URL, line: String)
}

public extension ProductModule {
    var presence: Presence { .here }

    // A product with no native room holds nothing on this device, and that is the truth rather than
    // a stub — there is no surface here through which anything could have been made.
    func holdings(_ account: Account) -> Holdings { .none }

    // THE ONE THING A DOOR SAYS BEFORE IT IS CHOSEN. The first screen a phone ever shows offers one
    // card per product, and the rule that screen lives by is that it must not offer a door it cannot
    // open: either the card says what the room needs, or the room is not offered. Nil means the door
    // opens straight onto work and there is nothing to warn about.
    //
    // Two sources because they are two different facts, and neither is written twice: a room that is
    // really on another surface already says so in `presence`, and a room that is here but has a wall
    // in it says so in its own `entry`.
    var caveat: String? {
        if case .elsewhere(_, let line) = presence { return line }
        return entry.caveat
    }
}

// One sign-in, one subscription, one API host — handed to every product so no module invents its
// own idea of who is signed in.
//
// `user` is nil while nobody has signed in, and that is a supported state, not a degraded one: auth
// canon §2 is "claiming, not gating", so a product must open and work before there is an account to
// claim it. A module reads `isSignedIn` to decide whether it can sync, never whether it can run.
public struct Account {
    public let api: WindmillApi
    public let user: User?

    public var isSignedIn: Bool { user != nil }

    public init(api: WindmillApi, user: User?) {
        self.api = api
        self.user = user
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
