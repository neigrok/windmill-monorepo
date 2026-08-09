package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.Readout
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// TAP-TO-TYPE — twelve keys for both numbers, and one rule that governs the whole sheet: AN INVALID
// ENTRY NEVER SILENTLY REVERTS. The buffer stays, the echo turns alarm ink, the message names the
// exact problem and teaches the format, and the empty case even names the value Cancel would keep.
// The only ways out are Set, which commits, and Cancel, which keeps the number they had.
//
// The pad opens ON the number it was opened from, so a gesture the lifter has not made yet is never
// drawn as a mistake. `seeded` is what makes that honest: the first digit starts a fresh number
// rather than appending to a value nobody typed, while ± and ⌫ edit what is there, because they are
// corrections and not entry.
//
// In reps mode the comma and the ± are stood DOWN, not removed — the geometry a chalked thumb
// learned must not move between the two numbers. The native twin of
// web/src/products/gym/logger/entry.js.
object KeypadEntry {
    enum class Mode { Weight, Reps }

    const val maxBuffer = 8
    val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "±", "0", ",")
    const val weightHint = "kg  ·  comma or point both read as a decimal  ·  ± for band-assisted"
    const val repsHint = "whole reps"

    data class Pad(val text: String, val seeded: Boolean) {
        // THE BUFFER IS ASCII AND THE ECHO IS TYPOGRAPHIC. The pad is opened on the product's own
        // spelling of a number (Readout.weight), which writes a real U+2212 minus — and the parser
        // reads only the hyphen, so seeding a band-assisted −20 raw would open the sheet in alarm
        // ink on a gesture the lifter never made, then answer ± with "-−20". The sign is normalised
        // on the way in and re-spelled by `echo` on the way out, so nothing else has to know.
        constructor(opening: String) : this(opening.replace("−", "-"), true)

        // The echo is the raw buffer, so the lifter reads back exactly what they pressed; only the
        // minus is swapped for the typographic one, and an empty buffer shows an em dash rather than
        // a blank that looks like a broken sheet.
        val echo: String
            get() {
                if (text.isEmpty()) return "—"
                if (!text.startsWith("-")) return text
                return "−" + text.drop(1)
            }

        // A key that does not fit is refused WHOLE — never write a number the lifter did not type,
        // and that includes eating the digit under their thumb to make room for a sign.
        fun pressing(key: String, mode: Mode): Pad {
            if (!isLive(key, mode)) return this
            if (key == "±") {
                if (text.startsWith("-")) return Pad(text.drop(1), seeded = false)
                if (text.length >= maxBuffer) return this
                return Pad("-$text", seeded = false)
            }
            val held = if (seeded) "" else text
            if (held.length >= maxBuffer) return this
            return Pad(held + key, seeded = false)
        }

        val backspaced: Pad
            get() = Pad(text.dropLast(1), seeded = false)
    }

    data class Reading(val value: Double?, val message: String) {
        val isValid: Boolean get() = value != null
    }

    fun isLive(key: String, mode: Mode): Boolean {
        if (mode != Mode.Reps) return true
        return key != "," && key != "±"
    }

    fun read(pad: Pad, mode: Mode, keeping: Double): Reading {
        val raw = pad.text.trim()
        if (raw.isEmpty() || raw == "-") {
            return Reading(null, "Enter a number, or cancel to keep ${Readout.weight(keeping)}")
        }
        val normalised = raw.replace(",", ".")
        if (normalised.count { it == '.' } > 1) {
            return Reading(null, "One decimal point only — 72,5 or 72.5")
        }
        val value = normalised.toDoubleOrNull()
        if (value == null || !value.isFinite()) {
            return Reading(null, "Not a number yet — 72,5 reads as 72.5")
        }
        if (mode == Mode.Weight) {
            if (kotlin.math.abs(value) > 500) {
                return Reading(null, "Over 500 kg — check the number")
            }
            return Reading(Ladder.round(value), weightHint)
        }
        // 1 and not 0: the server refuses reps < 1, so a pad that took a 0 would hand back a number
        // the log could only refuse — the one entry that looked legal here and died at the wire.
        if (value < 1 || value > 99 || value != kotlin.math.floor(value)) {
            return Reading(null, "Whole reps, 1 to 99")
        }
        return Reading(value, repsHint)
    }
}

@Composable
fun KeypadSheet(
    mode: KeypadEntry.Mode,
    current: Double,
    onCommit: (Double) -> Unit,
    onCancel: () -> Unit,
) {
    val opening = if (mode == KeypadEntry.Mode.Weight) Readout.weight(current) else current.toInt().toString()
    var pad by remember { mutableStateOf(KeypadEntry.Pad(opening)) }
    val reading = KeypadEntry.read(pad, mode, keeping = current)

    Column(
        Modifier
            .fillMaxWidth()
            .background(GymSkin.surface)
            .padding(WindmillSpace.x5),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
    ) {
        Text(
            if (mode == KeypadEntry.Mode.Weight) "Weight" else "Reps",
            style = GymType.numeral(12),
            color = GymSkin.inkFaint,
        )

        BasicText(
            pad.echo,
            maxLines = 1,
            autoSize = TextAutoSize.StepBased(minFontSize = 28.sp, maxFontSize = 56.sp),
            style = WindmillFont.display(56, FontWeight.ExtraBold)
                .copy(fontFeatureSettings = "tnum", color = if (reading.isValid) GymSkin.weightInk else GymSkin.alarmInk),
            modifier = Modifier.fillMaxWidth(),
        )

        Text(
            reading.message,
            style = GymType.numeral(12),
            color = if (reading.isValid) GymSkin.inkFaint else GymSkin.alarmInk,
            modifier = Modifier.fillMaxWidth(),
        )

        KeypadEntry.keys.chunked(3).forEach { row ->
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            ) {
                row.forEach { key ->
                    Box(
                        Modifier
                            .weight(1f)
                            .heightIn(min = 58.dp)
                            .clip(RoundedCornerShape(WindmillRadius.md))
                            .background(GymSkin.raised)
                            .clickable { pad = pad.pressing(key, mode) },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            key,
                            style = WindmillFont.display(24, FontWeight.SemiBold).copy(fontFeatureSettings = "tnum"),
                            color = if (KeypadEntry.isLive(key, mode)) GymSkin.ink else GymSkin.inkFaint,
                        )
                    }
                }
            }
        }

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .widthIn(min = 88.dp)
                    .heightIn(min = GymTap.minimum)
                    .clickable(onClick = onCancel),
                contentAlignment = Alignment.Center,
            ) {
                Text("Cancel", style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.inkDim)
            }

            Box(
                Modifier
                    .sizeIn(minWidth = GymTap.minimum, minHeight = GymTap.minimum)
                    .clickable { pad = pad.backspaced },
                contentAlignment = Alignment.Center,
            ) {
                Text("⌫", style = WindmillFont.body(20), color = GymSkin.ink)
            }

            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = GymTap.minimum + 6.dp)
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(if (reading.isValid) GymSkin.accent else GymSkin.raised)
                    .clickable { reading.value?.let(onCommit) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "Set",
                    style = WindmillFont.body(17, FontWeight.Bold),
                    color = if (reading.isValid) GymSkin.onAccent else GymSkin.inkFaint,
                )
            }
        }
    }
}
