package works.windmill.gym.domain

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

// §I — THE ROOM'S OWN ROWS. One document per account on `/v1/gym/preferences`, identical in both
// directions, and the only settings gym owns: what a weight is read in, how long the rest is, and
// how a logged set says so. Account, appearance, plan, sessions, devices and delete live in You —
// this room does not restate them and it has no theme switch of its own.
//
// NOTHING HERE IS ABOUT EQUIPMENT, and that is a decision rather than a gap: the bar weight and the
// plate set this document used to carry went on 2026-08-13 with the loading readout they fed. Gyms
// are more or less the same, and this product guides a program and tracks what was done.
//
// KILOGRAMS ARE THE ONLY THING STORED, FOREVER. `units` is a display transform at the very edge and
// it reaches no write: every weight on every other gym route is kg whatever this says, and nothing
// in this file converts one. Changing it changes the display; history does not get rewritten.
//
// THE WIRE'S OWN RULE IS WHAT MAKES THE DEFAULTS SAFE HERE. A PUT is a whole-document replace in
// which an OMITTED field takes its DEFAULT — not "leave what is stored" — and kotlinx omits a value
// that equals its declared default. So a lifter who dials a setting back to the default sends
// nothing for it and the server stores the default, which is the same document either way. Flip
// that server rule and every default below silently stops travelling.
//
// REST DEFAULTS TO OFF, and `restSeconds == null` is the only way to say so — there is no 0 and no
// `false`. A timer nobody asked for that starts beeping in a gym is the kind of thing this product
// does not do, so a lifter who never opens this screen is never interrupted by it.

@Serializable(with = UnitsSerializer::class)
enum class Units(val wire: String) {
    Kilograms("kg"), Pounds("lb");

    companion object {
        // A word from a future server reads as kg rather than crashing a room mid-workout — the
        // reads-default rule Training.kt states for every gym type. The WRITE side is the opposite
        // and the server's: an unknown unit is refused there, never downgraded.
        fun parse(raw: String?): Units = entries.firstOrNull { it.wire == raw } ?: Kilograms
    }
}

object UnitsSerializer : KSerializer<Units> {
    override val descriptor = PrimitiveSerialDescriptor("Units", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: Units) = encoder.encodeString(value.wire)
    override fun deserialize(decoder: Decoder): Units = Units.parse(decoder.decodeString())
}

@Serializable
data class GymPreferences(
    val units: Units = Units.Kilograms,
    val restSeconds: Int? = null,
    val restSound: Boolean = true,
    // INTENT, and each surface honours what it can. The design's own caption: native has a haptic;
    // the installed web app has no Vibration API, so there the confirmation is visual and optionally
    // audible. The document records what the lifter wants either way, and a surface that cannot
    // keep it says so where the row is drawn rather than moving a toggle that does nothing.
    val confirmHaptic: Boolean = true,
    val confirmSound: Boolean = false,
) {
    // The band is clamped rather than refused: this repairs a document read off an older file or a
    // future server, and a value outside it would be a deterministic 400 on the next PUT with
    // nothing on screen to explain it. What the LIFTER chooses is refused out loud instead — a clamp
    // there would store a number they did not choose.
    fun normalized(): GymPreferences = copy(
        restSeconds = restSeconds?.coerceIn(minRestSeconds, maxRestSeconds),
    )

    companion object {
        // The server's own band, and the same one a routine's line is bounded by — the global dial
        // and a routine entry can never ask for waits the other refuses.
        const val minRestSeconds = 15
        const val maxRestSeconds = 900

        // The dial's four positions. `off` is a real choice and the first one, because it is the
        // default and because turning a timer off is the move a lifter reaches for mid-session.
        val restChoices: List<Int?> = listOf(null, 90, 120, 180)
    }
}
