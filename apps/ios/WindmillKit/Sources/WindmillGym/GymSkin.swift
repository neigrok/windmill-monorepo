import SwiftUI
import WindmillPlatform

// Gym's own surface — the native statement of the room palette the web reads from
// web/src/styles/tokens/palettes.css (`[data-theme="dark"][data-brand="gym"]`). Every value below is
// a step of that palette or a brand semantic under a gym name, so gym cannot drift warmer or colder
// than its siblings, and a correction to the room reaches both surfaces or neither.
//
// BASALT AND IRIS, since 2026-08-07. The room used to be the family's near-black night with one hue
// re-pointed to STEEL, and both halves were wrong. Steel is the palette's Tuscan sky, which is the
// INFO semantic doing double duty as a brand; and steel on a grey ground is cool on cool, so the
// accent stopped being an accent. The place is a quarry now — volcanic stone at night, lit by iris,
// the giaggiolo, which sits 65° from sky and is the only vibrant thing in the room.
//
// There is ONE skin, and it is dark. Journal's night and day are the writer's choice; gym is an
// instrument read at arm's length in a room with a rack in it, so the room states `.dark` outward
// rather than following Appearance, and none of these values is adaptive. (The palette holds gym's
// daylight — pietra — for the day that changes; nothing here renders it.)
//
// The states are the brand's semantics renamed, never invented: `setDone` is success, `prInk` is
// warning (gold as a KIND of moment rather than a state), `alarmInk` is danger and marks exactly
// three things — a write that failed, a read that failed, and the one destructive control the
// product draws (§G18's `Delete set`). Never a missed rep, never a session that ran short.

public struct GymSkin: Equatable {
    public let canvas: Color
    public let surface: Color
    public let raised: Color
    public let line: Color
    public let lineStrong: Color
    public let accent: Color            // the one lit thing in the room, and never a state
    public let accentSoft: Color        // its wash. built from iris's DARKEST step, so the ink on it holds
    public let onAccent: Color          // ink that sits ON the accent fill
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

    // Basalt, step for step with `[data-theme="dark"][data-brand="gym"]`. The ratios in the comments
    // are measured against this ground, not against the family night these values replaced.
    public static let instrument = GymSkin(
        canvas: Color(hex: 0x1C1A1E),       // neutral-50
        surface: Color(hex: 0x262329),      // neutral-0, elevated over the canvas
        raised: Color(hex: 0x2E2B32),       // neutral-100
        line: Color(hex: 0x39363E),         // neutral-200 · border-subtle
        lineStrong: Color(hex: 0x48444D),   // neutral-300 · border-default
        accent: Color(hex: 0x9A90BE),       // iris-300 — 5.81:1 on the canvas
        // The wash is iris at its 700, not its 300. A wash of the LIT step lightens what it lands on,
        // and the accent is also the ink ON it (the overrun rest chip): iris-300 on an iris-300 wash
        // measures 3.66:1. Washing with the darkest step keeps the chip a shade of the room and the
        // ink legible on it — 5.41 / 4.95 / 4.54 on canvas, surface and raised.
        accentSoft: Color(hex: 0x3A3358).opacity(0.22),
        onAccent: Color(hex: 0x1B1408),     // 6.18:1 on iris-300
        weightInk: Color(hex: 0xEDEBF0),    // neutral-900: the ramp top, the loudest pixel
        ink: Color(hex: 0xEDEBF0),
        inkDim: Color(hex: 0xB0ABB8),       // neutral-600
        inkFaint: Color(hex: 0x8D8896),     // neutral-500 — 5.01:1 on the canvas
        setDone: Color(hex: 0x9AA859),      // olive-400: success, and it does not move between rooms
        targetInk: Color(hex: 0x9A90BE),    // the accent — what the plan said
        prInk: Color(hex: 0xD9B04C),        // gold-400: warning as a KIND of moment, not a state
        warmupInk: Color(hex: 0x8D8896),
        unsyncedInk: Color(hex: 0x8D8896),
        // brick-300, not the 400. Basalt is three stops lighter than the family night brick-400 was
        // cut for, where it fell to 3.98:1 on the surface. This step measures 5.82 / 5.22 / 4.69.
        alarmInk: Color(hex: 0xD08268)
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
    // The same readout one step down, for the sheet that CORRECTS a set rather than logs one (§G18).
    // Still the loudest thing in front of the thumb, but a sheet is not the room and the session it
    // is laid over has to stay readable behind it.
    public static let correction = WindmillFont.display(72, .heavy).monospacedDigit()

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
