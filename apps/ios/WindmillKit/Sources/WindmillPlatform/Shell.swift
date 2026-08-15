import SwiftUI

// The app frame, built to the resolved shell in the Design project
// (`templates/superapp-shell/SuperappShell.dc.html` — "S1 hub + S3 capsule").
//
// The contract, verbatim from that board, is the whole reason this file is small:
//
//   The shell owns   the hub and the order its cards take · the capsule (38pt, top-left, one lane
//                    every app reserves) · tap = switcher, edge-swipe right = home, nothing else ·
//                    the You seat, last slot in every app's bar, past a hairline · You and Pro,
//                    always clay, and Pro reachable only from You.
//   Each app owns    its nav bar, its tabs, its gestures below the capsule · its skin, including a
//                    dark default · its own settings · the one line it lends the hub.
//
// The previous tab bar is gone. It spent the one piece of screen furniture every product needs for
// itself on the switch between them, which is exactly what the capsule exists to avoid.

@MainActor
public struct SuperappView: View {
    private let products: [any ProductModule]

    @StateObject private var auth: AuthStore
    @State private var journey: Journey
    @State private var openRoom: String?          // nil = the hub
    @State private var switcherUp = false
    @State private var youUp = false
    @State private var houseUp = false
    @State private var doorUp = false
    @State private var doorRefusal: String?
    @AppStorage(Appearance.storageKey) private var appearance = Appearance.system.rawValue
    @Environment(\.scenePhase) private var scenePhase

    public init(products: [any ProductModule], auth: AuthStore = AuthStore(),
                journey: Journey = Journey()) {
        self.products = products
        _auth = StateObject(wrappedValue: auth)
        _journey = State(initialValue: journey)
    }

    public var body: some View {
        ZStack {
            // The one question is the first screen, once ever. Not the hub: a hub of three empty
            // rooms is a chore list, and an empty state is the worst first impression a superapp
            // can make (guidelines/superapp-shell.md §9).
            if !journey.asked {
                EntryQuestionView(products: products,
                                  onPick: { journey.answeredFirstQuestion(); enter($0) },
                                  onSkip: { journey.answeredFirstQuestion() })
                    .transition(.opacity)
                    .zIndex(2)
            }

            HubView(products: products, account: account, user: auth.status.user,
                    onEnter: { enter($0) }, onYou: { youUp = true })

            if let openRoom, let product = products.first(where: { $0.id == openRoom }) {
                RoomHost(elsewhereRunning: runningElsewhere(than: openRoom), goHome: { leave() }) {
                    product.room(account)
                }
                .transition(.move(edge: .trailing))
                .zIndex(1)
            }
        }
        .animation(.easeInOut(duration: 0.28), value: openRoom)
        .environment(\.shellActions, ShellActions(
            openYou: { youUp = true },
            openSwitcher: { tappedCapsule() },
            goHome: { leave() }
        ))
        .tint(WindmillColor.neutral900)
        // The shell's appearance, said TWICE on purpose. `preferredColorScheme` travels up to the
        // window — which flips the UIKit traits, and with them every adaptive token — but it does
        // NOT write `\.colorScheme` back into the subtree that declared it. So a room reading the
        // environment would still see the system's answer, which is exactly how the journal stayed
        // night with Light selected. The environment override is what actually reaches the rooms.
        .preferredColorScheme(chosenScheme)
        .modifier(SchemeOverride(scheme: chosenScheme))
        .sheet(isPresented: $switcherUp) {
            SwitcherSheet(products: products, account: account, here: openRoom,
                          onPick: { enter($0) }, onHome: { leave() })
                .presentationDetents([.height(switcherHeight)])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $youUp) { YouScreen(auth: auth, products: products) }
        .sheet(isPresented: $houseUp) { house }
        .sheet(isPresented: $doorUp) { SignInDoor(auth: auth, refusal: doorRefusal) }
        // A magic link that opens the app rather than the browser. The shell takes it because a
        // universal link can land on any screen, including a cold launch with no door open at all —
        // and a link that arrives is a sign-in, which is the shell's business and no product's.
        .onOpenURL { url in Task { await arrived(from: url) } }
        // The seat resolves once on launch. Until it answers, products run signed out — a real
        // state, not a loading state, so nothing is blocked while it happens. A launch the log never
        // answered leaves the seat UNVERIFIED — signed in off the user this device last read — and
        // every return to the foreground asks again until the log confirms or refuses it.
        .task { await auth.restore() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, case .unverified = auth.status else { return }
            Task { await auth.restore() }
        }
        // Launch reopens the last room you stood in, not the hub — the hub is a place you go, never
        // a toll gate. Only after the one question has been answered; before that it owns the screen.
        .onAppear { if journey.asked { openRoom = journey.lastRoom } }
    }

    private var chosenScheme: ColorScheme? { Appearance(rawValue: appearance)?.scheme }

    private var account: Account {
        Account(api: auth.api, user: auth.status.user, verified: auth.status.verified)
    }

    // Rooms sit lowest in the switcher, so the sheet is only as tall as its rows need.
    private var switcherHeight: CGFloat {
        CGFloat(products.count) * 64 + 96
    }

    // Something live in an app you are not in — the one fact the capsule is allowed to carry.
    private func runningElsewhere(than here: String?) -> Bool {
        products.contains { $0.id != here && $0.hubLine(account).running }
    }

    private func enter(_ id: String) {
        switcherUp = false
        houseUp = false
        openRoom = id
        journey.stood(in: id)
    }

    // A URL the app was opened with. Anything that is not a magic link answers nil and is ignored
    // rather than guessed at — the app claims one shape of link and has nothing to say about the rest.
    //
    // A success needs no screen: the seat, the hub and every room already read `auth.status`, and a
    // door that happened to be open watches `auth.arrival` and closes itself. A REFUSAL does need
    // one — an expired link that woke a closed app would otherwise be a launch that silently did
    // nothing — so the shell opens the door with the sentence already in it, unless another sheet is
    // up, in which case the door inside it is the one holding the person's attention.
    private func arrived(from url: URL) async {
        guard let arrival = await auth.arrived(from: url) else { return }
        guard case .refused(let line) = arrival, !switcherUp, !youUp, !houseUp else { return }
        doorRefusal = line
        doorUp = true
    }

    private func leave() {
        switcherUp = false
        houseUp = false
        openRoom = nil
        journey.stood(in: nil)   // going home is itself an answer: the hub is where they chose to be
    }

    // A capsule tap opens the switcher — except for the one tap that comes after the first real
    // thing exists, which introduces the house instead. See Journey.shouldIntroduceHouse for why
    // the two triggers the board describes are really one.
    private func tappedCapsule() {
        guard let here = openRoom, let product = products.first(where: { $0.id == here }),
              journey.shouldIntroduceHouse(madeSomething: !product.holdings(account).isEmpty,
                                           otherRooms: products.count - 1) else {
            switcherUp = true
            return
        }
        journey.houseWasShown()
        houseUp = true
    }

    @ViewBuilder
    private var house: some View {
        if let here = openRoom, let product = products.first(where: { $0.id == here }) {
            HouseSheet(madeIn: product,
                       others: products.filter { $0.id != here },
                       onOpen: { enter($0) },
                       onDismiss: { houseUp = false })
                .presentationDetents([.height(CGFloat(products.count - 1) * 78 + 250)])
                .presentationDragIndicator(.visible)
        }
    }
}

// Applies the chosen scheme to the subtree, and nothing at all under "System" — where the absence
// of an override IS the setting, and forcing a value would quietly make System mean "whatever it
// was when the app launched".
private struct SchemeOverride: ViewModifier {
    let scheme: ColorScheme?

    func body(content: Content) -> some View {
        if let scheme {
            content.environment(\.colorScheme, scheme)
        } else {
            content
        }
    }
}

// A room, with the two seats the shell reserves in it: the capsule top-left, and the edge-swipe
// that takes you home.
//
// The gesture is hand-rolled rather than a NavigationStack pop because each app hides the
// navigation bar to own its own chrome, and hiding the bar is exactly what disables the system's
// interactive pop. It is bound to the leading edge only, so a canvas that scrolls, a stepper that
// drags and a slider that slides all keep their gestures — the shell takes 20pt and nothing more.
private struct RoomHost<Room: View>: View {
    let elsewhereRunning: Bool
    let goHome: () -> Void
    @ViewBuilder var room: Room

    @Environment(\.shellActions) private var shell
    @State private var drag: CGFloat = 0
    @State private var chrome: ColorScheme = .light

    private let edge: CGFloat = 20
    private let travel: CGFloat = 90

    var body: some View {
        room
            // A safe-area inset rather than an overlay, because the contract says the capsule gets
            // "one lane every app reserves" — and a lane reserved by the SHELL cannot be forgotten
            // by an app, where an overlay just lands on top of whatever was already there.
            // Read the room's skin BEFORE the capsule is added, not after. A preference reduces
            // over the whole observed subtree, so with the inset inside it the capsule's own
            // default (light) lands last and clobbers the room's answer — which is exactly how a
            // night canvas ended up wearing a daylight capsule.
            .onPreferenceChange(RoomChromePreference.self) { chrome = $0 }
            .safeAreaInset(edge: .top, alignment: .leading, spacing: 0) {
                CapsuleButton(elsewhereRunning: elsewhereRunning)
                    .environment(\.colorScheme, chrome)
                    .padding(.leading, WindmillSpace.x4)
                    .padding(.bottom, WindmillSpace.x2)
            }
            .offset(x: drag)
            .simultaneousGesture(
                DragGesture(minimumDistance: 12, coordinateSpace: .global)
                    .onChanged { value in
                        guard value.startLocation.x <= edge, value.translation.width > 0 else { return }
                        drag = value.translation.width
                    }
                    .onEnded { value in
                        guard value.startLocation.x <= edge else { return }
                        if value.translation.width > travel { goHome() }
                        drag = 0
                    }
            )
            .animation(.interactiveSpring(duration: 0.25), value: drag)
    }
}

// The capsule — 38pt, top-left, in the one lane every app reserves. Tap opens the switcher. It
// wears a dot when another app has something running.
public struct CapsuleButton: View {
    private let elsewhereRunning: Bool

    @Environment(\.shellActions) private var shell
    @Environment(\.colorScheme) private var scheme

    public init(elsewhereRunning: Bool = false) {
        self.elsewhereRunning = elsewhereRunning
    }

    public var body: some View {
        Button { shell.openSwitcher() } label: {
            Text("W")
                .font(WindmillFont.display(16, .heavy))
                .foregroundStyle(scheme == .dark ? Color.white : WindmillColor.neutral900)
                .frame(minWidth: 38)
                .frame(height: 38)
                // The board's `backdrop-filter: blur(12px)` — a material, not a flat fill. It is
                // what lets one capsule sit legibly over a night canvas, a steel log and a clay
                // list without the shell knowing anything about what is underneath it.
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(
                    Capsule().strokeBorder(
                        scheme == .dark ? Color.white.opacity(0.13) : WindmillColor.borderSubtle,
                        lineWidth: 1)
                )
                // The dot is the only thing the capsule ever says: another app has something
                // running. It is never a count and never a badge with a number.
                .overlay(alignment: .topTrailing) {
                    if elsewhereRunning {
                        Circle()
                            .fill(WindmillColor.olive400)
                            .frame(width: 9, height: 9)
                            .overlay(Circle().strokeBorder(scheme == .dark ? Color.black.opacity(0.5) : Color.white, lineWidth: 1.5))
                            .offset(x: 1, y: -1)
                    }
                }
        }
        .accessibilityLabel(elsewhereRunning ? "Switch app — something is running" : "Switch app")
    }
}

// The shared account seat — the last slot in every app's own bar, past a hairline so it reads as
// the shell's and not the app's. A product places this; it never builds its own.
public struct YouSeat: View {
    private let initial: String

    @Environment(\.shellActions) private var shell
    @Environment(\.colorScheme) private var scheme

    public init(initial: String = "") {
        self.initial = initial
    }

    public var body: some View {
        HStack(spacing: WindmillSpace.x3) {
            Rectangle()
                .fill(scheme == .dark ? Color.white.opacity(0.14) : WindmillColor.borderSubtle)
                .frame(width: 1, height: 22)

            Button { shell.openYou() } label: {
                AvatarDot(initial: initial, size: 30)
            }
            .accessibilityLabel("You")
        }
    }
}

// The initial, or the ghost seat when nobody has signed in. One drawing, used on the hub, in the
// switcher's own header and at the end of every app's bar.
struct AvatarDot: View {
    var initial: String = ""
    var size: CGFloat = 30

    var body: some View {
        Circle()
            .fill(WindmillColor.neutral200)
            .frame(width: size, height: size)
            .overlay {
                if initial.isEmpty {
                    Image(systemName: "person.fill")
                        .font(.system(size: size * 0.44))
                        .foregroundStyle(WindmillColor.neutral600)
                } else {
                    Text(initial.uppercased())
                        .font(WindmillFont.display(size * 0.46, .bold))
                        .foregroundStyle(WindmillColor.neutral800)
                }
            }
    }
}

// The switcher. Rooms sit lowest — the most-tapped thing lands under the thumb — and Home is the
// small line above them. Pro is not here at all: the switcher stays about rooms, never billing.
private struct SwitcherSheet: View {
    let products: [any ProductModule]
    let account: Account
    let here: String?
    let onPick: (String) -> Void
    let onHome: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 0)

            Button(action: onHome) {
                HStack(spacing: WindmillSpace.x3) {
                    Image(systemName: "house")
                        .font(.system(size: 14, weight: .medium))
                    Text("Home")
                        .font(WindmillFont.body(14.5, .semibold))
                }
                .foregroundStyle(WindmillColor.textSecondary)
            }
            .padding(.bottom, WindmillSpace.x4)

            VStack(spacing: WindmillSpace.x2) {
                ForEach(products, id: \.id) { product in
                    Button { onPick(product.id) } label: {
                        SwitcherRow(product: product, line: product.hubLine(account),
                                    isHere: product.id == here)
                    }
                }
            }
        }
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.bottom, WindmillSpace.x6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .background(WindmillColor.surfaceCanvas)
    }
}

private struct SwitcherRow: View {
    let product: any ProductModule
    let line: HubLine
    let isHere: Bool

    var body: some View {
        HStack(spacing: WindmillSpace.x4) {
            Text(String(product.label.prefix(1)))
                .font(WindmillFont.display(15, .heavy))
                .foregroundStyle(WindmillColor.neutral700)
                .frame(width: 38, height: 38)
                .background(Circle().fill(WindmillColor.neutral100))

            VStack(alignment: .leading, spacing: 2) {
                Text(product.label)
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(WindmillColor.textPrimary)
                Text(isHere ? "you're here" : line.headline)
                    .font(WindmillFont.body(13))
                    .foregroundStyle(WindmillColor.textTertiary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            if line.running {
                Circle().fill(WindmillColor.olive500).frame(width: 7, height: 7)
            }
        }
        .padding(.vertical, WindmillSpace.x2)
        .padding(.horizontal, WindmillSpace.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18)
            .fill(isHere ? WindmillColor.neutral100 : WindmillColor.surfaceCard))
    }
}

// A product that is real, but not on this phone yet. One line about where it works today and a door
// to it — never a mock screen, and never a "coming soon" that counts nobody's interest. All three
// products are shipping as rooms here; this is what one looks like before its room is built.
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
                    .padding(.horizontal, WindmillSpace.x5)
                    .padding(.vertical, WindmillSpace.x3)
                    .actionCapsule(.primary)
                    .padding(.top, WindmillSpace.x2)
            }
            .padding(WindmillSpace.x8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(WindmillColor.surfaceCanvas)
            // Even a room that isn't built keeps the shell's seat: the account is reachable from
            // every app's bar, at the same right edge, whatever the app's chrome.
            .overlay(alignment: .bottomTrailing) {
                YouSeat().padding(.trailing, WindmillSpace.x5).padding(.bottom, WindmillSpace.x5)
            }
        )
    }
}
