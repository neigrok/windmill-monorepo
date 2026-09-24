package works.windmill.gym.domain

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

// Kilograms are stored; units only change the reading.

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
    val confirmHaptic: Boolean = true,
    val confirmSound: Boolean = false,
)
