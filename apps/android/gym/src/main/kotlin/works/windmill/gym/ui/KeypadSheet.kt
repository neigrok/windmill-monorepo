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
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.Readout
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// An invalid entry never silently reverts: the buffer stays and the only ways out are Set and cancel
// — the sheet's own dismissal where the pad is a sheet, a drawn Cancel where it has taken over
// another sheet's body and the platform has no handle for "back to that body". The pad opens ON the
// number it was opened from, and `seeded` is what makes the first digit start a fresh number rather
// than append. In reps mode the comma and the ± are stood DOWN, never removed.
object KeypadEntry {
    enum class Mode { Weight, Reps }

    const val maxBuffer = 8

    // The band a PERFORMED set is bounded by. The routine's own target band is wider and lives on
    // `TargetEntry` — a plan may name 100 reps, a logged set may not.
    const val maxLoggedReps = 99

    // The same four refusals the routine target's typed fields carry, in the same bytes — a lifter
    // who has read one has read the other. Only the band differs: a set that was PERFORMED is bounded
    // at 99 reps, where `TargetEntry` plans up to 100. The comma lesson lives in `weightHint`, said
    // once beside the pad rather than inside a refusal.
    const val onePoint = "One decimal point only."
    const val notANumber = "That is not a number yet."
    const val overWeight = "Over 500 kg — check the number."
    const val outsideReps = "Whole reps, 1 to $maxLoggedReps."

    val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "±", "0", ",")

    // C21: the ten digits and the decimal separator read themselves out loud. The pad's two glyphs
    // read as nothing, so each carries a name — ± in the same bytes the target sheet's own ± control
    // carries, so one control met on two screens is called one thing.
    const val deleteGlyph = "⌫"
    const val signName = "Flip the sign"
    const val deleteName = "Delete"

    fun spoken(key: String): String? = when (key) {
        "±" -> signName
        deleteGlyph -> deleteName
        else -> null
    }

    const val weightHint = "kg  ·  comma or point both read as a decimal  ·  ± for band-assisted"
    const val repsHint = "whole reps"

    data class Pad(val text: String, val seeded: Boolean) {
        // The buffer is ASCII: the parser reads only the hyphen, and `echo` re-spells it as U+2212.
        constructor(opening: String) : this(opening.replace("−", "-"), true)

        val echo: String
            get() {
                if (text.isEmpty()) return "—"
                if (!text.startsWith("-")) return text
                return "−" + text.drop(1)
            }

        // A key that does not fit is refused WHOLE: never write a number the lifter did not type.
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
            return Reading(null, onePoint)
        }
        val value = normalised.toDoubleOrNull()
        if (value == null || !value.isFinite()) {
            return Reading(null, notANumber)
        }
        if (mode == Mode.Weight) {
            if (kotlin.math.abs(value) > 500) {
                return Reading(null, overWeight)
            }
            return Reading(Ladder.round(value), weightHint)
        }
        // 1 and not 0: the server refuses reps < 1.
        if (value < 1 || value > maxLoggedReps || value != kotlin.math.floor(value)) {
            return Reading(null, outsideReps)
        }
        return Reading(value, repsHint)
    }
}

@Composable
fun KeypadSheet(
    mode: KeypadEntry.Mode,
    current: Double,
    onCommit: (Double) -> Unit,
    onCancel: (() -> Unit)? = null,
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
                            .clickable(role = Role.Button) { pad = pad.pressing(key, mode) }
                            // A digit is its own name; a glyph is not, so a glyph key says what it is.
                            .then(
                                KeypadEntry.spoken(key)?.let { name ->
                                    Modifier.semantics(mergeDescendants = true) { contentDescription = name }
                                } ?: Modifier
                            ),
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
            onCancel?.let { cancel ->
                Box(
                    Modifier
                        .widthIn(min = 88.dp)
                        .heightIn(min = GymTap.minimum)
                        .clickable(role = Role.Button, onClick = cancel),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Cancel", style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.inkDim)
                }
            }

            Box(
                Modifier
                    .sizeIn(minWidth = GymTap.minimum, minHeight = GymTap.minimum)
                    .clickable(role = Role.Button, onClickLabel = "delete the last digit") {
                        pad = pad.backspaced
                    }
                    .semantics(mergeDescendants = true) {
                        contentDescription = KeypadEntry.deleteName
                    },
                contentAlignment = Alignment.Center,
            ) {
                // No core icon draws a backspace, so the glyph stays and the key carries its name.
                Text(KeypadEntry.deleteGlyph, style = WindmillFont.body(20), color = GymSkin.ink)
            }

            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = GymTap.minimum + 6.dp)
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(if (reading.isValid) GymSkin.accent else GymSkin.raised)
                    .clickable(role = Role.Button) { reading.value?.let(onCommit) },
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
