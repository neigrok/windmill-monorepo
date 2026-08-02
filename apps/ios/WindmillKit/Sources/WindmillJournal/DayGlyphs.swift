import SwiftUI
import WindmillPlatform

// The small marks a day wears, and the two optional scales — the native DayMarker.jsx / MoodDots.jsx
// / EnergyBars.jsx. Grouped in one file because they are one kind of thing: the glance summary of a
// day, none of them larger than a few dozen lines, all three meaningless apart.

// The day marker — mono date, a mood pip, an energy tick. The date and the word count are mono so
// the eye skips them; the pip and the tick are the day at a glance.
struct DayMarkerView<Trailing: View>: View {
    let day: LocalDay
    var mood: Mood = .none
    var energy: Energy = .none
    var written = false
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
                MoodPip(mood: mood, written: written, isToday: isToday)
                EnergyTick(energy: energy)
            }
        }
        .padding(.top, WindmillSpace.x2)
        .padding(.bottom, 6)
    }

    // "SUN 20 JUL" — the weekday computed from the day itself, never from a formatter's locale
    // ordering, so the string is the same shape wherever the phone is.
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
    init(day: LocalDay, mood: Mood = .none, energy: Energy = .none, written: Bool = false,
         wordCount: Int = 0, isToday: Bool = false) {
        self.init(day: day, mood: mood, energy: energy, written: written,
                  wordCount: wordCount, isToday: isToday) { EmptyView() }
    }
}

private struct MoodPip: View {
    let mood: Mood
    let written: Bool
    let isToday: Bool

    @Environment(\.journalSkin) private var skin
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        // Today's pip is the one infinite loop allowed on screen — a breathing ember (canon §10,
        // the calm ceiling). Reduced motion gets the same ember, held still.
        if isToday {
            Circle()
                .fill(mood.isSet ? skin.mood(mood) : skin.lamp)
                .frame(width: 10, height: 10)
                .opacity(breathing ? 0.55 : 1)
                .animation(reduceMotion ? nil : .easeInOut(duration: 1).repeatForever(autoreverses: true),
                           value: breathing)
                .onAppear { if !reduceMotion { breathing = true } }
        } else if !written {
            Circle()
                .strokeBorder(skin.gap, lineWidth: 1.5)
                .frame(width: 10, height: 10)
        } else {
            Circle()
                .fill(skin.mood(mood))
                .frame(width: 10, height: 10)
        }
    }
}

private struct EnergyTick: View {
    let energy: Energy
    @Environment(\.journalSkin) private var skin

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(1...3, id: \.self) { step in
                Capsule()
                    .fill(energy.rawValue >= step ? skin.energy : skin.gap)
                    .frame(width: 2.5, height: [5, 7, 9][step - 1])
            }
        }
        .frame(height: 10, alignment: .bottom)
    }
}

// The mood scale — five dots, one hue in five steps. Tapping fills the ramp up to that step and
// tints every lit dot to that step's hue; tapping the step you are on clears it. Optional always.
struct MoodDots: View {
    let value: Mood
    let onTap: (Mood) -> Void

    @Environment(\.journalSkin) private var skin

    var body: some View {
        HStack(spacing: WindmillSpace.x2) {
            ForEach(Mood.allCases.filter(\.isSet), id: \.rawValue) { step in
                let lit = value.isSet && step.rawValue <= value.rawValue
                Circle()
                    .fill(lit ? skin.mood(value) : Color.clear)
                    .overlay(Circle().strokeBorder(lit ? Color.clear : skin.gap, lineWidth: 1.5))
                    .frame(width: 16, height: 16)
                    .contentShape(Circle().inset(by: -8))
                    .onTapGesture { onTap(step) }
                    .animation(.easeInOut(duration: 0.18), value: value)
                    .accessibilityLabel("Mood \(step.rawValue) of 5")
                    .accessibilityAddTraits(value == step ? [.isSelected, .isButton] : .isButton)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Mood")
    }
}

// The energy scale — three bars of rising height, olive. Never the mood hue, never red.
struct EnergyBars: View {
    let value: Energy
    let onTap: (Energy) -> Void

    @Environment(\.journalSkin) private var skin

    var body: some View {
        HStack(alignment: .bottom, spacing: WindmillSpace.x1) {
            ForEach(Energy.allCases.filter(\.isSet), id: \.rawValue) { step in
                let lit = value.rawValue >= step.rawValue
                Capsule()
                    .fill(lit ? skin.energy : skin.gap)
                    .frame(width: 5, height: [10, 15, 20][step.rawValue - 1])
                    .contentShape(Rectangle().inset(by: -10))
                    .onTapGesture { onTap(step) }
                    .animation(.easeInOut(duration: 0.18), value: value)
                    .accessibilityLabel("Energy \(step.rawValue) of 3")
                    .accessibilityAddTraits(value == step ? [.isSelected, .isButton] : .isButton)
            }
        }
        .frame(height: 20, alignment: .bottom)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Energy")
    }
}
