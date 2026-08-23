package works.windmill.gym.domain

import kotlinx.serialization.Serializable

// A routine is savable while incomplete: a row with no set target is `open` and asks at the rack.
object Program {
    // Tighter than the log's own bound of 80 bytes.
    const val maxNameLength = 60

    // The server's own bounds.
    const val maxEntries = 50
    const val maxSets = 20
    const val maxReps = 100

    val suggestions = listOf("Push C", "Lower B", "Thursday")

    // Code points, not UTF-16 units: the cap is a promise about characters.
    fun length(name: String): Int = name.codePointCount(0, name.length)

    fun counter(name: String): String = "${length(name)}/$maxNameLength"

    fun capped(typed: String): String {
        if (length(typed) <= maxNameLength) return typed
        return typed.substring(0, typed.offsetByCodePoints(0, maxNameLength))
    }

    fun named(name: String): String? = name.trim().takeIf { it.isNotEmpty() }

    // A no-op rename is refused: a whole-document write would supersede every proposal on that day.
    // The TRIMMED name is compared, since that is what writes.
    fun renamed(from: String, typed: String): String? = named(typed)?.takeIf { it != from }

    data class Head(val untested: Boolean, val line: String)

    fun head(routine: Routine, history: List<RoutineEvent>, nowMs: Long): Head {
        val built = history.firstOrNull { it.kind == "created" }
        if (!routine.untested || built == null) {
            return Head(routine.untested, Readout.routineLine(routine, nowMs))
        }
        val said = mutableListOf("built ${Readout.recentDay(built.atMs, nowMs)}")
        said += movements(built.movements ?: routine.entries.size)
        return Head(untested = true, line = said.joinToString(" · "))
    }

    fun openLine(movements: List<String>): String? {
        if (movements.isEmpty()) return null
        if (movements.size == 1) return "${movements.first()} has no target — it will ask at the rack."
        val head = movements.dropLast(1).joinToString(", ")
        return "$head and ${movements.last()} have no targets — they will ask at the rack."
    }

    fun movements(count: Int): String = if (count == 1) "1 movement" else "$count movements"
}

// `id` absent is a routine that does not exist yet; present, this is an edit PUT whole.
@Serializable
data class RoutineDraft(
    val id: String? = null,
    val name: String = "",
    val position: Int = 0,
    val entries: List<RoutineEntry> = emptyList(),
    val trained: Boolean = false,
) {
    val savable: Boolean get() = Program.named(name) != null && entries.isNotEmpty()

    val full: Boolean get() = entries.size >= Program.maxEntries

    fun named(to: String): RoutineDraft = copy(name = Program.capped(to))

    fun adding(exerciseId: String): RoutineDraft {
        if (full || entries.any { it.exerciseId == exerciseId }) return this
        return copy(entries = entries + RoutineEntry(position = entries.size + 1, exerciseId = exerciseId))
    }

    fun removing(exerciseId: String): RoutineDraft =
        copy(entries = renumbered(entries.filterNot { it.exerciseId == exerciseId }))

    fun targeting(exerciseId: String, sets: Int, reps: Int, weightKg: Double): RoutineDraft =
        mapping(exerciseId) {
            it.copy(targetSets = sets, targetReps = reps, targetWeightKg = Ladder.round(weightKg))
        }

    // Clears the whole row: the log refuses a half-open line — reps or a weight with no sets.
    fun opening(exerciseId: String): RoutineDraft =
        mapping(exerciseId) { it.copy(targetSets = null, targetReps = null, targetWeightKg = null) }

    fun entry(exerciseId: String): RoutineEntry? = entries.firstOrNull { it.exerciseId == exerciseId }

    fun duplicated(position: Int): RoutineDraft = RoutineDraft(
        position = position,
        entries = entries.sortedBy { it.position }
            .mapIndexed { index, entry -> entry.copy(position = index + 1) },
    )

    // One-based; a movement no longer in the day answers null.
    fun placeOf(exerciseId: String): Int? =
        entries.indexOfFirst { it.exerciseId == exerciseId }.takeIf { it >= 0 }?.plus(1)

    // Every routine write is a WHOLE document, and a line's position is its place in the day.
    val write: List<RoutineEntryWrite>
        get() = entries.sortedBy { it.position }.map {
            RoutineEntryWrite(it.exerciseId, it.targetSets, it.targetReps, it.targetWeightKg,
                              it.restSeconds)
        }

    private fun mapping(exerciseId: String, move: (RoutineEntry) -> RoutineEntry): RoutineDraft =
        copy(entries = entries.map { if (it.exerciseId == exerciseId) move(it) else it })

    private fun renumbered(entries: List<RoutineEntry>): List<RoutineEntry> =
        entries.mapIndexed { index, entry -> entry.copy(position = index + 1) }

    companion object {
        const val startingSets = 3
        const val startingReps = 5

        fun of(routine: Routine): RoutineDraft = RoutineDraft(
            id = routine.id,
            name = routine.name,
            position = routine.position,
            entries = routine.entries.sortedBy { it.position },
            trained = !routine.untested,
        )
    }
}
