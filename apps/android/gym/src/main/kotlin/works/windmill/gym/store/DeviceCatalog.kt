package works.windmill.gym.store

import java.io.File
import kotlinx.serialization.builtins.ListSerializer
import works.windmill.gym.domain.Exercise

// THE MOVEMENT NAMES, KEPT BESIDE THE QUEUE. A movement is a stable id everywhere except on
// screen, and the id is a slug — so a cold launch in a basement gym, with the queue holding a live
// session and the catalog read still in flight, draws `bench-press` where `Bench Press` belongs:
// in the movement head at 28sp, in the jump sheet, and in the refusal banner that is the last copy
// of a set somebody lifted.
//
// That is the whole reason ids are stable and names are display strings. The names are the same
// for everyone and change about never, so the device holds its own copy and redraws from it the
// instant the room opens; the read that follows replaces it whenever the log answers.
//
// One atomic file beside the queue's, written only when the catalog actually changed — the queue
// is flushed on every tap and this is not, because a name nobody edited is not news.
class DeviceCatalog(private val file: File) {
    companion object {
        const val fileName = "windmill-gym-catalog.json"
    }

    // A file this build cannot read opens EMPTY rather than taking the room down with it: the
    // names are a convenience and the ids are the truth, so the worst a lost file costs is the
    // slug it was there to replace.
    private var held: List<Exercise> = runCatching {
        diskJson.decodeFromString(ListSerializer(Exercise.serializer()), file.readText())
    }.getOrElse { emptyList() }

    val movements: List<Exercise> get() = held

    fun hold(movements: List<Exercise>) {
        if (movements == held) return
        held = movements
        val text = runCatching {
            diskJson.encodeToString(ListSerializer(Exercise.serializer()), movements)
        }.getOrNull() ?: return
        writeAtomically(file, text)
    }
}
