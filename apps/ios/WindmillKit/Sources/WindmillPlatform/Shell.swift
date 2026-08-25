import SwiftUI

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
        // Both are needed: `preferredColorScheme` flips window traits without writing `\.colorScheme`
        // into this subtree.
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
        .onOpenURL { url in Task { await arrived(from: url) } }
        // Until the seat resolves, products run signed out.
        .task { await auth.restore() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, case .unverified = auth.status else { return }
            Task { await auth.restore() }
        }
        .onAppear { if journey.asked { openRoom = journey.lastRoom } }
    }

    private var chosenScheme: ColorScheme? { Appearance(rawValue: appearance)?.scheme }

    private var account: Account {
        Account(api: auth.api, user: auth.status.user, verified: auth.status.verified)
    }

    private var switcherHeight: CGFloat {
        CGFloat(products.count) * 64 + 96
    }

    private func runningElsewhere(than here: String?) -> Bool {
        products.contains { $0.id != here && $0.hubLine(account).running }
    }

    private func enter(_ id: String) {
        switcherUp = false
        houseUp = false
        openRoom = id
        journey.stood(in: id)
    }

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
        journey.stood(in: nil)
    }

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

// Under "System" the absence of an override is the setting.
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

// The home swipe is hand-rolled — a hidden navigation bar disables the system pop — and bound to the
// leading 20pt only, so a room keeps every other gesture.
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
            // Read the room's skin before the capsule is added: a preference reduces over the whole
            // observed subtree, so an inset inside it would land last.
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

// 38pt, top-left, in the lane every app reserves.
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
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(
                    Capsule().strokeBorder(
                        scheme == .dark ? Color.white.opacity(0.13) : WindmillColor.borderSubtle,
                        lineWidth: 1)
                )
                // The dot says only that another app has something running; never a count.
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

// The shared account seat: the last slot in every app's own bar.
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
                Text(isHere ? "you’re here" : line.headline)
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

// For a product with no room on this phone: where it works today, and a door to it.
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
            .overlay(alignment: .bottomTrailing) {
                YouSeat().padding(.trailing, WindmillSpace.x5).padding(.bottom, WindmillSpace.x5)
            }
        )
    }
}
