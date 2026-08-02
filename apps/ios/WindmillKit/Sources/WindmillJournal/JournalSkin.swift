import SwiftUI
import WindmillPlatform

// The journal's own surface — the native statement of web/src/products/journal/journal.css. Canon
// §10 is explicit that the product owns this skin and the design system owns the lamp ramp: the
// values below are the shipped ones, and the shell, the seat and the other products are untouched
// by them. Night is the default this surface was designed as; day is a choice, kept per device.

public struct JournalSkin {
    public let canvas: Color
    public let card: Color
    public let lamp: Color          // the lit "Candle" — the caret, the waiting ember
    public let ink: Color           // prose the person writes
    public let inkDim: Color        // the mono strip, the margin
    public let gap: Color           // a day not written — dim, never counted
    public let energy: Color
    public let mood: [Color]        // one hue in five steps: a scale, not five competing colours

    public static let night = JournalSkin(
        canvas: Color(hex: 0x040D19),
        card: Color(hex: 0x0D1824),
        lamp: Color(hex: 0xE0B972),
        ink: Color(hex: 0xF2ECDE),
        inkDim: Color(hex: 0x8A98AC),
        gap: Color(hex: 0x3C3223),
        energy: Color(hex: 0x9AA859),
        mood: [0x6E5A34, 0x8F7440, 0xB08F4E, 0xC9A75F, 0xE0B972].map(Color.init(hex:))
    )

    public static let day = JournalSkin(
        canvas: Color(hex: 0xFBF6EA),
        card: Color(hex: 0xFFFFFF),
        lamp: Color(hex: 0x986B1E),
        ink: Color(hex: 0x2A2118),
        inkDim: Color(hex: 0x74654F),
        gap: Color(hex: 0xD3C2A0),
        energy: Color(hex: 0x7D8C43),
        mood: [0xE4CF9C, 0xD3AF66, 0xBE8F3D, 0xA5741F, 0x8A5E12].map(Color.init(hex:))
    )

    public func mood(_ step: Mood) -> Color {
        step.isSet ? mood[step.rawValue - 1] : ink.opacity(0.26)
    }

    public var isNight: Bool { self == JournalSkin.night }
}

extension JournalSkin: Equatable {}

// Which skin is on. Device-local and deliberately NOT the app's global appearance — the journal is
// the one room that is night by default while everything else stays as the system left it.
public enum JournalTheme: String, CaseIterable {
    case night, day

    public static let storageKey = "windmill:journal-theme"

    public var skin: JournalSkin { self == .night ? .night : .day }
    public var flipped: JournalTheme { self == .night ? .day : .night }

    // What the control offers, which is the other side — a button says where it takes you.
    public var otherLabel: String { self == .night ? "Day" : "Night" }
    public var otherSymbol: String { self == .night ? "sun.max" : "moon" }
}

// Reading a skin out of the environment keeps every glyph free of a `skin:` parameter it would only
// pass along. The default is night so a view rendered outside the room still paints correctly.
private struct JournalSkinKey: EnvironmentKey {
    static let defaultValue = JournalSkin.night
}

public extension EnvironmentValues {
    var journalSkin: JournalSkin {
        get { self[JournalSkinKey.self] }
        set { self[JournalSkinKey.self] = newValue }
    }
}
