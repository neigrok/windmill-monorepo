package works.windmill.gym.domain

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

// §I — FIVE ROWS, AND THEY ARE ALL ABOUT A BARBELL. One document per account on
// `/v1/gym/preferences`, identical in both directions, and the only settings gym owns: what a
// weight is read in, what the gym's rack holds, how long the rest is, and how a logged set says so.
// Account, appearance, plan, sessions, devices and delete live in You — this room does not restate
// them and it has no theme switch of its own.
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
    val barWeightKg: Double = defaultBarKg,
    // ONE SIDE OF THE BAR, and never the total — the ladder's number is the total load, so a
    // readout that mixed the two would be wrong by a factor of two. Empty is a REAL value meaning
    // this gym owns no plates, kept distinct from the full default set.
    val platesKg: List<Double> = defaultPlatesKg,
    val restSeconds: Int? = null,
    val restSound: Boolean = true,
    // INTENT, and each surface honours what it can. The design's own caption: native has a haptic;
    // the installed web app has no Vibration API, so there the confirmation is visual and optionally
    // audible. The document records what the lifter wants either way, and a surface that cannot
    // keep it says so where the row is drawn rather than moving a toggle that does nothing.
    val confirmHaptic: Boolean = true,
    val confirmSound: Boolean = false,
) {
    // The server normalizes plates — heaviest first, duplicates gone — and so does this, because
    // the device draws its own copy before any reply arrives and the two must not disagree about
    // the same rack. Every band is clamped rather than refused: this repairs a document read off an
    // older file or a future server, and a value outside the band would be a deterministic 400 on
    // the next PUT with nothing on screen to explain it. What the LIFTER types is refused out loud
    // instead — a clamp there would store a number they did not choose.
    fun normalized(): GymPreferences = copy(
        barWeightKg = Ladder.round(barWeightKg).coerceIn(minBarKg, maxBarKg),
        platesKg = platesKg
            .map { Ladder.round(it) }
            .filter { it >= minPlateKg && it <= maxPlateKg }
            .distinct()
            .sortedDescending()
            .take(maxPlateKinds),
        restSeconds = restSeconds?.coerceIn(minRestSeconds, maxRestSeconds),
    )

    // A chip's tap. Owning a plate is a set membership and nothing else — there is no count, because
    // the setting says what the gym HOLDS and a rack does not run out mid-set.
    fun togglingPlate(kg: Double): GymPreferences {
        val plate = Ladder.round(kg)
        if (plate in platesKg) return copy(platesKg = platesKg - plate)
        return copy(platesKg = (platesKg + plate).sortedDescending())
    }

    companion object {
        const val defaultBarKg = 20.0
        const val minBarKg = 0.0            // a machine or a pair of dumbbells has no bar
        const val maxBarKg = 100.0
        const val minPlateKg = 0.01
        const val maxPlateKg = 100.0
        const val maxPlateKinds = 12

        // The server's own band, and the same one a routine's line is bounded by — the global dial
        // and a routine entry can never ask for waits the other refuses.
        const val minRestSeconds = 15
        const val maxRestSeconds = 900

        val defaultPlatesKg = listOf(25.0, 20.0, 15.0, 10.0, 5.0, 2.5, 1.25)

        // The chips §I draws, and the row is the union of these with whatever the document holds —
        // so a plate set from the web or by an agent still has somewhere to be turned off.
        fun offeredPlates(held: List<Double>): List<Double> =
            (defaultPlatesKg + held).distinct().sortedDescending()

        // The dial's four positions. `off` is a real choice and the first one, because it is the
        // default and because turning a timer off is the move a lifter reaches for mid-session.
        val restChoices: List<Int?> = listOf(null, 90, 120, 180)
    }
}
