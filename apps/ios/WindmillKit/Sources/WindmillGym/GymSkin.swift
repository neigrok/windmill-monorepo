import SwiftUI
import WindmillPlatform

// Gym's palette, step for step with `[data-theme="dark"][data-brand="gym"]` in web/src/styles/tokens/palettes.css.

public struct GymSkin: Equatable {
    public let canvas: Color
    public let surface: Color
    public let raised: Color
    public let sunken: Color
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
        canvas: Color(hex: 0x0B1111),
        surface: Color(hex: 0x161C1D),  // --surface-card
        raised: Color(hex: 0x202627),
        sunken: Color(hex: 0x060C0C),  // --surface-sunken
        line: Color(hex: 0x202627),
        lineStrong: Color(hex: 0x2A3133),
        accent: Color(hex: 0x5FCDB4),  // verdigris-400
        accentSoft: Color(hex: 0x5FCDB4).opacity(0.20),  // --color-brand-soft
        onAccent: Color(hex: 0x1B1408),
        weightInk: Color(hex: 0xF1F0EB),
        ink: Color(hex: 0xF1F0EB),
        inkDim: Color(hex: 0xB6B5AF),
        inkFaint: Color(hex: 0x727771),
        setDone: Color(hex: 0x9AA859),  // olive-400
        setDoneSoft: Color(hex: 0x9AA859).opacity(0.15),  // --color-success-bg
        targetInk: Color(hex: 0x5FCDB4),
        prInk: Color(hex: 0xD9B04C),  // gold-400
        warmupInk: Color(hex: 0x727771),
        unsyncedInk: Color(hex: 0x727771),
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
    public static let row: CGFloat = 52
    public static let secondary: CGFloat = 56
}

public enum GymLayout {
    public static let gutter = WindmillSpace.x5
    public static let cardInset = WindmillSpace.x4
    public static let rowInset = WindmillSpace.x3
    public static let cardGap = WindmillSpace.x2
    public static let blockGap = WindmillSpace.x3
    public static let sectionGap = WindmillSpace.x4
    public static let pair = WindmillSpace.x1
    public static let scrollTail = WindmillSpace.x8
    public static let scrollTailBand = WindmillSpace.x4
    public static let contentTop = WindmillSpace.x4
}

