package works.windmill.gym.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

// Gym's own surface — the native statement of the room palette the web reads from
// web/src/styles/tokens/palettes.css (`[data-theme="dark"][data-brand="gym"]`). Every value below is
// a step of that palette or a brand semantic under a gym name, so gym cannot drift warmer or colder
// than its siblings, and a correction to the room reaches both surfaces or neither. Mirrored BY HAND
// from apps/ios GymSkin.swift — nothing checks them, so a hue that moves there has to be carried here.
//
// BASALT AND IRIS. There is ONE skin, and it is dark: gym is an instrument read at arm's length in a
// room with a rack in it, so none of these values is adaptive and the room never follows Appearance.
//
// The states are the brand's semantics renamed, never invented: `setDone` is success, `prInk` is
// warning (gold as a KIND of moment rather than a state), `alarmInk` is danger and fires on a write
// that FAILED and on nothing else — never on a missed rep, never on a session that ran short.
object GymSkin {
    val canvas = Color(0xFF1C1A1E)          // neutral-50
    val surface = Color(0xFF262329)         // neutral-0, elevated over the canvas
    val raised = Color(0xFF2E2B32)          // neutral-100
    val line = Color(0xFF39363E)            // neutral-200 · border-subtle
    val lineStrong = Color(0xFF48444D)      // neutral-300 · border-default
    val accent = Color(0xFF9A90BE)          // iris-300 — the one lit thing in the room, never a state
    val onAccent = Color(0xFF1B1408)        // ink that sits ON the accent fill — 6.18:1 on iris-300
    // The wash is iris at its DARKEST step at 22%, not its 300: the accent is also the ink ON it
    // (the overrun rest chip), and iris-300 on an iris-300 wash measures 3.66:1.
    val accentSoft = Color(0x383A3358)
    val ink = Color(0xFFEDEBF0)
    val inkDim = Color(0xFFB0ABB8)          // neutral-600
    val inkFaint = Color(0xFF8D8896)        // neutral-500 — 5.01:1 on the canvas
    val weightInk = Color(0xFFEDEBF0)       // neutral-900: the ramp top, the loudest pixel
    val targetInk = Color(0xFF9A90BE)       // the accent — what the plan said
    val setDone = Color(0xFF9AA859)         // olive-400: logged. settled, not celebrated
    val prInk = Color(0xFFD9B04C)           // gold-400: the only loud state, at most one per session
    val prSoft = Color(0x26D9B04C)          // the same gold at 15%, the wash a record sits on
    val warmupInk = Color(0xFF8D8896)       // counts toward nothing
    val unsyncedInk = Color(0xFF8D8896)     // saved on this device only
    val alarmInk = Color(0xFFD08268)        // brick-300: a write that failed. nothing else
}

// Every numeral in gym is TABULAR. A column of sets whose digits change width shimmers as it grows,
// and the weight readout would jitter sideways on every tap of the ladder — the one thing a number
// read at arm's length may not do.
//
// The weight is the exception to "numerals are mono": it is the display face, heavy, at the one
// size gym extends the scale to. It is the loudest thing on screen on purpose, and it is the only
// place in the product that is allowed to be.
object GymType {
    val weight = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.ExtraBold,
        fontSize = 104.sp,
        lineHeight = 92.sp,
        letterSpacing = (-0.04).em,
        fontFeatureSettings = "tnum",
    )

    val reps = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.ExtraBold,
        fontSize = 54.sp,
        fontFeatureSettings = "tnum",
    )

    val movementHead = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 28.sp,
    )

    fun numeral(size: Int, weight: FontWeight = FontWeight.Normal) = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = weight,
        fontSize = size.sp,
        fontFeatureSettings = "tnum",
    )

    val readout = numeral(15)
}

// The two targets the design fixes: nothing tappable under 46, and the primary action 64 and in the
// thumb zone. They are named rather than typed at each call site so a screen cannot quietly shrink
// one — a 44dp button is the platform's habit and this product's mistake, chalked hands and all.
object GymTap {
    val minimum = 46.dp
    val primary = 64.dp
}
