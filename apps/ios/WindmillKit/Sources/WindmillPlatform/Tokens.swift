import SwiftUI
import UIKit

// The brand's scales for native, plus the one treatment where two of them must be chosen together.
// The values are the ones web/src/styles/tokens/colors.css holds, mirrored BY HAND: nothing checks
// the two files against each other (packages/design-tokens, which would, is still only a README),
// so a hue that moves on one surface has to be carried to the other. Product-neutral by
// construction: a product that needs its own surface (journal's night, gym's palette) overrides
// these inside its own scope, exactly as the web products override role tokens inside their class.

// The ramp is ADAPTIVE and the roles below are aliases onto it — the same structure
// web/src/styles/tokens/colors.css uses, where `[data-theme="dark"]` re-authors the ramp and every
// role token that references it follows for free. That is why turning the shell dark needed no
// change at a single call site: `surfaceCanvas` IS `neutral50`, in both skins.
//
// The dark ramp is re-authored, never a linear inversion: low indices stay deep warm surfaces and
// high indices become warm off-whites for text, so a role that meant "canvas" still means canvas.
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

    // Ink for text that sits ON a bright accent fill. Fixed in both skins: the fill is the same
    // gold either way, so the ink on it must be too — 8.92:1 on gold400, where the adaptive ramp
    // reaches for its dark end and reads 1.77:1.
    public static let onAccent = Color(hex: 0x1B1408)

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

// The weight of an action, and with it BOTH of the colours that say so. Fill and ink were two
// separate decisions at every call site, and every gold capsule in the app picked the adaptive ramp
// for its label — warm near-white on gold, 1.77:1, in a dark mode reachable from You. Pairing them
// here is what stops that being writable again, rather than merely fixed once.
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
    // One token, two skins, resolved by the trait environment rather than by a branch at the call
    // site — so a view never has to ask which appearance it is in.
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
