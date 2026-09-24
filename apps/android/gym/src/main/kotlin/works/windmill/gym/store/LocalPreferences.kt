package works.windmill.gym.store

import java.io.File
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.storage.AtomicDocument
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import works.windmill.gym.domain.ClaimBatch
import works.windmill.gym.domain.ClaimItem
import works.windmill.gym.domain.ClaimKind
import works.windmill.gym.domain.ClaimSource
import works.windmill.gym.domain.GymPreferences

class LocalPreferences(private val file: File, telemetry: Telemetry = Telemetry.None) {
    companion object { const val fileName = "windmill-gym-preferences.json" }

    @Serializable
    private data class Shelf(val document: GymPreferences? = null, val owed: Boolean = false)

    @Serializable
    private data class Held(val shelves: Map<String, Shelf> = emptyMap(), val claims: Map<String, String> = emptyMap())

    private val storage = StoredDocument(file, telemetry)
    private var transferFailed = false
    private var seat: String = Seat.anonymous
    private val revisions = mutableMapOf<String, Long>()
    val revision: Long get() = revisions[seat] ?: 0
    private var held: Held = open()
    private val mine: Shelf get() = held.shelves[seat] ?: Shelf()
    val document: GymPreferences get() = mine.document ?: GymPreferences()
    val owed: Boolean get() = mine.owed

    private fun open(): Held {
        val node = storage.tree() ?: return Held()
        if (node["shelves"] is JsonObject || node["claims"] != null) return diskJson.decodeFromJsonElement(Held.serializer(), node)
        val owner = node["owner"]?.jsonPrimitive?.contentOrNull
        val shelf = diskJson.decodeFromJsonElement(Shelf.serializer(), node)
        seat = Seat.of(owner)
        return Held(mapOf(seat to shelf))
    }

    fun adopt(owner: String?) { seat = Seat.of(owner) }

    fun save(document: GymPreferences) {
        hold(Shelf(document, owed = true))
        revisions[seat] = revision + 1
    }
    fun landed(stored: GymPreferences) = hold(Shelf(stored))

    fun readBack(stored: GymPreferences) {
        if (!mine.owed) hold(Shelf(stored))
    }

    fun letGo() = hold(mine.copy(owed = false))

    private fun hold(next: Shelf) {
        check(!transferFailed) { "Restart the app to recover the local-data decision." }
        if (next == mine) return
        val saved = held.copy(shelves = held.shelves + (seat to next))
        try { AtomicDocument.write(file, diskJson.encodeToString(Held.serializer(), saved)) }
        catch (failure: Exception) { transferFailed = true; throw failure }
        held = saved
    }

    fun claimItems(): List<ClaimItem> = ClaimSource.entries.mapNotNull { source ->
        val value = held.shelves[source.seat]?.document ?: return@mapNotNull null
        claimItem(source, ClaimKind.Preferences, "preferences", value, GymPreferences.serializer())
    }

    fun preflight(batch: ClaimBatch, owner: String?) { transfer(batch, owner) }

    fun complete(batch: ClaimBatch, owner: String?) {
        val next = transfer(batch, owner)
        if (next == held) return
        try {
            AtomicDocument.write(file, diskJson.encodeToString(Held.serializer(), next))
        } catch (failure: Exception) {
            transferFailed = true
            throw failure
        }
        next.shelves.forEach { (key, shelf) ->
            if (shelf.document != held.shelves[key]?.document) revisions[key] = (revisions[key] ?: 0) + 1
        }
        held = next
    }

    private fun transfer(batch: ClaimBatch, owner: String?): Held {
        check(!transferFailed) { "Restart the app to recover the local-data decision." }
        if (held.claims.completed(batch, owner)) return held
        var shelves = held.shelves
        for (item in batch.items.filter { it.kind == ClaimKind.Preferences }) {
            val value = item.decode(GymPreferences.serializer())
            check(item.id == "preferences")
            if (owner != null) {
                shelves = shelves + (Seat.of(owner) to Shelf(value, owed = true))
            }
            val source = shelves[item.source.seat]?.document
            if (source == value) shelves = shelves - item.source.seat
        }
        return held.copy(shelves = shelves, claims = held.claims + (batch.id to (owner?.let { "owner:$it" } ?: "discard")))
    }
}
