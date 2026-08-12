package works.windmill.gym.store

import java.io.File
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.Exercise

// THE MOVEMENT NAMES, KEPT BESIDE THE QUEUE. A movement is a stable id everywhere except on
// screen, and the id is a slug — so a cold launch in a basement gym, with the queue holding a live
// session and the catalog read still in flight, draws `bench-press` where `Bench Press` belongs:
// in the movement head at 28sp, in the assembly list, and in the refusal banner that is the last copy
// of a set somebody lifted.
//
// That is the whole reason ids are stable and names are display strings, and it is why the device
// holds its own copy and redraws from it the instant the room opens; the read that follows replaces
// it whenever the log answers.
//
// A NAME IS THE SEAT'S AND NOT THE PHONE'S, which is why the file carries the account it was filled
// for. A rename is a per-account override — `Back Squat` is `Low-bar Squat` for exactly one lifter —
// so a cache filled for one account may not be drawn for the next one to hold this phone: a private
// name would cross a seat, and it would do it on the first frame, offline, indefinitely. A seat that
// does not match opens EMPTY and the file is overwritten the moment the new one reads its own, so
// nothing of the last account is left either on screen or on disk.
//
// One atomic file beside the queue's, written only when the catalog actually changed — the queue
// is flushed on every tap and this is not, because a name nobody edited is not news.
class DeviceCatalog(private val file: File) {
    companion object {
        const val fileName = "windmill-gym-catalog.json"
    }

    // The account the names below belong to, or none for the anonymous seat — which is a seat like
    // any other here, with movements of its own that it minted and named.
    @Serializable
    private data class Held(val owner: String? = null, val movements: List<Exercise> = emptyList())

    // A file this build cannot read opens EMPTY rather than taking the room down with it: the
    // names are a convenience and the ids are the truth, so the worst a lost file costs is the
    // slug it was there to replace.
    private var held: Held = runCatching {
        diskJson.decodeFromString(Held.serializer(), file.readText())
    }.getOrElse { Held() }

    fun movements(owner: String?): List<Exercise> =
        if (held.owner == owner) held.movements else emptyList()

    fun hold(owner: String?, movements: List<Exercise>) {
        val next = Held(owner, movements)
        if (next == held) return
        held = next
        val text = runCatching { diskJson.encodeToString(Held.serializer(), next) }.getOrNull() ?: return
        writeAtomically(file, text)
    }
}
