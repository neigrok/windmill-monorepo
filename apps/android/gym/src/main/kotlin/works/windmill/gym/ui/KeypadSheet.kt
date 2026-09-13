package works.windmill.gym.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.Readout
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius

object KeypadEntry {
    enum class Mode { Weight, Reps }

    const val maxBuffer = 8

    const val maxLoggedReps = 99

    const val onePoint = "One decimal point only."
    const val notANumber = "That is not a number yet."
    const val overWeight = "Over 500 kg — check the number."
    const val outsideReps = "Whole reps, 1 to $maxLoggedReps."

    val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "±", "0", ".")

    const val deleteGlyph = "⌫"
    const val signName = "Flip the sign — band-assisted"
    const val deleteName = "Delete"

    fun spoken(key: String): String? = when (key) {
        "±" -> signName
        deleteGlyph -> deleteName
        else -> null
    }

    const val weightHint = "kg"
    const val repsHint = "whole reps"

    data class Pad(val text: String, val seeded: Boolean) {
        constructor(opening: String) : this(opening.replace("−", "-"), true)

        val echo: String
            get() {
                if (text.isEmpty()) return "—"
                if (!text.startsWith("-")) return text
                return "−" + text.drop(1)
            }

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
        return key != "," && key != "." && key != "±"
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
    val skin = LocalGymColors.current
    val opening = if (mode == KeypadEntry.Mode.Weight) Readout.weight(current) else current.toInt().toString()
    var pad by rememberSaveable(mode, current, stateSaver = listSaver(
        save = { listOf(it.text, it.seeded) },
        restore = { KeypadEntry.Pad(it[0] as String, it[1] as Boolean) },
    )) { mutableStateOf(KeypadEntry.Pad(opening)) }
    val reading = KeypadEntry.read(pad, mode, keeping = current)
    val title = if (mode == KeypadEntry.Mode.Weight) "Weight" else "Reps"

    BackHandler(enabled = onCancel != null) { onCancel?.invoke() }
    Column(
        Modifier.fillMaxWidth().background(skin.surface)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = GymLayout.gutter)
            .padding(bottom = GymLayout.sheetBottom),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(title, style = WindmillFont.body(24, FontWeight.Bold).copy(lineHeight = 31.sp),
            color = skin.ink, modifier = Modifier.semantics { heading() })
        Row(
            Modifier.fillMaxWidth().heightIn(min = 80.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicText(
                pad.echo,
                maxLines = 1,
                autoSize = TextAutoSize.StepBased(minFontSize = 16.sp, maxFontSize = 64.sp),
                style = WindmillFont.display(64, FontWeight.ExtraBold)
                    .copy(lineHeight = 83.sp, fontFeatureSettings = "tnum", color = skin.weightInk),
                modifier = Modifier.weight(1f).semantics {
                    if (!reading.isValid) error(reading.message)
                },
            )
            Text(if (mode == KeypadEntry.Mode.Weight) "kg" else "reps",
                style = WindmillFont.body(18).copy(lineHeight = 23.sp), color = skin.inkDim)
            TextButton(
                onClick = { pad = pad.backspaced },
                modifier = Modifier.sizeIn(minWidth = 56.dp, minHeight = 56.dp)
                    .semantics { contentDescription = KeypadEntry.deleteName },
                colors = ButtonDefaults.textButtonColors(contentColor = skin.ink),
                contentPadding = PaddingValues(0.dp),
            ) {
                Text(KeypadEntry.deleteGlyph, style = WindmillFont.body(20))
            }
        }
        if (!reading.isValid) {
            Text(reading.message, style = WindmillFont.body(14).copy(lineHeight = 18.sp),
                color = skin.alarmInk,
                modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite })
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            KeypadEntry.keys.chunked(3).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { key ->
                        FilledTonalButton(
                            onClick = { pad = pad.pressing(key, mode) },
                            enabled = KeypadEntry.isLive(key, mode),
                            modifier = Modifier.weight(1f).heightIn(min = 64.dp).then(
                                KeypadEntry.spoken(key)?.let { name ->
                                    Modifier.semantics { contentDescription = name }
                                } ?: Modifier),
                            shape = RoundedCornerShape(WindmillRadius.lg),
                            colors = ButtonDefaults.filledTonalButtonColors(
                                containerColor = skin.raised, contentColor = skin.ink,
                                disabledContainerColor = skin.raised.copy(alpha = 0.38f),
                                disabledContentColor = skin.ink.copy(alpha = 0.38f),
                            ),
                        ) { Text(key, style = WindmillFont.body(16, FontWeight.Bold)) }
                    }
                }
            }
        }
        Button(
            onClick = { reading.value?.let(onCommit) },
            enabled = reading.isValid,
            modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp),
            shape = RoundedCornerShape(WindmillRadius.lg),
            colors = ButtonDefaults.buttonColors(
                containerColor = skin.accent, contentColor = skin.onAccent,
                disabledContainerColor = skin.accent.copy(alpha = 0.4f),
                disabledContentColor = skin.onAccent,
            ),
        ) { Text("Set ${title.lowercase()}", style = WindmillFont.body(16, FontWeight.Bold)) }
        onCancel?.let { cancel ->
            TextButton(onClick = cancel, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = skin.ink)) {
                Text("Cancel", style = WindmillFont.body(16, FontWeight.Bold))
            }
        }
    }
}
