import SwiftUI
import WindmillPlatform

// The native twin of web/src/products/gym/logger/entry.js.

public enum KeypadEntry {
    public enum Mode: Equatable {
        case weight
        case reps
    }

    public static let maxBuffer = 8
    public static let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "±", "0", ","]
    public static let weightHint = "kg  ·  comma or point both read as a decimal  ·  ± for band-assisted"
    public static let repsHint = "whole reps"

    public struct Pad: Equatable {
        // The buffer is ASCII: a U+2212 minus is normalised on the way in and re-spelled by `echo` on the way out.
        // `seeded` means nothing has been typed yet: the first digit starts a fresh number, ± and ⌫ edit what is there.
        public let text: String
        public let seeded: Bool

        public init(opening current: String) {
            text = current.replacingOccurrences(of: "\u{2212}", with: "-")
            seeded = true
        }

        init(text: String, seeded: Bool) {
            self.text = text
            self.seeded = seeded
        }

        public var echo: String {
            if text.isEmpty { return "—" }
            guard text.hasPrefix("-") else { return text }
            return "\u{2212}" + text.dropFirst()
        }

        public func pressing(_ key: String, in mode: Mode) -> Pad {
            guard KeypadEntry.isLive(key, in: mode) else { return self }
            if key == "±" {
                if text.hasPrefix("-") { return Pad(text: String(text.dropFirst()), seeded: false) }
                guard text.count < KeypadEntry.maxBuffer else { return self }
                return Pad(text: "-" + text, seeded: false)
            }
            let held = seeded ? "" : text
            guard held.count < KeypadEntry.maxBuffer else { return self }
            return Pad(text: held + key, seeded: false)
        }

        public var backspaced: Pad {
            Pad(text: String(text.dropLast()), seeded: false)
        }
    }

    public struct Reading: Equatable {
        public let value: Double?
        public let message: String

        public var isValid: Bool { value != nil }
    }

    public static func isLive(_ key: String, in mode: Mode) -> Bool {
        guard mode == .reps else { return true }
        return key != "," && key != "±"
    }

    public static func read(_ pad: Pad, as mode: Mode, keeping current: Double) -> Reading {
        let raw = pad.text.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty, raw != "-" else {
            return Reading(value: nil, message: "Enter a number, or cancel to keep \(Readout.weight(current))")
        }
        let normalised = raw.replacingOccurrences(of: ",", with: ".")
        guard normalised.filter({ $0 == "." }).count <= 1 else {
            return Reading(value: nil, message: "One decimal point only — 72,5 or 72.5")
        }
        guard let value = Double(normalised), value.isFinite else {
            return Reading(value: nil, message: "Not a number yet — 72,5 reads as 72.5")
        }
        guard mode == .reps else {
            guard abs(value) <= 500 else {
                return Reading(value: nil, message: "Over 500 kg — check the number")
            }
            return Reading(value: Ladder.round(value), message: weightHint)
        }
        // The server refuses reps < 1.
        guard value >= 1, value <= 99, value == value.rounded() else {
            return Reading(value: nil, message: "Whole reps, 1 to 99")
        }
        return Reading(value: value, message: repsHint)
    }
}

struct KeypadSheet: View {
    let mode: KeypadEntry.Mode
    let current: Double
    let onCommit: (Double) -> Void
    let onCancel: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var pad: KeypadEntry.Pad

    init(mode: KeypadEntry.Mode, current: Double,
         onCommit: @escaping (Double) -> Void, onCancel: @escaping () -> Void) {
        self.mode = mode
        self.current = current
        self.onCommit = onCommit
        self.onCancel = onCancel
        let opening = mode == .weight ? Readout.weight(current) : String(Int(current))
        _pad = State(initialValue: KeypadEntry.Pad(opening: opening))
    }

    var body: some View {
        let reading = KeypadEntry.read(pad, as: mode, keeping: current)
        return VStack(spacing: WindmillSpace.x4) {
            Text(mode == .weight ? "Weight" : "Reps")
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(pad.echo)
                .font(WindmillFont.display(56, .heavy).monospacedDigit())
                .foregroundStyle(reading.isValid ? skin.weightInk : skin.alarmInk)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(reading.message)
                .font(GymType.numeral(12))
                .foregroundStyle(reading.isValid ? skin.inkFaint : skin.alarmInk)
                .frame(maxWidth: .infinity, alignment: .leading)

            LazyVGrid(columns: Array(repeating: GridItem(spacing: WindmillSpace.x2), count: 3),
                      spacing: WindmillSpace.x2) {
                ForEach(KeypadEntry.keys, id: \.self) { key in
                    Button { pad = pad.pressing(key, in: mode) } label: {
                        Text(key)
                            .font(WindmillFont.display(24, .semibold).monospacedDigit())
                            .foregroundStyle(KeypadEntry.isLive(key, in: mode) ? skin.ink : skin.inkFaint)
                            .frame(maxWidth: .infinity, minHeight: 58)
                            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.raised))
                    }
                }
            }

            HStack(spacing: WindmillSpace.x3) {
                Button("Cancel", action: onCancel)
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.inkDim)
                    .frame(minWidth: 88, minHeight: GymTap.minimum)

                Button { pad = pad.backspaced } label: {
                    Text("⌫")
                        .font(WindmillFont.body(20))
                        .foregroundStyle(skin.ink)
                        .frame(minWidth: GymTap.minimum, minHeight: GymTap.minimum)
                }

                Button { if let value = reading.value { onCommit(value) } } label: {
                    Text("Set")
                        .font(WindmillFont.body(17, .bold))
                        .foregroundStyle(reading.isValid ? skin.onAccent : skin.inkFaint)
                        .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                            .fill(reading.isValid ? skin.accent : skin.raised))
                }
            }
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(skin.surface)
    }
}
