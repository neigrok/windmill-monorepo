import SwiftUI
import WindmillPlatform

// Gym's palette, step for step with `[data-theme="dark"][data-brand="gym"]` in web/src/styles/tokens/palettes.css.

public struct GymSkin: Equatable {
    public let canvas: Color
    public let surface: Color
    public let raised: Color
    public let line: Color
    public let lineStrong: Color
    public let accent: Color
    public let accentSoft: Color
    public let onAccent: Color
    public let weightInk: Color
    public let ink: Color
    public let inkDim: Color
    public let inkFaint: Color
    public let setDone: Color
    public let setDoneSoft: Color  // ground under a line a proposal would add
    public let targetInk: Color
    public let prInk: Color
    public let warmupInk: Color
    public let unsyncedInk: Color  // saved on this device only
    public let alarmInk: Color  // a write that failed
    public let alarmSoft: Color  // ground under a line a proposal would remove

    public static let instrument = GymSkin(
        canvas: Color(hex: 0x1C1A1E),  // neutral-50
        surface: Color(hex: 0x262329),  // neutral-0
        raised: Color(hex: 0x2E2B32),  // neutral-100
        line: Color(hex: 0x39363E),  // neutral-200
        lineStrong: Color(hex: 0x48444D),  // neutral-300
        accent: Color(hex: 0x9A90BE),  // iris-300
        accentSoft: Color(hex: 0x3A3358).opacity(0.22),  // iris-700
        onAccent: Color(hex: 0x1B1408),
        weightInk: Color(hex: 0xEDEBF0),  // neutral-900
        ink: Color(hex: 0xEDEBF0),
        inkDim: Color(hex: 0xB0ABB8),  // neutral-600
        inkFaint: Color(hex: 0x8D8896),  // neutral-500
        setDone: Color(hex: 0x9AA859),  // olive-400
        setDoneSoft: Color(hex: 0x9AA859).opacity(0.15),  // --color-success-bg
        targetInk: Color(hex: 0x9A90BE),
        prInk: Color(hex: 0xD9B04C),  // gold-400
        warmupInk: Color(hex: 0x8D8896),
        unsyncedInk: Color(hex: 0x8D8896),
        alarmInk: Color(hex: 0xD08268),  // brick-300
        alarmSoft: Color(hex: 0xBF6A50).opacity(0.16)  // --color-danger-bg
    )
}

private struct GymSkinKey: EnvironmentKey {
    static let defaultValue = GymSkin.instrument
}

public extension EnvironmentValues {
    var gymSkin: GymSkin {
        get { self[GymSkinKey.self] }
        set { self[GymSkinKey.self] = newValue }
    }
}

public enum GymType {
    public static let weight = WindmillFont.display(104, .heavy).monospacedDigit()
    public static let reps = WindmillFont.display(36, .heavy).monospacedDigit()
    public static let correction = WindmillFont.display(72, .heavy).monospacedDigit()

    public static func numeral(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        WindmillFont.mono(size, weight).monospacedDigit()
    }
}

public enum GymTap {
    public static let minimum: CGFloat = 46
    public static let primary: CGFloat = 64
}

