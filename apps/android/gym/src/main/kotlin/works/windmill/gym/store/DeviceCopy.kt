package works.windmill.gym.store

import java.io.File
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.Routine

// THE ACCOUNT'S READS, KEPT ON THE DEVICE FOR THE SEAT THAT MADE THEM. It began as the movement
// names alone: a movement is a stable id everywhere except on screen, and the id is a slug — so a
// cold launch in a basement gym, with the queue holding a live session and the catalog read still in
// flight, drew `bench-press` where `Bench Press` belongs, in the movement head at 28sp. Then the
// same basement made the same case for the rest of what a signed-in room reads: a lifter whose
// sign-in could not be verified because there was no signal is still signed in, and their room
// should open on THEIR program, THEIR names and THEIR last sets — the copy this device last read for
// them — rather than on an empty one. So the file now carries the routines and the picker's meta
// beside the names, each replaced whenever the log answers again.
//
// A COPY IS THE SEAT'S AND NOT THE PHONE'S, which is why the file carries the account it was filled
// for. A rename is a per-account override — `Back Squat` is `Low-bar Squat` for exactly one lifter —
// and a program is one lifter's own, so a copy filled for one account may not be drawn for the next
// one to hold this phone: it would cross a seat on the first frame, offline, indefinitely. A seat
// that does not match opens EMPTY and the file is overwritten the moment the new one reads its own,
// so nothing of the last account is left either on screen or on disk.
//
// One atomic file beside the queue's, written only when a copy actually changed — the queue is
// flushed on every tap and this is not, because a name nobody edited is not news. A file this build
// cannot read opens EMPTY rather than taking the room down with it: the copies are a convenience
// and the log is the truth, so the worst a lost file costs is one launch drawing slugs.
class DeviceCopy(private val file: File) {
    companion object {
        // Named for the catalog it began as, and kept so an install upgrading into this build opens
        // on the names it already held rather than on slugs.
        const val fileName = "windmill-gym-catalog.json"
    }

    // The account the copies below belong to, or none for the anonymous seat — which is a seat like
    // any other here, with movements of its own that it minted and named. `lastSets` is nullable
    // for the reason the store's own is: null is a read that never landed, and an empty list is a
    // lifter who has trained nothing — two facts the picker draws differently.
    @Serializable
    private data class Held(
        val owner: String? = null,
        val movements: List<Exercise> = emptyList(),
        val routines: List<Routine> = emptyList(),
        val lastSets: List<LastSet>? = null,
    )

    private var held: Held = runCatching {
        diskJson.decodeFromString(Held.serializer(), file.readText())
    }.getOrElse { Held() }

    fun movements(owner: String?): List<Exercise> =
        if (held.owner == owner) held.movements else emptyList()

    fun routines(owner: String?): List<Routine> =
        if (held.owner == owner) held.routines else emptyList()

    fun lastSets(owner: String?): List<LastSet>? =
        if (held.owner == owner) held.lastSets else null

    fun hold(owner: String?, movements: List<Exercise>) {
        hold(mine(owner).copy(movements = movements))
    }

    fun holdRoutines(owner: String?, routines: List<Routine>) {
        hold(mine(owner).copy(routines = routines))
    }

    fun holdLastSets(owner: String?, lastSets: List<LastSet>) {
        hold(mine(owner).copy(lastSets = lastSets))
    }

    // The copies as they stand for this seat — or a clean slate when the seat changed, so nothing of
    // the last account survives the first write the new one makes.
    private fun mine(owner: String?): Held = if (held.owner == owner) held else Held(owner)

    private fun hold(next: Held) {
        if (next == held) return
        held = next
        val text = runCatching { diskJson.encodeToString(Held.serializer(), next) }.getOrNull() ?: return
        writeAtomically(file, text)
    }
}
