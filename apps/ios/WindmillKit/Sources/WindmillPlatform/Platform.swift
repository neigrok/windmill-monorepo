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
    // @StateObject inside the view it returns, which the switcher keeps alive across taps.
    func room(_ account: Account) -> AnyView
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
