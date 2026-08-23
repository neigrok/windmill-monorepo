import SwiftUI
import WindmillPlatform

public struct JournalRoom: View {
    private let account: Account

    @StateObject private var store = PageStore()
    @AppStorage("windmill:journal-scales-taught") private var scalesTaught = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @FocusState private var writing: Bool

    public init(account: Account) {
        self.account = account
    }

    private var skin: JournalSkin { colorScheme == .dark ? .night : .day }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(store.days.enumerated()), id: \.element.id) { index, day in
                    if opensMonth(at: index) { monthDivider(day.day) }
                    DayMarkerView(day: day.day, mood: day.mood, energy: day.energy,
                                  wordCount: day.wordCount)
                    past(day)
                }

                if todayOpensMonth { monthDivider(store.today) }
                DayMarkerView(day: store.today, mood: store.mood, energy: store.energy,
                              wordCount: store.body.split(whereSeparator: \.isWhitespace).count,
                              isToday: true) {
                    SavedNote(state: store.saveState, tick: store.saveTick)
                }
                composer
            }
            .padding(.horizontal, 22)
            .padding(.top, WindmillSpace.x8)
            .padding(.bottom, 150)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        // Overlays, never siblings: a sibling that ignores the safe area drags the scroll view up.
        .overlay(alignment: .top) { statusBarScrim }
        .overlay(alignment: .bottom) { lamplight }
        .overlay(alignment: .bottom) { bar }
        .background(skin.canvas.ignoresSafeArea())
        .environment(\.journalSkin, skin)
        // `roomChrome` is the one thing the room says outward, so the shell can dress the capsule.
        .roomChrome(colorScheme)
        // Re-runs whenever the seat changes, including a verification.
        .task(id: account.seat) { await store.connect(to: account) }
        // Coming back asks what day it is: the store's midnight timer sleeps with the phone.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.rollOver(to: .today()) } }
            else { Task { await store.flushPendingWrite() } }
        }
    }

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
        Text(day.body)
            .font(WindmillFont.body(16))
            .lineSpacing(9)
            .foregroundStyle(skin.ink)
            .textSelection(.enabled)
            .padding(.top, WindmillSpace.x2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 34)
    }

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

    private var bar: some View {
        HStack {
            Spacer(minLength: 0)
            YouSeat()
        }
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.bottom, WindmillSpace.x2)
    }

    private var statusBarScrim: some View {
        LinearGradient(colors: [skin.canvas, skin.canvas, skin.canvas.opacity(0)],
                       startPoint: .top, endPoint: .bottom)
            .frame(height: 96)
            .allowsHitTesting(false)
            .ignoresSafeArea(edges: .top)
    }

    private var lamplight: some View {
        RadialGradient(
            colors: [skin.lamp.opacity(0.13), skin.lamp.opacity(0)],
            center: .bottom, startRadius: 0, endRadius: 300
        )
        .frame(height: 320)
        .allowsHitTesting(false)
        .ignoresSafeArea()
    }

}

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
