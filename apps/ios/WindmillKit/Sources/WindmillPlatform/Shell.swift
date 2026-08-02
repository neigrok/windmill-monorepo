import SwiftUI

// The app frame — one switcher over whichever products were mounted, and the seat. The native
// mirror of web/src/shell: it composes products off a registry and hard-codes none of them, so
// adding a fourth product is one line in the composition root and nothing here.
//
// THE TAB BAR IS PROVISIONAL and is being redesigned — do not build on it.
//
// All three products are shipping as rooms in this app, and each of them brings its own internal
// navigation (roadmap alone has a tree canvas, a list view, a node workspace and a gallery). A
// bottom tab bar spends the one piece of screen furniture every product needs for ITSELF on the
// switch between them, and a product that then wants its own bottom bar has nowhere to put it.
// Designs are being made; this is a runnable placeholder until they land.
//
// What is NOT provisional is the seam: `ProductModule.room()` hands back a whole surface and knows
// nothing about how it was reached. Whatever the switcher becomes — a drawer, a title-bar picker, a
// gesture — it is this one file that changes, and no product moves.

@MainActor
public struct SuperappView: View {
    private let products: [any ProductModule]

    @StateObject private var auth: AuthStore
    @State private var selected: String

    public init(products: [any ProductModule], auth: AuthStore = AuthStore()) {
        self.products = products
        _auth = StateObject(wrappedValue: auth)
        _selected = State(initialValue: products.first?.id ?? "account")
    }

    public var body: some View {
        TabView(selection: $selected) {
            ForEach(products, id: \.id) { product in
                product.room(account)
                    .tabItem { Label(product.label, systemImage: product.symbol) }
                    .tag(product.id)
            }

            AccountRoom(auth: auth)
                .tabItem { Label("You", systemImage: "person.crop.circle") }
                .tag("account")
        }
        // Ink, not the system's blue. The brand accent is gold, but gold on parchment is far too
        // low a contrast for text-sized controls, so gold stays on the filled buttons where it sits
        // on its own field and the app's tint is the ink everything else is already written in.
        .tint(WindmillColor.neutral900)
        // The seat resolves once on launch. Until it answers, products run signed out — which is a
        // real state, not a loading state, so nothing is blocked while it happens.
        .task { await auth.restore() }
    }

    private var account: Account {
        Account(api: auth.api, user: auth.status.user)
    }
}

// A product that is real, but not here. One line about where it lives and a door to it — never a
// mock screen, never a "coming soon" that counts nobody's interest.
public struct ElsewhereRoom: View {
    private let product: any ProductModule

    public init(product: any ProductModule) {
        self.product = product
    }

    public var body: some View {
        guard case .elsewhere(let url, let line) = product.presence else {
            return AnyView(EmptyView())
        }
        return AnyView(
            VStack(spacing: WindmillSpace.x5) {
                Image(systemName: product.symbol)
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(WindmillColor.neutral400)

                Text(product.label)
                    .font(WindmillFont.display(24))
                    .foregroundStyle(WindmillColor.textPrimary)

                Text(line)
                    .font(WindmillFont.body(15))
                    .foregroundStyle(WindmillColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(4)
                    .frame(maxWidth: 320)

                Link("Open it on the web", destination: url)
                    .font(WindmillFont.body(15, .semibold))
                    .foregroundStyle(WindmillColor.neutral900)
                    .padding(.horizontal, WindmillSpace.x5)
                    .padding(.vertical, WindmillSpace.x3)
                    .background(Capsule().fill(WindmillColor.gold400))
                    .padding(.top, WindmillSpace.x2)
            }
            .padding(WindmillSpace.x8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(WindmillColor.surfaceCanvas)
        )
    }
}

// The seat — and, per auth canon §2, the ONE unprompted mention of sign-in in the whole product.
// Nothing else in the app asks, counts declines, or interrupts to offer it.
public struct AccountRoom: View {
    @ObservedObject var auth: AuthStore
    @State private var doorOpen = false

    public init(auth: AuthStore) {
        self.auth = auth
    }

    public var body: some View {
        NavigationStack {
            List {
                switch auth.status {
                case .signedIn(let user):
                    Section {
                        LabeledContent("Signed in", value: user.email)
                        if !user.name.isEmpty { LabeledContent("Name", value: user.name) }
                    } footer: {
                        Text("Your pages sync to this account. Sign out and they stay on this device, editable.")
                    }

                    Section {
                        Link("Account settings", destination: URL(string: "https://windmill.works/#/settings")!)
                        Button("Sign out", role: .destructive) { Task { await auth.signOut() } }
                    } footer: {
                        Text("Settings — sessions, connected tools, export and closing your account — live on the web for now.")
                    }

                case .signedOut, .unknown:
                    Section {
                        Button("Sign in") { doorOpen = true }
                    } footer: {
                        Text("Signing in claims what you've already written and syncs it to your other devices. Until then it lives on this device, and everything works.")
                    }
                }
            }
            .navigationTitle("You")
            .scrollContentBackground(.hidden)
            .background(WindmillColor.surfaceCanvas)
            .sheet(isPresented: $doorOpen) { SignInDoor(auth: auth) }
        }
    }
}
