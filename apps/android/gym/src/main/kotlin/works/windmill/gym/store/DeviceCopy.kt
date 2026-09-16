package works.windmill.gym.store

import java.io.File
import works.windmill.platform.telemetry.Telemetry
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.serializer
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.Routine

// Scoped to the account that read it: a copy whose owner does not match reads empty.
class DeviceCopy(private val file: File, telemetry: Telemetry = Telemetry.None) {
    companion object {
        const val fileName = "windmill-gym-catalog.json"
    }

    // owner null is the anonymous seat. lastSets null is a read that never landed; empty is a lifter
    // who has trained nothing.
    @Serializable
    private data class Held(
        val owner: String? = null,
        val movements: List<Exercise> = emptyList(),
        val routines: List<Routine> = emptyList(),
        val lastSets: List<LastSet>? = null,
    )

    private val storage = StoredDocument(file, telemetry)
    private var held: Held = open()

    // Row by row, so one routine this build cannot read never empties the copy.
    private fun open(): Held {
        val document = storage.tree() ?: return Held()
        return Held(
            owner = storage.one(document["owner"], String.serializer()),
            movements = storage.each(document["movements"], Exercise.serializer()).orEmpty(),
            routines = storage.each(document["routines"], Routine.serializer()).orEmpty(),
            lastSets = storage.each(document["lastSets"], LastSet.serializer()),
        )
    }

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

    private fun mine(owner: String?): Held = if (held.owner == owner) held else Held(owner)

    private fun hold(next: Held) {
        if (next == held) return
        held = next
        storage.write(next, Held.serializer())
    }
}
