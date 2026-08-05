import SwiftUI
import WindmillPlatform

// Gym's own surface — the native statement of web/src/products/gym/gym.css. The instrument skin is
// the system's night sky with ONE hue re-pointed to steel: every value below is a dark-ramp step or
// a brand semantic under a gym name, so gym cannot drift warmer or colder than its siblings and a
// future correction to the night sky reaches it for free.
//
// There is ONE skin, and it is dark. Journal's night and day are the writer's choice; gym is an
// instrument read at arm's length in a room with a rack in it, so the room states `.dark` outward
// rather than following Appearance, and none of these values is adaptive.
//
// The states are the brand's semantics renamed, never invented: `setDone` is success, `prInk` is
// warning (gold as a KIND of moment rather than a state), `alarmInk` is danger and fires on a write
// that FAILED and on nothing else — never on a missed rep, never on a session that ran short.

public struct GymSkin: Equatable {
    public let canvas: Color
    public let surface: Color
    public let raised: Color
    public let line: Color
    public let lineStrong: Color
    public let steel: Color             // the one accent — it reads as iron and never as a state
    public let steelSoft: Color
    public let onSteel: Color           // ink that sits ON the accent fill
    public let weightInk: Color         // the ramp top: the loudest pixel in the product
    public let ink: Color
    public let inkDim: Color
    public let inkFaint: Color
    public let setDone: Color           // logged. settled, not celebrated
    public let targetInk: Color         // what the plan said
    public let prInk: Color             // the only loud state, and at most one per session
    public let warmupInk: Color         // counts toward nothing
    public let unsyncedInk: Color       // saved on this device only
    public let alarmInk: Color          // a write that failed. nothing else

    public static let instrument = GymSkin(
        canvas: Color(hex: 0x0D0B07),
        surface: Color(hex: 0x17120B),
        raised: Color(hex: 0x221B12),
        line: Color(hex: 0x2E2618),
        lineStrong: Color(hex: 0x3C3223),
        steel: Color(hex: 0x7FA0AE),
        steelSoft: Color(hex: 0x7FA0AE).opacity(0.18),
        onSteel: Color(hex: 0x1B1408),
        weightInk: Color(hex: 0xF4EEDF),
        ink: Color(hex: 0xF4EEDF),
        inkDim: Color(hex: 0xAE9A75),
        inkFaint: Color(hex: 0x8A785A),
        setDone: Color(hex: 0x9AA859),
        targetInk: Color(hex: 0x7FA0AE),
        prInk: Color(hex: 0xD9B04C),
        warmupInk: Color(hex: 0x8A785A),
        unsyncedInk: Color(hex: 0x8A785A),
        alarmInk: Color(hex: 0xBF6A50)
    )
}

// Reading the skin out of the environment keeps every row and readout free of a `skin:` parameter
// it would only pass along. The default is the instrument, because there is no other one.
private struct GymSkinKey: EnvironmentKey {
    static let defaultValue = GymSkin.instrument
}

public extension EnvironmentValues {
    var gymSkin: GymSkin {
        get { self[GymSkinKey.self] }
        set { self[GymSkinKey.self] = newValue }
    }
}

// Every numeral in gym is TABULAR. A column of sets whose digits change width shimmers as it grows,
// and the weight readout would jitter sideways on every tap of the ladder — the one thing a number
// read at arm's length may not do.
//
// The weight is the exception to "numerals are mono": it is the display face, heavy, at the one
// size gym extends the scale to (the brand's scale stops at 60). It is the loudest thing on screen
// on purpose, and it is the only place in the product that is allowed to be.
public enum GymType {
    public static let weight = WindmillFont.display(104, .heavy).monospacedDigit()
    public static let reps = WindmillFont.display(54, .heavy).monospacedDigit()

    public static func numeral(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        WindmillFont.mono(size, weight).monospacedDigit()
    }
}

// The two targets the design fixes: nothing tappable under 46, and the primary action 64 and in the
// thumb zone. They are named rather than typed at each call site so a screen cannot quietly shrink
// one — a 44pt button is the platform's minimum and this product's mistake, chalked hands and all.
public enum GymTap {
    public static let minimum: CGFloat = 46
    public static let primary: CGFloat = 64
}
