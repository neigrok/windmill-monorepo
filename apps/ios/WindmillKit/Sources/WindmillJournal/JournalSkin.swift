import SwiftUI
import WindmillPlatform

public struct JournalSkin {
    public let canvas: Color
    public let card: Color
    public let lamp: Color          // the caret, the waiting ember
    public let ink: Color           // prose the person writes
    public let inkDim: Color        // the mono strip, the margin
    public let gap: Color           // a day not written
    public let energy: Color
    public let surgeCore: Color     // the arc's hot core: olive driven to its extreme, never a foreign hue
    public let mood: [Color]        // one hue in eleven steps, indexed 0...10
    public let swatchEdge: Color    // the unset head, the day pip, the week square, the year cell
    public let headRing: Color      // the SET head, always the stronger of the two
    public let focus: Color

    public static let night = JournalSkin(
        canvas: Color(hex: 0x040D19),
        card: Color(hex: 0x0D1824),
        lamp: Color(hex: 0xE0B972),
        ink: Color(hex: 0xF2ECDE),
        inkDim: Color(hex: 0x8A98AC),
        gap: Color(hex: 0x3C3223),
        energy: Color(hex: 0x9AA859),
        surgeCore: Color(hex: 0xF4F7E2),
        mood: [0x5E4D2E, 0x6E5A34, 0x7F673A, 0x8F7440, 0xA08247, 0xB08F4E,
               0xBD9B57, 0xC9A75F, 0xD5B069, 0xE0B972, 0xECC27C].map(Color.init(hex:)),
        swatchEdge: Color(hex: 0xF2ECDE).opacity(0.34),
        headRing: Color(hex: 0xF2ECDE).opacity(0.78),
        focus: Color(hex: 0xF2ECDE).opacity(0.88)
    )

    public static let day = JournalSkin(
        canvas: Color(hex: 0xF7F7F5),
        card: Color(hex: 0xFFFFFF),
        lamp: Color(hex: 0x986B1E),
        ink: Color(hex: 0x2A2118),
        inkDim: Color(hex: 0x74654F),
        gap: Color(hex: 0xD3C2A0),
        energy: Color(hex: 0x7D8C43),
        surgeCore: Color(hex: 0x3F4A16),
        mood: [0xEDDFB7, 0xE4CF9C, 0xDCBF81, 0xD3AF66, 0xC99F52, 0xBE8F3D,
               0xB2822E, 0xA5741F, 0x986919, 0x8A5E12, 0x7D530B].map(Color.init(hex:)),
        swatchEdge: Color(hex: 0x2A2118).opacity(0.46),
        headRing: Color(hex: 0x2A2118).opacity(0.68),
        focus: Color(hex: 0x2A2118).opacity(0.88)
    )

    // The eleven-step ramp, where the value is entered.
    public func mood(_ score: Int?) -> Color {
        guard let score else { return ink.opacity(0.26) }
        return mood[max(0, min(10, score))]
    }

    // The five bands, everywhere the value is read.
    public func moodBand(_ score: Int?) -> Color {
        guard let score else { return ink.opacity(0.26) }
        return mood[Scale.moodBand(max(0, min(10, score)))]
    }

    // A bloom by night, an ink shadow by day: paper does not glow, it casts shadows.
    public func headGlow(_ fill: Color, atEnd: Bool) -> Color {
        isNight ? fill.opacity(atEnd ? 0.78 : 0.45) : ink.opacity(atEnd ? 0.26 : 0.14)
    }

    public var isNight: Bool { self == JournalSkin.night }
}

extension JournalSkin: Equatable {}

private struct JournalSkinKey: EnvironmentKey {
    static let defaultValue = JournalSkin.night
}

public extension EnvironmentValues {
    var journalSkin: JournalSkin {
        get { self[JournalSkinKey.self] }
        set { self[JournalSkinKey.self] = newValue }
    }
}
