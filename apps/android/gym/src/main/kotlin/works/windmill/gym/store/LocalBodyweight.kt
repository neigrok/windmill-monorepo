package works.windmill.gym.store

import java.io.File
import works.windmill.platform.telemetry.Telemetry
import works.windmill.platform.storage.AtomicDocument
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import works.windmill.gym.domain.ClaimBatch
import works.windmill.gym.domain.ClaimSource
import works.windmill.gym.domain.ClaimKind
import works.windmill.gym.domain.ClaimItem
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.WeighIn

// The device's copy of the bodyweight series, filed per seat like every other store, and local-first
// like a set: a weigh-in lands here before the log is consulted and is owed to the server until the
// server answers for it. The date is the row's identity, so a second write to the same day replaces
// the first; the newer `recordedAt` wins, on this phone as on the server.
class LocalBodyweight(private val file: File, deviceOwner: String? = null, telemetry: Telemetry = Telemetry.None) {
    companion object {
        const val fileName = "windmill-gym-bodyweight.json"
    }

    // `owed` names dates whose newest write has not landed; `deleted` names dates whose delete has
    // not. A date is never in both: a delete lets go of the write it would have overtaken.
    @Serializable
    private data class Shelf(
        val entries: Map<String, WeighIn> = emptyMap(),
        val owed: List<String> = emptyList(),
        val deleted: List<String> = emptyList(),
    ) {
        val isEmpty: Boolean get() = entries.isEmpty() && owed.isEmpty() && deleted.isEmpty()
    }

    @Serializable
    private data class Held(val shelves: Map<String, Shelf> = emptyMap(), val claims: Map<String, String> = emptyMap())

    private val storage = StoredDocument(file, telemetry)
    private var transferFailed = false
    private var seat: String = Seat.of(deviceOwner)
    private val revisions = mutableMapOf<Pair<String, String>, Long>()
    private var held: Held = storage.one(storage.tree(), Held.serializer()) ?: Held()

    private val mine: Shelf get() = held.shelves[seat] ?: Shelf()

    private fun keep(next: Shelf) {
        check(!transferFailed) { "Restart the app to recover the local-data decision." }
        held = held.copy(shelves = (held.shelves + (seat to next)).filterValues { !it.isEmpty })
        flush()
    }

    // Selecting a seat never transfers training from another seat.
    fun adopt(owner: String?) {
        seat = Seat.of(owner)
    }

    fun claimItems(): List<ClaimItem> = ClaimSource.entries.flatMap { source ->
        held.shelves[source.seat]?.entries.orEmpty().values.sortedBy { it.dateLocal }.map {
            claimItem(source, ClaimKind.Bodyweight, it.dateLocal, it, WeighIn.serializer(), it.recordedAt)
        }
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
            shelf.entries.forEach { (date, value) ->
                if (held.shelves[key]?.entries?.get(date) != value) revisions[key to date] = (revisions[key to date] ?: 0) + 1
            }
        }
        held = next
    }

    private fun transfer(batch: ClaimBatch, owner: String?): Held {
        check(!transferFailed) { "Restart the app to recover the local-data decision." }
        if (held.claims.completed(batch, owner)) return held
        var shelves = held.shelves
        for (item in batch.items.filter { it.kind == ClaimKind.Bodyweight }) {
            val value = item.decode(WeighIn.serializer())
            check(value.dateLocal == item.id)
            if (owner != null) {
                val target = shelves[Seat.of(owner)] ?: Shelf()
                val existing = target.entries[item.id]
                if (existing == null || existing.recordedAt < value.recordedAt) {
                    shelves = shelves + (Seat.of(owner) to target.copy(entries = target.entries + (item.id to value),
                        owed = (target.owed + item.id).distinct(), deleted = target.deleted - item.id))
                }
            }
            val source = shelves[item.source.seat] ?: continue
            val existing = source.entries[item.id] ?: continue
            if (item.matches(existing, WeighIn.serializer())) {
                shelves = shelves + (item.source.seat to source.copy(entries = source.entries - item.id,
                    owed = source.owed - item.id, deleted = source.deleted - item.id))
            }
        }
        return held.copy(shelves = shelves.filterValues { !it.isEmpty }, claims = held.claims + (batch.id to (owner?.let { "owner:$it" } ?: "discard")))
    }

    // Ascending by date.
    val entries: List<WeighIn> get() = mine.entries.values.sortedBy { it.dateLocal }

    val latest: WeighIn? get() = entries.lastOrNull()

    val owed: List<WeighIn> get() = mine.owed.mapNotNull { mine.entries[it] }.sortedBy { it.dateLocal }

    val deletions: List<String> get() = mine.deleted.sorted()

    fun revision(dateLocal: String): Long = revisions[seat to dateLocal] ?: 0L

    // The row that stands after the write: the newer of the two by `recordedAt`.
    fun record(weighIn: WeighIn): WeighIn {
        val standing = mine.entries[weighIn.dateLocal]
        if (standing != null && standing.recordedAt > weighIn.recordedAt) return standing
        revisions[seat to weighIn.dateLocal] = revision(weighIn.dateLocal) + 1
        keep(mine.copy(
            entries = mine.entries + (weighIn.dateLocal to weighIn),
            owed = (mine.owed + weighIn.dateLocal).distinct(),
            deleted = mine.deleted - weighIn.dateLocal,
        ))
        return weighIn
    }

    fun delete(dateLocal: String) {
        revisions[seat to dateLocal] = revision(dateLocal) + 1
        keep(mine.copy(
            entries = mine.entries - dateLocal,
            owed = mine.owed - dateLocal,
            deleted = (mine.deleted + dateLocal).distinct(),
        ))
    }

    // The server's row, which may be newer than the one that went out; nothing is owed for it now.
    // A write made while the reply was in the air is newer than the reply and stays owed.
    fun landed(stored: WeighIn) {
        val standing = mine.entries[stored.dateLocal]
        if (standing != null && standing.recordedAt > stored.recordedAt) return
        keep(mine.copy(
            entries = mine.entries + (stored.dateLocal to stored),
            owed = mine.owed - stored.dateLocal,
        ))
    }

    fun deletionLanded(dateLocal: String) {
        keep(mine.copy(deleted = mine.deleted - dateLocal))
    }

    // A refusal that cannot change: the row leaves, because the log will never hold it and a chart
    // drawing it would be drawing a number the account does not have.
    fun letGo(dateLocal: String) {
        keep(mine.copy(entries = mine.entries - dateLocal, owed = mine.owed - dateLocal))
    }

    // Pending writes survive missing or older server rows; a newer canonical row settles the date.
    fun readBack(stored: List<WeighIn>) {
        val served = stored.filterNot { it.dateLocal in mine.deleted }.associateBy { it.dateLocal }
        val pending = mine.owed.mapNotNull { date ->
            val local = mine.entries[date] ?: return@mapNotNull null
            val remote = served[date]
            if (remote != null && remote.recordedAt >= local.recordedAt) return@mapNotNull null
            date to local
        }.toMap()
        keep(mine.copy(entries = served + pending, owed = pending.keys.toList()))
    }

    private fun flush() {
        storage.write(held, Held.serializer())
    }
}
