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
    public let mood: [Color]        // one hue in five steps

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

private struct JournalSkinKey: EnvironmentKey {
    static let defaultValue = JournalSkin.night
}

public extension EnvironmentValues {
    var journalSkin: JournalSkin {
        get { self[JournalSkinKey.self] }
        set { self[JournalSkinKey.self] = newValue }
    }
}
