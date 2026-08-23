import SwiftUI
import WindmillPlatform

struct DayMarkerView<Trailing: View>: View {
    let day: LocalDay
    var mood: Int?
    var energy: Int?
    var wordCount = 0
    var isToday = false
    @ViewBuilder var trailing: Trailing

    @Environment(\.journalSkin) private var skin

    var body: some View {
        HStack(alignment: .center, spacing: WindmillSpace.x3) {
            HStack(spacing: 0) {
                Text(Self.stamp(day))
                if wordCount > 0 {
                    Text(" · \(wordCount) \(wordCount == 1 ? "WORD" : "WORDS")")
                }
                trailing
            }
            .font(WindmillFont.mono(12))
            .kerning(0.5)
            .foregroundStyle(skin.inkDim)

            Spacer(minLength: WindmillSpace.x2)

            HStack(spacing: WindmillSpace.x3) {
                MoodPip(mood: mood, isToday: isToday)
                EnergyTick(energy: energy)
            }
        }
        .padding(.top, WindmillSpace.x2)
        .padding(.bottom, 6)
    }

    // "SUN 20 JUL" — computed rather than formatted, so the shape is the same in every locale.
    static func stamp(_ day: LocalDay) -> String {
        let weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
        let months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
        let pieces = day.iso.split(separator: "-")
        let monthIndex = (Int(pieces[1]) ?? 1) - 1
        let weekday = Calendar.current.component(.weekday, from: day.startOfDay()) - 1
        return "\(weekdays[max(0, min(6, weekday))]) \(pieces[2]) \(months[max(0, min(11, monthIndex))])"
    }
}

extension DayMarkerView where Trailing == EmptyView {
    init(day: LocalDay, mood: Int? = nil, energy: Int? = nil,
         wordCount: Int = 0, isToday: Bool = false) {
        self.init(day: day, mood: mood, energy: energy,
                  wordCount: wordCount, isToday: isToday) { EmptyView() }
    }
}

// Every read-only glyph reads five bands, and carries the permanent hairline: at the floor of the
// ramp a mood swatch is a 1.24:1 wash on the day ground, so the edge is what draws it.
private struct MoodPip: View {
    let mood: Int?
    let isToday: Bool

    @Environment(\.journalSkin) private var skin
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        Circle()
            .fill(isToday && mood == nil ? skin.lamp : skin.moodBand(mood))
            .overlay(Circle().strokeBorder(skin.swatchEdge, lineWidth: 1))
            .frame(width: 10, height: 10)
            .opacity(isToday && breathing ? 0.55 : 1)
            .animation(reduceMotion || !isToday ? nil : .easeInOut(duration: 1).repeatForever(autoreverses: true),
                       value: breathing)
            .onAppear { if isToday && !reduceMotion { breathing = true } }
    }
}

// The baseline is the only thing telling "energy 0 to 3, recorded" from "energy never answered".
private struct EnergyTick: View {
    let energy: Int?
    @Environment(\.journalSkin) private var skin

    var body: some View {
        VStack(spacing: 1) {
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(1...3, id: \.self) { bar in
                    Capsule()
                        .fill(lit >= bar ? skin.energy : skin.gap)
                        .frame(width: 2.5, height: [5, 7, 9][bar - 1])
                }
            }
            .frame(height: 9, alignment: .bottom)

            RoundedRectangle(cornerRadius: 0.5)
                .fill(skin.energy.opacity(0.45))
                .frame(width: 11.5, height: 1)
                .opacity(energy == nil ? 0 : 1)
        }
        .frame(height: 11, alignment: .bottom)
    }

    private var lit: Int { energy.map(Scale.energyBars) ?? 0 }
}

// MARK: - The strip

enum ScaleKind {
    case mood, energy

    var label: String { self == .mood ? "MOOD" : "ENERGY" }
    var name: String { self == .mood ? "Mood" : "Energy" }
    var clearLabel: String { self == .mood ? "Clear mood" : "Clear energy" }
    var headSize: CGSize { self == .mood ? CGSize(width: 18, height: 18) : CGSize(width: 7, height: 20) }
    var unsetHeadSize: CGSize { self == .mood ? CGSize(width: 16, height: 16) : CGSize(width: 6, height: 18) }
    var headRadius: CGFloat { self == .mood ? 9 : 3.5 }
}

// Phone geometry, §2.3 — iOS has no pointer surface, so the desktop column never applies.
enum ScaleMetrics {
    static let row: CGFloat = 44
    static let rowGap: CGFloat = 4
    static let label: CGFloat = 58
    static let numeral: CGFloat = 34
    static let gap: CGFloat = 8
    static let bed: CGFloat = 8
    static let inset: CGFloat = 9
    static let tick: CGFloat = 2.5
    static let restGlow: CGFloat = 6
    static let endGlow: CGFloat = 10        // the surge's mark
    static let flareGlow: CGFloat = 12      // the flare's mark
    static let heldRingClearance: CGFloat = 12   // the hold's mark sits at head diameter + this

    // No transient in the strip may paint into the other scale's row: two scales visually merging
    // is the precise failure this strip exists to fix, and being brief does not excuse it. A
    // transient centred on a head reaches at most half the row pitch, less a pixel. Overflow
    // UPWARD, into the writing field, is allowed — nothing there competes for meaning.
    static let pitch: CGFloat = row + rowGap
    static let transientRadius: CGFloat = pitch / 2 - 1

    // The flare's rings expand to the head's diameter + this, which lands their outer face exactly
    // on transientRadius. At the drawn +56 they reached 37pt and crossed the ENERGY track.
    static let flareReach: CGFloat = 2 * transientRadius - ScaleKind.mood.headSize.width
}

// The four named events at the four ends of the two scales.
enum ScaleEvent {
    case surge      // energy 10
    case flare      // mood 10
    case ground     // energy 0
    case hold       // mood 0

    static func at(_ kind: ScaleKind, value: Int) -> ScaleEvent? {
        switch (kind, value) {
        case (.energy, 10): return .surge
        case (.mood, 10): return .flare
        case (.energy, 0): return .ground
        case (.mood, 0): return .hold
        default: return nil
        }
    }

    var duration: Duration {
        switch self {
        case .surge: return .milliseconds(1320)
        case .flare: return .milliseconds(1460)
        case .ground: return .milliseconds(900)
        case .hold: return .milliseconds(1020)
        }
    }
}

// One row, one scale: [label][track][numeral]. Identity is carried three times over — the word,
// the hue and the head's shape — so nothing has to be learned.
struct ScaleRow: View {
    let kind: ScaleKind
    let value: Int?
    let haptics: ScaleHaptics
    let onChange: (Int?) -> Void

    @Environment(\.journalSkin) private var skin
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var dragging: Int?
    @State private var pressing = false
    @State private var commit = 0
    @State private var curve: Double = 0        // the U-curve of the last commit
    @State private var event: ScaleEvent?
    @State private var eventRun = 0

    private var shown: Int? { dragging ?? value }

    var body: some View {
        HStack(spacing: ScaleMetrics.gap) {
            label
            GeometryReader { proxy in track(proxy.size.width) }
                .frame(height: ScaleMetrics.row)
            numeral
        }
        .frame(height: ScaleMetrics.row)
    }

    private var label: some View {
        Text(kind.label)
            .font(WindmillFont.mono(10.5))
            .kerning(0.95)
            .foregroundStyle(skin.inkDim)
            // The row quietly names what was just set: the piece that replaces the deleted mono word.
            .overlay(
                Text(kind.label)
                    .font(WindmillFont.mono(10.5))
                    .kerning(0.95)
                    .foregroundStyle(skin.lamp)
                    .keyframeAnimator(initialValue: 0.0, trigger: commit) { text, answer in
                        text.opacity(answer)
                    } keyframes: { _ in
                        KeyframeTrack {
                            CubicKeyframe(0.55 + 0.45 * curve, duration: 0.21)
                            CubicKeyframe(0.0, duration: 0.49)
                        }
                    }
            )
            .frame(width: ScaleMetrics.label, alignment: .leading)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var numeral: some View {
        if let shown {
            Button { clear() } label: {
                Text("\(shown)")
                    .font(WindmillFont.mono(13))
                    .monospacedDigit()
                    .foregroundStyle(skin.lamp)
                    .frame(width: ScaleMetrics.numeral, height: ScaleMetrics.row, alignment: .trailing)
                    .contentShape(Rectangle())
                    .keyframeAnimator(initialValue: 0.0, trigger: commit) { text, rise in
                        text.offset(y: reduceMotion ? 0 : rise)
                    } keyframes: { _ in
                        KeyframeTrack {
                            LinearKeyframe(3.0, duration: 0.001)
                            CubicKeyframe(0.0, duration: 0.14)
                        }
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(kind.clearLabel)
        } else {
            Text("—")
                .font(WindmillFont.mono(13))
                .foregroundStyle(skin.inkDim.opacity(0.55))
                .frame(width: ScaleMetrics.numeral, height: ScaleMetrics.row, alignment: .trailing)
                .accessibilityHidden(true)
        }
    }

    private func track(_ width: CGFloat) -> some View {
        let head = headCentre(in: width)

        return ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: ScaleMetrics.bed / 2)
                .fill(skin.ink.opacity(0.12))
                .frame(height: ScaleMetrics.bed)

            ticks(width)

            if let shown, shown > 0 {
                RoundedRectangle(cornerRadius: ScaleMetrics.bed / 2)
                    .fill(fillColour)
                    .frame(width: head, height: ScaleMetrics.bed)
                    .overlay(alignment: .leading) { chargedSheen(head) }
            }

            groundRule(width)
            heldRing(head)
            headView(at: head)

            if let event {
                eventLayer(event, width: width, head: head)
                    .id(eventRun)
                    .allowsHitTesting(false)
            }
        }
        .frame(width: width, height: ScaleMetrics.row, alignment: .leading)
        .contentShape(Rectangle())
        .gesture(scrub(width))
        .accessibilityElement()
        .accessibilityLabel(kind.name)
        .accessibilityValue(shown.map { "\($0) of 10" } ?? "not set")
        .accessibilityAdjustableAction { direction in
            let from = value ?? 5
            land(on: max(0, min(10, direction == .increment ? from + 1 : from - 1)))
        }
    }

    private func ticks(_ width: CGFloat) -> some View {
        let covered = (shown ?? -1) > 0 ? (shown ?? 0) : -1
        return ForEach(0...10, id: \.self) { stop in
            RoundedRectangle(cornerRadius: ScaleMetrics.tick / 2)
                .fill(skin.ink.opacity(0.20))
                .frame(width: ScaleMetrics.tick, height: ScaleMetrics.tick)
                .offset(x: position(of: stop, in: width) - ScaleMetrics.tick / 2)
                .opacity(stop <= covered ? 0 : 1)
        }
    }

    // MARK: the head

    @ViewBuilder
    private func headView(at head: CGFloat) -> some View {
        let isSet = shown != nil
        let size = isSet ? kind.headSize : kind.unsetHeadSize
        let shape = RoundedRectangle(cornerRadius: kind.headRadius, style: .continuous)

        shape
            .fill(isSet ? fillColour : Color.clear)
            .overlay(shape.strokeBorder(isSet ? skin.headRing : skin.swatchEdge, lineWidth: 1.5))
            .frame(width: size.width, height: size.height)
            .keyframeAnimator(initialValue: HeadMotion(), trigger: commit) { head, motion in
                head
                    .scaleEffect(x: motion.scale * motion.stretch, y: motion.scale * motion.squash)
                    .shadow(color: skin.headGlow(fillColour, atEnd: isEnd).opacity(isSet ? motion.dim : 0),
                            radius: restingGlow + motion.glow)
            } keyframes: { _ in headKeyframes() }
            .offset(x: head - size.width / 2)
            .scaleEffect(pressing && !reduceMotion ? 0.94 : 1)
            .animation(.easeOut(duration: 0.09), value: pressing)
    }

    // One fixed timeline shape, five tracks, values chosen by the event: no branch inside a
    // keyframe builder, and nothing here reads the value except through the U-curve.
    @KeyframesBuilder<HeadMotion>
    private func headKeyframes() -> some Keyframes<HeadMotion> {
        KeyframeTrack(\.scale) {
            CubicKeyframe(scaleBeats[0].value, duration: scaleBeats[0].seconds)
            CubicKeyframe(scaleBeats[1].value, duration: scaleBeats[1].seconds)
            CubicKeyframe(scaleBeats[2].value, duration: scaleBeats[2].seconds)
        }
        KeyframeTrack(\.squash) {
            CubicKeyframe(squashBeats[0].value, duration: squashBeats[0].seconds)
            CubicKeyframe(squashBeats[1].value, duration: squashBeats[1].seconds)
        }
        KeyframeTrack(\.stretch) {
            CubicKeyframe(stretchBeats[0].value, duration: stretchBeats[0].seconds)
            CubicKeyframe(stretchBeats[1].value, duration: stretchBeats[1].seconds)
        }
        KeyframeTrack(\.glow) {
            CubicKeyframe(glowBeats[0].value, duration: glowBeats[0].seconds)
            CubicKeyframe(glowBeats[1].value, duration: glowBeats[1].seconds)
        }
        KeyframeTrack(\.dim) {
            CubicKeyframe(Double(dimBeats[0].value), duration: dimBeats[0].seconds)
            CubicKeyframe(Double(dimBeats[1].value), duration: dimBeats[1].seconds)
        }
    }

    private var scaleBeats: [HeadBeat] {
        if reduceMotion { return HeadBeat.still(1, count: 3) }
        if event == .surge {
            return [HeadBeat(1.42, 0.17), HeadBeat(1.06, 0.13), HeadBeat(1, 0.12)]
        }
        if event == .ground { return HeadBeat.still(1, count: 3) }
        return [HeadBeat(1 + 0.16 + 0.16 * curve, 0.134), HeadBeat(1, 0.186), HeadBeat(1, 0.001)]
    }

    // The capsule does not bloom upward at the floor — it squashes, like something put down.
    private var squashBeats: [HeadBeat] {
        guard event == .ground, !reduceMotion else { return HeadBeat.still(1, count: 2) }
        return [HeadBeat(0.72, 0.16), HeadBeat(1, 0.22)]
    }

    private var stretchBeats: [HeadBeat] {
        guard event == .ground, !reduceMotion else { return HeadBeat.still(1, count: 2) }
        return [HeadBeat(1.12, 0.16), HeadBeat(1, 0.22)]
    }

    private var glowBeats: [HeadBeat] {
        if reduceMotion { return HeadBeat.still(0, count: 2) }
        if event == .surge {
            return [HeadBeat(26 - ScaleMetrics.endGlow, 0.17), HeadBeat(0, 0.9)]
        }
        return [HeadBeat(8 + 10 * curve - ScaleMetrics.restGlow, 0.134), HeadBeat(0, 0.186)]
    }

    // The hold is the one event whose gesture is alpha: the ember dims almost out and comes back.
    private var dimBeats: [HeadBeat] {
        guard event == .hold else { return HeadBeat.still(1, count: 2) }
        let half = reduceMotion ? 0.25 : 0.45
        return [HeadBeat(0, half), HeadBeat(1, half)]
    }

    // MARK: the permanent marks

    @ViewBuilder
    private func chargedSheen(_ head: CGFloat) -> some View {
        if kind == .energy && value == 10 && settled {
            LinearGradient(colors: [.clear, skin.surgeCore.opacity(0.10), .clear],
                           startPoint: .leading, endPoint: .trailing)
                .frame(width: head, height: ScaleMetrics.bed)
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder
    private func groundRule(_ width: CGFloat) -> some View {
        if kind == .energy && value == 0 && settled {
            Rectangle()
                .fill(skin.energy.opacity(0.55))
                .frame(width: width, height: 1)
                .offset(y: ScaleMetrics.bed / 2 + 2.5)
                .transition(.opacity)
        }
    }

    @ViewBuilder
    private func heldRing(_ head: CGFloat) -> some View {
        if kind == .mood && value == 0 && settled {
            let diameter = kind.headSize.width + ScaleMetrics.heldRingClearance
            // Centred on the head+12 path, not tucked inside it: strokeBorder would put the whole
            // 1px band within the path and leave the mark 5px clear of the head instead of 6.
            Circle()
                .stroke(skin.headRing, lineWidth: 1)
                .frame(width: diameter, height: diameter)
                .offset(x: head - diameter / 2)
        }
    }

    // MARK: the events

    @ViewBuilder
    private func eventLayer(_ event: ScaleEvent, width: CGFloat, head: CGFloat) -> some View {
        switch event {
        case .surge:
            SurgeArcs(span: head, night: skin.isNight, energy: skin.energy,
                      core: skin.surgeCore, glow: skin.headGlow(skin.energy, atEnd: true),
                      reduceMotion: reduceMotion)
                .frame(width: width, height: ScaleMetrics.row, alignment: .leading)
        case .flare:
            FlareBurst(head: head, colour: skin.mood[10], width: width, reduceMotion: reduceMotion)
        case .ground:
            GroundStrike(width: width, colour: skin.energy, reduceMotion: reduceMotion)
        case .hold:
            HoldDip(head: head, width: width, ring: skin.headRing,
                    sweep: skin.mood[0], headDiameter: kind.headSize.width, reduceMotion: reduceMotion)
        }
    }

    // MARK: gesture and commit

    private func scrub(_ width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { move in
                pressing = true
                let stop = self.stop(at: move.location.x, in: width)
                guard stop != dragging else { return }
                if dragging != nil { haptics.stopCrossing() }
                dragging = stop
            }
            .onEnded { move in
                let stop = self.stop(at: move.location.x, in: width)
                pressing = false
                dragging = nil
                land(on: stop)
            }
    }

    // The change-guard: committing the value already held does nothing, so no event can be farmed.
    private func land(on stop: Int) {
        guard stop != value else { return }
        onChange(stop)
        curve = abs(Double(stop) - 5) / 5
        event = ScaleEvent.at(kind, value: stop)
        eventRun += 1
        commit += 1
        haptics.commit(event, curve: curve)
        if let fired = event { retire(fired, run: eventRun) }
    }

    private func clear() {
        guard value != nil else { return }
        onChange(nil)
        event = nil
        curve = 0
        haptics.clear()
    }

    private func retire(_ fired: ScaleEvent, run: Int) {
        Task { @MainActor in
            try? await Task.sleep(for: fired.duration)
            guard eventRun == run else { return }
            event = nil
        }
    }

    // MARK: geometry

    private func position(of stop: Int, in width: CGFloat) -> CGFloat {
        let travel = max(width - 2 * ScaleMetrics.inset, 1)
        return ScaleMetrics.inset + travel * CGFloat(stop) / 10
    }

    private func headCentre(in width: CGFloat) -> CGFloat {
        position(of: shown ?? 0, in: width)
    }

    private func stop(at x: CGFloat, in width: CGFloat) -> Int {
        let travel = max(width - 2 * ScaleMetrics.inset, 1)
        let ratio = (x - ScaleMetrics.inset) / travel
        return max(0, min(10, Int((ratio * 10).rounded())))
    }

    private var fillColour: Color {
        kind == .mood ? skin.mood(shown) : skin.energy
    }

    // A permanent mark is a statement about a COMMITTED value, so it is drawn on commit and on
    // clear and never mid-drag: a mark that flashed at every crossing would be a small reward per
    // scrub, which is farming arriving through a door the change-guard does not watch.
    private var settled: Bool { dragging == nil }

    private var isEnd: Bool { settled && (value == 0 || value == 10) }

    // The ordinary glow belongs to any head that is showing a value, drag included; only the two
    // ceiling glows are marks, and those wait for the commit.
    private var restingGlow: CGFloat {
        guard shown != nil else { return 0 }
        guard settled else { return ScaleMetrics.restGlow }
        if kind == .energy && value == 10 { return ScaleMetrics.endGlow }
        if kind == .mood && value == 10 { return ScaleMetrics.flareGlow }
        return ScaleMetrics.restGlow
    }
}

private struct HeadMotion {
    var scale: CGFloat = 1
    var squash: CGFloat = 1
    var stretch: CGFloat = 1
    var glow: CGFloat = 0
    var dim: Double = 1
}

private struct HeadBeat {
    let value: CGFloat
    let seconds: Double

    init(_ value: CGFloat, _ seconds: Double) {
        self.value = value
        self.seconds = seconds
    }

    static func still(_ value: CGFloat, count: Int) -> [HeadBeat] {
        Array(repeating: HeadBeat(value, 0.001), count: count)
    }
}

// MARK: - The surge: four Canvas draws, no display link

private struct Bolt {
    let points: [CGPoint]
    let isMain: Bool
}

struct SurgeArcs: View {
    let span: CGFloat
    let night: Bool
    let energy: Color
    let core: Color
    let glow: Color
    let reduceMotion: Bool

    @State private var beat = 0
    @State private var shown = false

    // Three sets, drawn once at build: deterministic amplitude, random detail, and no rng in a draw.
    private let beats: [[Bolt]]

    init(span: CGFloat, night: Bool, energy: Color, core: Color, glow: Color, reduceMotion: Bool) {
        self.span = span
        self.night = night
        self.energy = energy
        self.core = core
        self.glow = glow
        self.reduceMotion = reduceMotion
        let y = ScaleMetrics.row / 2
        beats = [
            Self.set(span: span, y: y, sparse: !night, amplitudes: [11, 17, 7]),
            Self.set(span: span, y: y, sparse: !night, amplitudes: [11, 17, 7]),
            Self.set(span: span, y: y, sparse: true, amplitudes: [17])
        ]
    }

    var body: some View {
        Canvas { context, _ in
            draw(beats[min(beat, beats.count - 1)], in: context)
        }
        .opacity(reduceMotion ? (shown ? 1 : 0) : (beat == 2 ? 0.7 : 1))
        .task {
            guard !reduceMotion else {
                beat = 1
                withAnimation(.easeOut(duration: 0.18)) { shown = true }
                try? await Task.sleep(for: .milliseconds(600))
                withAnimation(.easeIn(duration: 0.32)) { shown = false }
                return
            }
            try? await Task.sleep(for: .milliseconds(90))
            beat = 1
            try? await Task.sleep(for: .milliseconds(70))
            beat = 2
        }
    }

    private func draw(_ bolts: [Bolt], in context: GraphicsContext) {
        if night {
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 2.2))
                for bolt in bolts {
                    layer.stroke(path(bolt), with: .color(energy.opacity(0.55)),
                                 style: stroke(bolt.isMain ? 3.5 : 2.0))
                }
            }
            for bolt in bolts {
                context.stroke(path(bolt), with: .color(core), style: stroke(bolt.isMain ? 1.25 : 0.75))
            }
            return
        }
        // Paper does not glow: the day arc is one struck pass lifted by an ink shadow, never a halo.
        context.drawLayer { layer in
            layer.addFilter(.shadow(color: glow, radius: 2.6))
            for bolt in bolts {
                layer.stroke(path(bolt), with: .color(core), style: stroke(bolt.isMain ? 2.2 : 1.6))
            }
        }
    }

    private func path(_ bolt: Bolt) -> Path {
        var path = Path()
        path.addLines(bolt.points)
        return path
    }

    private func stroke(_ width: CGFloat) -> StrokeStyle {
        StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .miter)
    }

    // Lightning is angular and it is a discharge, not a random walk: the sign alternates by force
    // and the magnitude is floored, so no fire can come out a straight line.
    private static func arc(x0: CGFloat, x1: CGFloat, y: CGFloat,
                            amplitude: CGFloat, segments: Int) -> [CGPoint] {
        (0...segments).map { i in
            let t = CGFloat(i) / CGFloat(segments)
            let envelope = sin(.pi * t)
            let sign: CGFloat = i.isMultiple(of: 2) ? 1 : -1
            let magnitude = 0.55 + 0.45 * CGFloat.random(in: 0...1)
            return CGPoint(x: x0 + (x1 - x0) * t, y: y + sign * magnitude * amplitude * envelope)
        }
    }

    private static func set(span: CGFloat, y: CGFloat, sparse: Bool, amplitudes: [CGFloat]) -> [Bolt] {
        let mains = (sparse ? Array(amplitudes.prefix(1)) : amplitudes).map {
            Bolt(points: arc(x0: 0, x1: span, y: y, amplitude: $0, segments: 9), isMain: true)
        }
        let branches = (0..<2).map { _ -> Bolt in
            let width = span * CGFloat.random(in: 0.22...0.34)
            let start = CGFloat.random(in: 0...max(span - width, 1))
            return Bolt(points: arc(x0: start, x1: start + width, y: y, amplitude: 7, segments: 4),
                        isMain: false)
        }
        return mains + branches
    }
}

// MARK: - The flare: the lamp opens

private struct FlareBurst: View {
    let head: CGFloat
    let colour: Color
    let width: CGFloat
    let reduceMotion: Bool

    @State private var open = false
    @State private var lit = false

    // Six slow dots of ember rising out of a lamp: smoke off a candle, not confetti. Their drift is
    // drawn once, or a redraw would make them jump.
    private let motes: [(drift: CGFloat, rise: CGFloat, seconds: Double)]

    private let headDiameter = ScaleKind.mood.headSize.width
    private let reach = ScaleMetrics.flareReach

    // Slightly above either desktop ring's 0.55, and level with what the two composited to at rest.
    private static let ringPeak: Double = 0.62

    init(head: CGFloat, colour: Color, width: CGFloat, reduceMotion: Bool) {
        self.head = head
        self.colour = colour
        self.width = width
        self.reduceMotion = reduceMotion
        motes = (0..<6).map { _ in
            (CGFloat.random(in: -10...10), CGFloat.random(in: 18...34), Double.random(in: 0.9...1.3))
        }
    }

    private var opened: CGFloat { (headDiameter + reach) / headDiameter }

    var body: some View {
        ZStack(alignment: .leading) {
            RadialGradient(colors: [colour.opacity(0.11), .clear], center: .center,
                           startRadius: 0, endRadius: 110)
                .frame(width: 220, height: 120)
                .offset(x: head - 110)
                .opacity(lit ? 1 : 0)

            // ONE ring on the phone, not the desktop's two. Clamped to +28 they are 120ms apart
            // across 23pt and merge into a single thick halo, so this draws that halo once and
            // well: 800ms, the mean of the desktop pair's 720 and 860, at their composited alpha.
            // When the room shrinks the count comes down; the same count never crowds into it.
            // Under reduced motion the ring is drawn at its final radius and fades: the event
            // survives, the expansion goes.
            //
            // strokeBorder, not stroke: the clamp of §6.4 is on the ring's OUTER face, and
            // strokeBorder is what puts that face exactly on ScaleMetrics.transientRadius.
            Circle()
                .strokeBorder(colour, lineWidth: 1)
                .frame(width: headDiameter, height: headDiameter)
                .scaleEffect(reduceMotion || open ? opened : 1)
                .opacity(open ? 0 : Self.ringPeak)
                .offset(x: head - headDiameter / 2)
                .animation(reduceMotion ? .easeOut(duration: 0.4)
                           : .timingCurve(0.22, 0.61, 0.36, 1, duration: 0.8),
                           value: open)

            if !reduceMotion {
                ForEach(Array(motes.enumerated()), id: \.offset) { index, mote in
                    Circle()
                        .fill(colour)
                        .frame(width: 1.5, height: 1.5)
                        .offset(x: head + mote.drift, y: open ? -mote.rise : 0)
                        .opacity(open ? 0 : 0.8)
                        .animation(.timingCurve(0.16, 0.72, 0.30, 1, duration: mote.seconds)
                            .delay(Double(index) * 0.032), value: open)
                }
            }
        }
        .frame(width: width, height: ScaleMetrics.row, alignment: .leading)
        .task {
            withAnimation(.easeOut(duration: 0.3)) { lit = true }
            open = true
            try? await Task.sleep(for: .milliseconds(420))
            withAnimation(.easeOut(duration: 0.9)) { lit = false }
        }
    }
}

// MARK: - The ground: the charge leaves

private struct GroundStrike: View {
    let width: CGFloat
    let colour: Color
    let reduceMotion: Bool

    @State private var run = false
    @State private var gone = false

    var body: some View {
        ZStack(alignment: .leading) {
            // The track shows its whole empty range once, and stops dead at the far end.
            LinearGradient(colors: [.clear, colour.opacity(0.22), .clear],
                           startPoint: .leading, endPoint: .trailing)
                .frame(width: width * 0.3, height: ScaleMetrics.bed)
                .offset(x: run ? width * 0.7 : 0)
                .opacity(reduceMotion || gone ? 0 : 1)
                .animation(reduceMotion ? nil : .timingCurve(0.22, 0.61, 0.36, 1, duration: 0.54), value: run)
                .animation(.easeOut(duration: 0.2), value: gone)

            if reduceMotion {
                // No sweep: the bed cross-fades once and back, which is the same statement standing still.
                Rectangle()
                    .fill(colour.opacity(run && !gone ? 0.14 : 0))
                    .frame(width: width, height: ScaleMetrics.bed)
                    .animation(.easeInOut(duration: 0.18), value: run)
                    .animation(.easeInOut(duration: 0.18), value: gone)
            } else {
                // One mote, falling: the floor is quieter in texture, equal in duration.
                Circle()
                    .fill(colour.opacity(0.55))
                    .frame(width: 2, height: 2)
                    .offset(x: width / 2, y: run ? 9 : 0)
                    .opacity(run ? 0 : 1)
                    .animation(.easeIn(duration: 0.7), value: run)
            }
        }
        .frame(width: width, height: ScaleMetrics.row, alignment: .leading)
        .task {
            run = true
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 180 : 560))
            gone = true
        }
    }
}

// MARK: - The hold: the ember dims and comes back

private struct HoldDip: View {
    let head: CGFloat
    let width: CGFloat
    let ring: Color
    let sweep: Color
    let headDiameter: CGFloat
    let reduceMotion: Bool

    @State private var run = false
    @State private var gone = false

    private var start: CGFloat { headDiameter + 40 }
    private var landing: CGFloat { headDiameter + ScaleMetrics.heldRingClearance }

    var body: some View {
        ZStack(alignment: .leading) {
            LinearGradient(colors: [.clear, sweep.opacity(0.4), .clear],
                           startPoint: .leading, endPoint: .trailing)
                .frame(width: width * 0.3, height: ScaleMetrics.bed)
                .offset(x: run ? width * 0.7 : 0)
                .opacity(reduceMotion || gone ? 0 : 1)
                .animation(reduceMotion ? nil : .timingCurve(0.22, 0.61, 0.36, 1, duration: 0.54), value: run)
                .animation(.easeOut(duration: 0.2), value: gone)

            // One ring, contracting inward — the mirror of the flare's two, and it lands in the mark
            // the value keeps rather than evaporating. Reduced motion keeps the mark and drops the trip.
            if !reduceMotion {
                Circle()
                    .stroke(ring, lineWidth: 1)
                    .frame(width: start, height: start)
                    .scaleEffect(run ? landing / start : 1)
                    .opacity(run ? 0 : 0.5)
                    .offset(x: head - start / 2)
                    .animation(.timingCurve(0.22, 0.61, 0.36, 1, duration: 0.78), value: run)
            }
        }
        .frame(width: width, height: ScaleMetrics.row, alignment: .leading)
        .task {
            run = true
            try? await Task.sleep(for: .milliseconds(560))
            gone = true
        }
    }
}
