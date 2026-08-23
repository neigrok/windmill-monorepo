import CoreHaptics
import SwiftUI
import UIKit
import WindmillPlatform

public struct JournalRoom: View {
    private let account: Account

    @StateObject private var store = PageStore()
    // Exactly one haptic engine, owned by the room: never one per fire.
    @State private var haptics = ScaleHaptics()
    @State private var pairBloom = 0
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
            else {
                haptics.stop()
                Task { await store.flushPendingWrite() }
            }
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

            scales

            if store.isFirstRun {
                Text("Nobody sees this but you.")
                    .font(WindmillFont.body(13))
                    .foregroundStyle(skin.ink.opacity(0.5))
            }

            if showScalesCard { scalesCard }
        }
        .padding(.bottom, WindmillSpace.x8)
    }

    // Two labelled rows, because a scale that has to be learned is a scale that gets skipped.
    private var scales: some View {
        VStack(spacing: ScaleMetrics.rowGap) {
            ScaleRow(kind: .mood, value: store.mood, haptics: haptics) { value in
                store.set(mood: value)
                considerThePair()
            }
            ScaleRow(kind: .energy, value: store.energy, haptics: haptics) { value in
                store.set(energy: value)
                considerThePair()
            }
        }
        // Outside the two 44pt hit bands, so a scroll can still start beside the tracks.
        .padding(.vertical, WindmillSpace.x2)
        .background(alignment: .center) {
            if pairBloom > 0 { PairBloom(colour: skin.lamp).id(pairBloom) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("How the day felt")
    }

    // Completion happens once, so the pair bloom is capped; the four extreme events never are.
    private func considerThePair() {
        guard store.mood != nil, store.energy != nil else { return }
        let key = "journal.pair.\(store.today.iso)"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        pairBloom += 1
    }

    private var showScalesCard: Bool {
        !scalesTaught && !store.isFirstRun && !store.body.isEmpty
    }

    private var scalesCard: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text("Two scales, if you ever want them: how the day felt, and how much you had in the tank. Zero is a real answer. Skipping costs nothing.")
                .font(WindmillFont.body(14))
                .foregroundStyle(skin.ink.opacity(0.82))
                .lineSpacing(3)

            HStack(spacing: WindmillSpace.x2) {
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

// The two rows breathe once when a day's pair completes; opacity only under reduced motion.
private struct PairBloom: View {
    let colour: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lit = false

    var body: some View {
        RadialGradient(colors: [colour.opacity(0.08), .clear], center: .center,
                       startRadius: 0, endRadius: 130)
            .frame(height: 180)
            .allowsHitTesting(false)
            .opacity(lit ? 1 : 0)
            .task {
                withAnimation(.timingCurve(0.34, 1.4, 0.64, 1, duration: 0.26)) { lit = true }
                try? await Task.sleep(for: .milliseconds(380))
                withAnimation(.timingCurve(0.22, 0.61, 0.36, 1, duration: 0.64)) { lit = false }
            }
    }
}

// Where a phone beats a browser. Not gated by Reduce Motion — a haptic is not motion — and gated by
// the system haptics setting, which UIKit already honours.
@MainActor
final class ScaleHaptics {
    private var engine: CHHapticEngine?
    private let selection = UISelectionFeedbackGenerator()

    func stopCrossing() {
        selection.selectionChanged()
        selection.prepare()
    }

    func commit(_ event: ScaleEvent?, curve: Double) {
        guard let event else {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.4 + 0.4 * curve)
            return
        }
        switch event {
        case .surge: surge()
        case .flare: flare()
        case .ground: ground()
        case .hold: hold()
        }
    }

    func clear() {
        UIImpactFeedbackGenerator(style: .rigid).impactOccurred(intensity: 0.4)
    }

    func stop() {
        engine?.stop()
        engine = nil
    }

    // Crackle on the arcs' own three beats, then the discharge.
    private func surge() {
        let beats = [(0.0, 1.0, 1.0), (0.09, 0.75, 0.9), (0.16, 0.55, 0.8)]
        let crackle = beats.map { beat in
            CHHapticEvent(eventType: .hapticTransient,
                          parameters: [CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(beat.1)),
                                       CHHapticEventParameter(parameterID: .hapticSharpness, value: Float(beat.2))],
                          relativeTime: beat.0)
        }
        let discharge = CHHapticEvent(eventType: .hapticContinuous,
                                      parameters: [CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.5),
                                                   CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.3)],
                                      relativeTime: 0.16, duration: 0.26)
        let ramp = CHHapticParameterCurve(parameterID: .hapticIntensityControl,
                                          controlPoints: [.init(relativeTime: 0, value: 1),
                                                          .init(relativeTime: 0.26, value: 0)],
                                          relativeTime: 0.16)
        play(crackle + [discharge], curves: [ramp]) {
            let ladder: [(Double, UIImpactFeedbackGenerator.FeedbackStyle)] =
                [(0, .heavy), (0.09, .medium), (0.16, .light)]
            for beat in ladder { after(beat.0) { UIImpactFeedbackGenerator(style: beat.1).impactOccurred() } }
        }
    }

    // A swell, not a hit — and never a success chime: the canvas grades nothing.
    private func flare() {
        let swell = CHHapticEvent(eventType: .hapticContinuous,
                                  parameters: [CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.55),
                                               CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.15)],
                                  relativeTime: 0, duration: 0.62)
        let envelope = CHHapticParameterCurve(parameterID: .hapticIntensityControl,
                                              controlPoints: [.init(relativeTime: 0, value: 0),
                                                              .init(relativeTime: 0.31, value: 1),
                                                              .init(relativeTime: 0.62, value: 0)],
                                              relativeTime: 0)
        play([swell], curves: [envelope]) {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.6)
        }
    }

    // A set-down and its echo.
    private func ground() {
        UIImpactFeedbackGenerator(style: .rigid).impactOccurred(intensity: 0.5)
        after(0.18) { UIImpactFeedbackGenerator(style: .rigid).impactOccurred(intensity: 0.25) }
    }

    // The dim and the return, felt.
    private func hold() {
        let dip = CHHapticEvent(eventType: .hapticContinuous,
                                parameters: [CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.3),
                                             CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.1)],
                                relativeTime: 0, duration: 0.78)
        let envelope = CHHapticParameterCurve(parameterID: .hapticIntensityControl,
                                              controlPoints: [.init(relativeTime: 0, value: 1),
                                                              .init(relativeTime: 0.39, value: 0),
                                                              .init(relativeTime: 0.78, value: 1)],
                                              relativeTime: 0)
        play([dip], curves: [envelope]) {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.3)
        }
    }

    private func play(_ events: [CHHapticEvent], curves: [CHHapticParameterCurve], fallback: () -> Void) {
        guard let engine = running(),
              let pattern = try? CHHapticPattern(events: events, parameterCurves: curves),
              let player = try? engine.makePlayer(with: pattern),
              (try? player.start(atTime: CHHapticTimeImmediate)) != nil else {
            fallback()
            return
        }
    }

    private func running() -> CHHapticEngine? {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return nil }
        if let engine { return engine }
        guard let made = try? CHHapticEngine() else { return nil }
        made.stoppedHandler = { _ in }
        made.resetHandler = { try? made.start() }
        guard (try? made.start()) != nil else { return nil }
        engine = made
        return made
    }
}

@MainActor
private func after(_ seconds: Double, _ work: @escaping () -> Void) {
    Task { @MainActor in
        try? await Task.sleep(for: .seconds(seconds))
        work()
    }
}
