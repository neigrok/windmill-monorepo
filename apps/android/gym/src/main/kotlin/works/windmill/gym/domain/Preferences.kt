package works.windmill.gym.domain

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

// Kilograms are the only thing stored: `units` is a display transform at the edge and reaches no write.
// A PUT replaces the whole document and an omitted field takes its default, and kotlinx omits a value
// equal to its declared default — so the defaults below must match the server's.
// Settings edits the rest target. Rest sound and legacy set-confirmation fields round-trip unchanged
// when another preference is edited; their serialized defaults remain the server's defaults.

@Serializable(with = UnitsSerializer::class)
enum class Units(val wire: String) {
    Kilograms("kg"), Pounds("lb");

    companion object {
        // An unknown word reads as kg rather than throwing.
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
    val confirmHaptic: Boolean = true,
    val confirmSound: Boolean = false,
)
