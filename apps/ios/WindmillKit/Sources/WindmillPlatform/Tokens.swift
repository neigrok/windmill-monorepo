import SwiftUI
import UIKit

// Mirrors web/src/styles/tokens/colors.css by hand; nothing checks the two files against each other.
public enum WindmillColor {
    public static let neutral0 = Color(light: 0xFFFFFF, dark: 0x17120B)
    public static let neutral25 = Color(light: 0xFDFBF6, dark: 0x14100A)
    public static let neutral50 = Color(light: 0xF9F5EB, dark: 0x0D0B07)
    public static let neutral100 = Color(light: 0xF1EADA, dark: 0x221B12)
    public static let neutral200 = Color(light: 0xE5D9C0, dark: 0x2E2618)
    public static let neutral300 = Color(light: 0xD3C2A0, dark: 0x3C3223)
    public static let neutral400 = Color(light: 0xB29F7B, dark: 0x574A35)
    public static let neutral500 = Color(light: 0x92805F, dark: 0x8A785A)
    public static let neutral600 = Color(light: 0x6F5F45, dark: 0xAE9A75)
    public static let neutral700 = Color(light: 0x514431, dark: 0xCDBC97)
    public static let neutral800 = Color(light: 0x372E21, dark: 0xE6DAC1)
    public static let neutral900 = Color(light: 0x211B13, dark: 0xF4EEDF)

    public static let gold400 = Color(hex: 0xD9B04C)
    public static let olive400 = Color(hex: 0x9AA859)
    public static let olive500 = Color(hex: 0x7D8C43)

    // Ink for text on a bright accent fill; fixed in both skins.
    public static let onAccent = Color(hex: 0x1B1408)

    public static let surfaceCanvas = neutral50
    public static let surfaceCard = neutral0
    public static let textPrimary = neutral900
    public static let textSecondary = neutral600
    public static let textTertiary = neutral500
    public static let borderSubtle = neutral200
    public static let borderDefault = neutral300
}

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

public enum ActionWeight {
    case primary
    case quiet
}

public extension View {
    func actionCapsule(_ weight: ActionWeight) -> some View {
        foregroundStyle(weight == .primary ? WindmillColor.onAccent : WindmillColor.textPrimary)
            .background {
                switch weight {
                case .primary: Capsule().fill(WindmillColor.gold400)
                case .quiet: Capsule().strokeBorder(WindmillColor.borderDefault, lineWidth: 1)
                }
            }
    }
}

public extension Color {
    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { traits in
            UIColor(Color(hex: traits.userInterfaceStyle == .dark ? dark : light))
        })
    }

    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
