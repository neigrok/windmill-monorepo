import SwiftUI

// The brand's raw scales, mirrored for native — the same values web/src/styles/tokens/*.css holds,
// which is what packages/design-tokens exists to keep honest. Product-neutral by construction: a
// product that needs its own surface (journal's night, gym's palette) overrides these inside its
// own scope, exactly as the web products override role tokens inside their own class.

public enum WindmillColor {
    public static let neutral0 = Color(hex: 0xFFFFFF)
    public static let neutral25 = Color(hex: 0xFDFBF6)
    public static let neutral50 = Color(hex: 0xF9F5EB)
    public static let neutral100 = Color(hex: 0xF1EADA)
    public static let neutral200 = Color(hex: 0xE5D9C0)
    public static let neutral300 = Color(hex: 0xD3C2A0)
    public static let neutral400 = Color(hex: 0xB29F7B)
    public static let neutral500 = Color(hex: 0x92805F)
    public static let neutral600 = Color(hex: 0x6F5F45)
    public static let neutral700 = Color(hex: 0x514431)
    public static let neutral800 = Color(hex: 0x372E21)
    public static let neutral900 = Color(hex: 0x211B13)

    public static let gold400 = Color(hex: 0xD9B04C)
    public static let olive400 = Color(hex: 0x9AA859)
    public static let olive500 = Color(hex: 0x7D8C43)

    public static let surfaceCanvas = neutral50
    public static let surfaceCard = neutral0
    public static let textPrimary = neutral900
    public static let textSecondary = neutral600
    public static let textTertiary = neutral500
    public static let borderSubtle = neutral200
    public static let borderDefault = neutral300
}

// tokens/fonts.css names the brand faces and then names the native fallback for each in the same
// declaration: ui-rounded for display and body, ui-monospace for numerals. On this platform those
// ARE SF Pro Rounded and SF Mono, so the system designs below are not an approximation of the
// tokens — they are the branch of the token the token itself points at. No woff2 to bundle.
public enum WindmillFont {
    public static func display(_ size: CGFloat, _ weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }

    public static func body(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }

    public static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

public enum WindmillSpace {
    public static let x1: CGFloat = 4
    public static let x2: CGFloat = 8
    public static let x3: CGFloat = 12
    public static let x4: CGFloat = 16
    public static let x5: CGFloat = 20
    public static let x6: CGFloat = 24
    public static let x8: CGFloat = 32
    public static let x10: CGFloat = 40
    public static let x12: CGFloat = 48
    public static let x16: CGFloat = 64
}

public enum WindmillRadius {
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
    public static let xl: CGFloat = 24
    public static let full: CGFloat = 999
}

public extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
