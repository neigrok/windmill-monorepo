package works.windmill.gym.store

import java.io.File
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.GymPreferences

// Per seat. `document` is null for "nobody has touched this": kotlinx omits values equal to their
// defaults, so a settings object at its defaults encodes as `{}`.
class LocalPreferences(private val file: File) {
    companion object {
        const val fileName = "windmill-gym-preferences.json"
    }

    @Serializable
    private data class Held(
        val owner: String? = null,
        val document: GymPreferences? = null,
        val owed: Boolean = false,
    )

    private var held: Held = runCatching {
        diskJson.decodeFromString(Held.serializer(), file.readText())
    }.getOrElse { Held() }

    val document: GymPreferences get() = held.document ?: GymPreferences()

    val owed: Boolean get() = held.owed

    // A seat change carries a still-owed document onto the new seat; a landed one is dropped.
    fun adopt(owner: String?) {
        if (held.owner == owner) return
        val carried = held.takeIf { it.owed }?.document
        hold(Held(owner = owner, document = carried, owed = carried != null))
    }

    fun save(document: GymPreferences) {
        hold(held.copy(document = document.normalized(), owed = true))
    }

    // Keep the stored document, never the one that went out.
    fun landed(stored: GymPreferences) {
        hold(held.copy(document = stored.normalized(), owed = false))
    }

    // A read back may not overwrite something this device still owes.
    fun readBack(stored: GymPreferences) {
        if (held.owed) return
        hold(held.copy(document = stored.normalized(), owed = false))
    }

    // Clears `owed` so the claim is not jammed behind an answer that cannot change.
    fun letGo() {
        hold(held.copy(owed = false))
    }

    private fun hold(next: Held) {
        if (next == held) return
        held = next
        val text = runCatching { diskJson.encodeToString(Held.serializer(), next) }.getOrNull() ?: return
        writeAtomically(file, text)
    }
}
