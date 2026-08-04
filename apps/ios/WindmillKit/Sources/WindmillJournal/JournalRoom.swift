import SwiftUI
import WindmillPlatform

// The canvas — one continuous scroll, oldest at the top, today at the bottom, the cursor waiting
// where you left it. The native statement of web/src/products/journal/Canvas.jsx, and the same
// rules: opening RESTORES to the bottom (a restore, not an entrance — nothing animates before you
// can type), a day marker pins while its day is under you, a gap is drawn as a gap, and the only
// thing that ever moves on its own is today's ember.

public struct JournalRoom: View {
    private let account: Account

    @StateObject private var store = PageStore()
    @AppStorage(JournalTheme.storageKey) private var theme = JournalTheme.night
    // The one teaching moment in the whole product, and it retires the first time it is answered.
    @AppStorage("windmill:journal-scales-taught") private var scalesTaught = false
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var writing: Bool

    public init(account: Account) {
        self.account = account
    }

    private var skin: JournalSkin { theme.skin }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(store.days.enumerated()), id: \.element.id) { index, day in
                    if opensMonth(at: index) { monthDivider(day.day) }
                    DayMarkerView(day: day.day, mood: day.mood, energy: day.energy,
                                  written: day.written, wordCount: day.wordCount)
                    past(day)
                }

                if todayOpensMonth { monthDivider(store.today) }
                DayMarkerView(day: store.today, mood: store.mood, energy: store.energy,
                              written: true, wordCount: store.body.split(whereSeparator: \.isWhitespace).count,
                              isToday: true) {
                    SavedNote(state: store.saveState, tick: store.saveTick)
                }
                composer
            }
            // The measure, capped before any margin appears: full width − 44 on a phone (canon §4).
            .padding(.horizontal, 22)
            .padding(.top, WindmillSpace.x8)
            .padding(.bottom, 150)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        // The lamp and the one control are overlaid, and the night is painted behind — never
        // siblings in a stack. A sibling that ignores the safe area drags the scroll view up with
        // it, and the day markers then pin beneath the status bar and land on top of the prose.
        .overlay(alignment: .top) { statusBarScrim }
        .overlay(alignment: .bottom) { lamplight }
        .overlay(alignment: .bottom) { bar }
        .background(skin.canvas.ignoresSafeArea())
        .environment(\.journalSkin, skin)
        // The room owns its skin inside its own scope and nowhere else (canon §10, the same rule
        // the web follows with .journal-root). `roomChrome` is the one thing it says outward: the
        // shell reads it to dress the capsule in the lane journal reserves and never paints.
        .environment(\.colorScheme, theme == .night ? .dark : .light)
        .roomChrome(theme == .night ? .dark : .light)
        // Re-runs whenever who is signed in changes: on sign-in this claims what was written on the
        // device before there was an account, then loads the window.
        .task(id: account.user?.id) { await store.connect(to: account) }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { Task { await store.flushPendingWrite() } }
        }
    }

    // Today — the last block. Writing happens inline in a field that grows, never in a composer
    // that opens; mood and energy sit under it in thumb reach.
    private var composer: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x5) {
            TextField(
                "",
                text: Binding(get: { store.body }, set: store.type),
                prompt: store.isFirstRun
                    ? Text("Start anywhere. Nothing here is graded.").foregroundStyle(skin.inkDim)
                    : nil,
                axis: .vertical
            )
            .font(WindmillFont.body(16))
            .lineSpacing(9)
            .foregroundStyle(skin.ink)
            .tint(skin.lamp)                 // the caret is the candle
            .textFieldStyle(.plain)
            .focused($writing)

            HStack(alignment: .bottom) {
                MoodDots(value: store.mood) { store.tap(mood: $0) }
                Spacer()
                EnergyBars(value: store.energy) { store.tap(energy: $0) }
            }

            if store.isFirstRun {
                Text("Nobody sees this but you.")
                    .font(WindmillFont.body(13))
                    .foregroundStyle(skin.ink.opacity(0.5))
            }

            // Appears once the first page is saved, and teaches the one thing the canvas cannot say
            // for itself: the two scales are optional, and skipping them costs nothing. Dismissed
            // once is dismissed forever — this is the only card journal ever shows.
            if showScalesCard { scalesCard }
        }
        .padding(.bottom, WindmillSpace.x8)
    }

    private var showScalesCard: Bool {
        !scalesTaught && !store.isFirstRun && !store.body.isEmpty
    }

    private var scalesCard: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text("Two taps, if you ever want them: how the day felt, and how much you had in the tank. Skipping costs nothing.")
                .font(WindmillFont.body(14))
                .foregroundStyle(skin.ink.opacity(0.82))
                .lineSpacing(3)

            HStack(spacing: WindmillSpace.x2) {
                Text("mood").modifier(ScaleChip(skin: skin))
                Text("energy").modifier(ScaleChip(skin: skin))
                Spacer(minLength: 0)
                Button("Not now") { scalesTaught = true }
                    .font(WindmillFont.body(12.5, .bold))
                    .foregroundStyle(skin.inkDim)
            }
        }
        .padding(WindmillSpace.x4)
        .background(RoundedRectangle(cornerRadius: 18).fill(skin.card))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(skin.gap.opacity(0.6), lineWidth: 1))
        .padding(.top, WindmillSpace.x2)
    }

    private func past(_ day: PageStore.CanvasDay) -> some View {
        Group {
            if day.written {
                Text(day.body)
                    .font(WindmillFont.body(16))
                    .lineSpacing(9)
                    .foregroundStyle(skin.ink)
                    .textSelection(.enabled)
                    .padding(.top, WindmillSpace.x2)
            } else {
                // A day not written, said plainly and never apologised for.
                Text("nothing written")
                    .font(WindmillFont.body(13))
                    .foregroundStyle(skin.ink.opacity(0.5))
                    .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 34)
    }

    // The month confirms itself as you scroll into it, rather than needing a rail of its own.
    private func monthDivider(_ day: LocalDay) -> some View {
        Text(Self.monthName(day))
            .font(WindmillFont.display(20))
            .foregroundStyle(skin.ink.opacity(0.9))
            .padding(.top, 22)
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func opensMonth(at index: Int) -> Bool {
        guard index > 0 else { return true }
        return month(of: store.days[index].day) != month(of: store.days[index - 1].day)
    }

    private var todayOpensMonth: Bool {
        guard let last = store.days.last else { return true }
        return month(of: store.today) != month(of: last.day)
    }

    private func month(of day: LocalDay) -> String { String(day.iso.prefix(7)) }

    static func monthName(_ day: LocalDay) -> String {
        let months = ["January", "February", "March", "April", "May", "June",
                      "July", "August", "September", "October", "November", "December"]
        let pieces = day.iso.split(separator: "-")
        let index = (Int(pieces[1]) ?? 1) - 1
        return "\(months[max(0, min(11, index))]) \(pieces[0])"
    }

    // The canvas scrolls under the status bar, as everything on this platform does. This is the
    // gradient the web puts behind its day marker, doing the same job here: prose dissolves into
    // the night before it can collide with the clock.
    private var statusBarScrim: some View {
        LinearGradient(colors: [skin.canvas, skin.canvas, skin.canvas.opacity(0)],
                       startPoint: .top, endPoint: .bottom)
            .frame(height: 96)
            .allowsHitTesting(false)
            .ignoresSafeArea(edges: .top)
    }

    // The lamplight — a soft warm pool at the foot of the canvas, under today.
    private var lamplight: some View {
        RadialGradient(
            colors: [skin.lamp.opacity(0.13), skin.lamp.opacity(0)],
            center: .bottom, startRadius: 0, endRadius: 300
        )
        .frame(height: 320)
        .allowsHitTesting(false)
        .ignoresSafeArea()
    }

    // Journal has no tabs, so its one bottom bar carries its own single control and then hands the
    // last slot to the shell: the You seat sits at the same right edge it sits at in every other
    // app, past a hairline, so it reads as the shell's and not as journal's (the shell contract).
    private var bar: some View {
        HStack(spacing: WindmillSpace.x4) {
            themeToggle
            Spacer(minLength: 0)
            YouSeat()
        }
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.bottom, WindmillSpace.x2)
    }

    // The one control on the surface, out of the writer's way. Power lives in the margins (canon §3.5).
    private var themeToggle: some View {
        Button {
            theme = theme.flipped
        } label: {
            Image(systemName: theme.otherSymbol)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(skin.lamp)
                .frame(width: 44, height: 44)
                .background(
                    Circle()
                        .fill(skin.card.opacity(0.88))
                        .overlay(Circle().strokeBorder(skin.lamp.opacity(0.3), lineWidth: 1))
                )
        }
        .accessibilityLabel("Switch to \(theme.otherLabel.lowercased())")
    }
}

// Mono "saved" that fades in on each write and eases back out — never a button, never a spinner,
// never a toast. Silence is the resting state.
private struct SavedNote: View {
    let state: PageStore.SaveState
    let tick: Int

    @State private var visible = false

    var body: some View {
        Text(state.line.map { " · \($0)" } ?? "")
            .opacity(visible ? 1 : 0)
            .animation(.easeInOut(duration: 0.24), value: visible)
            .task(id: tick) {
                guard tick > 0 else { return }
                visible = true
                try? await Task.sleep(for: .seconds(2.2))
                visible = false
            }
    }
}
