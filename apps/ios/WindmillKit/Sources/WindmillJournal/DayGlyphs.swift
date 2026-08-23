import SwiftUI
import WindmillPlatform

struct DayMarkerView<Trailing: View>: View {
    let day: LocalDay
    var mood: Mood = .none
    var energy: Energy = .none
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
    init(day: LocalDay, mood: Mood = .none, energy: Energy = .none,
         wordCount: Int = 0, isToday: Bool = false) {
        self.init(day: day, mood: mood, energy: energy,
                  wordCount: wordCount, isToday: isToday) { EmptyView() }
    }
}

private struct MoodPip: View {
    let mood: Mood
    let isToday: Bool

    @Environment(\.journalSkin) private var skin
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        if isToday {
            Circle()
                .fill(mood.isSet ? skin.mood(mood) : skin.lamp)
                .frame(width: 10, height: 10)
                .opacity(breathing ? 0.55 : 1)
                .animation(reduceMotion ? nil : .easeInOut(duration: 1).repeatForever(autoreverses: true),
                           value: breathing)
                .onAppear { if !reduceMotion { breathing = true } }
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

struct ScaleChip: ViewModifier {
    let skin: JournalSkin

    func body(content: Content) -> some View {
        content
            .font(WindmillFont.body(11.5, .bold))
            .foregroundStyle(skin.lamp)
            .padding(.horizontal, WindmillSpace.x3)
            .padding(.vertical, 7)
            .background(Capsule().strokeBorder(skin.lamp, lineWidth: 1))
    }
}
