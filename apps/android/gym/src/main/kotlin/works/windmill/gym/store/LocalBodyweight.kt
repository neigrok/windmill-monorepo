package works.windmill.gym.store

import java.io.File
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.WeighIn

// The device's copy of the bodyweight series, filed per seat like every other store, and local-first
// like a set: a weigh-in lands here before the log is consulted and is owed to the server until the
// server answers for it. The date is the row's identity, so a second write to the same day replaces
// the first; the newer `recordedAt` wins, on this phone as on the server.
class LocalBodyweight(private val file: File, deviceOwner: String? = null) {
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
    private data class Held(val shelves: Map<String, Shelf> = emptyMap())

    private var seat: String = Seat.of(deviceOwner)
    private val revisions = mutableMapOf<Pair<String, String>, Long>()
    private var held: Held = runCatching {
        diskJson.decodeFromString(Held.serializer(), file.readText())
    }.getOrElse { Held() }

    private val mine: Shelf get() = held.shelves[seat] ?: Shelf()

    private fun keep(next: Shelf) {
        held = Held((held.shelves + (seat to next)).filterValues { !it.isEmpty })
        flush()
    }

    // The one place the seat changes hands. The anonymous shelf MOVES onto a confirmed account seat:
    // every row on it is still owed, because nobody was signed in to send it.
    fun adopt(owner: String?, confirmed: Boolean = true) {
        val next = Seat.of(owner)
        val anonymous = held.shelves[Seat.anonymous] ?: Shelf()
        val carrying = owner != null && confirmed && !anonymous.isEmpty
        if (next == seat && !carrying) return
        val arriving = held.shelves[next] ?: Shelf()
        val landed = if (!carrying) arriving else Shelf(
            entries = arriving.entries + anonymous.entries.filterValues { mine ->
                val theirs = arriving.entries[mine.dateLocal]
                theirs == null || theirs.recordedAt < mine.recordedAt
            },
            owed = (arriving.owed + anonymous.entries.keys).distinct(),
            deleted = arriving.deleted.filterNot { it in anonymous.entries },
        )
        val parked = if (carrying) held.shelves - Seat.anonymous else held.shelves
        seat = next
        held = Held((parked + (next to landed)).filterValues { !it.isEmpty })
        flush()
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
        val text = runCatching { diskJson.encodeToString(Held.serializer(), held) }.getOrNull() ?: return
        writeAtomically(file, text)
    }
}
