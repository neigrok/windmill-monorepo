package works.windmill.gym.domain

import kotlinx.serialization.Serializable

// A routine is savable while incomplete: a row with no set target is `open` and asks at the rack.
object Program {
    // Counted in CODE POINTS, the unit the store counts in (`char_length`) and the one web and iOS
    // draw too. Sixty of them weigh at most 240 bytes, which is the store's own ceiling, so a name
    // this field accepts is a name the log takes.
    const val maxNameLength = 60

    // The counter appears in the last fifth and is silent before it — the same rule and the same
    // fifth as the note editor's byte counter (`Notes.counterFrom`), because a lifter should not have
    // to learn two rules for the same idea.
    const val counterFrom = 48

    // What the two Save refusals say, one at a time and never concatenated: there is no screen before
    // the editor to have asked for a name, so the name is the first thing missing.
    const val nameItToSaveIt = "Name it to save it."
    const val atLeastOneMovement = "A routine is at least one movement."

    // The server's own bounds. These are the PLAN's bands, which `TargetEntry` enforces; a set that
    // was performed is bounded separately by `KeypadEntry.maxLoggedReps`.
    const val maxEntries = 50
    const val maxSets = 20
    const val maxReps = 100

    // Code points, not UTF-16 units: the cap is a promise about characters.
    fun length(name: String): Int = name.codePointCount(0, name.length)

    // Null below the threshold: nothing is drawn.
    fun counter(name: String): String? {
        val used = length(name)
        if (used < counterFrom) return null
        return "$used/$maxNameLength"
    }

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

    fun movements(count: Int): String = if (count == 1) "1 movement" else "$count movements"

    // One at a time and in this order; null once the draft is savable.
    fun missing(draft: RoutineDraft): String? {
        if (named(draft.name) == null) return nameItToSaveIt
        if (draft.entries.isEmpty()) return atLeastOneMovement
        return null
    }
}

// The target sheet's three typed fields — sets, reps, weight — and the six refusals the removed
// keypad left homeless. Emptying a field IS how it is cleared, and the placeholder says what empty
// means: no sets is an open line, no reps is `max`, no load is `last time`.
//
// The bands here are the PLAN's (`Program.maxSets`, `Program.maxReps`): 1 to 20 sets and 1 to 100
// reps. The logger and the fix sheet enforce `KeypadEntry.maxLoggedReps` instead, because a set that
// was performed is not a target.
object TargetEntry {
    val setsBand = 1..Program.maxSets
    val repsBand = 1..Program.maxReps
    const val maxWeightKg = 500.0

    const val onePoint = "One decimal point only."
    const val notANumber = "That is not a number yet."
    const val overWeight = "Over 500 kg — check the number."
    const val outsideReps = "Whole reps, 1 to 100."
    const val outsideSets = "Sets, 1 to 20."
    const val zeroTarget = "A zero target is no target — clear the field instead."
    const val clearTheRest = "Clear reps and weight first — an open line names neither."
    // The same shape reached from the other side — a number typed onto a line whose sets are empty —
    // and the remedy is the opposite one, so it cannot be said in the sentence above: telling the
    // lifter to clear what they just typed would be telling them to abandon what they asked for.
    const val nameSetsFirst = "Name the sets first — an open line names neither."

    // Said once beside the fields rather than refused: most of the world writes a decimal with a comma.
    const val decimalHint = "comma or point, both read as a decimal"

    const val setsPlaceholder = "open"
    const val repsPlaceholder = "max"
    const val weightPlaceholder = "last time"

    // What the open line MEANS, said where the lifter is deciding it. `Readout.openTarget` stays the
    // compact token a row prints; this is the sentence, and it is the same one on every surface.
    const val openLine = "You decide the numbers at the rack."

    enum class Field { Sets, Reps, Weight }

    sealed interface Reading {
        // One refusal at a time, drawn under the field it belongs to.
        data class Refused(val field: Field, val said: String) : Reading

        // All three empty: the line names no sets, so it names no reps and no weight either.
        data object Open : Reading

        data class Targeted(val sets: Int, val reps: Int?, val weightKg: Double?) : Reading
    }

    // The open line's SHAPE is read before the fields are — a line with no sets may name no reps and
    // no load, whatever those two say — and then the fields fail-fast in the order they are drawn, so
    // the lifter is never told about the third while the first is still nonsense.
    fun reading(sets: String, reps: String, weight: String): Reading {
        if (sets.isBlank() && (reps.isNotBlank() || weight.isNotBlank())) {
            return Reading.Refused(Field.Sets, nameSetsFirst)
        }
        val counted = whole(sets, Field.Sets, setsBand, outsideSets)
        counted.refused?.let { return it }
        val repeated = whole(reps, Field.Reps, repsBand, outsideReps)
        repeated.refused?.let { return it }
        val loaded = load(weight)
        loaded.refused?.let { return it }
        val named = counted.whole ?: return Reading.Open
        return Reading.Targeted(named, repeated.whole, loaded.kg)
    }

    // Refuses the CLEAR rather than cascading it: a lifter who empties sets to retype it would
    // otherwise lose two numbers they did not mean to lose.
    fun clearingSets(reps: String, weight: String): String? {
        if (reps.isBlank() && weight.isBlank()) return null
        return clearTheRest
    }

    private data class Read(
        val whole: Int? = null,
        val kg: Double? = null,
        val refused: Reading.Refused? = null,
    )

    // The same six steps as `load`, in the same order, so a field that counts refuses for the same
    // reasons a field that weighs does: a comma is a decimal point, a second point is its own fault,
    // what will not parse is not a number, a typed zero is no target, and a number that is real but
    // not whole is refused BY ITS BAND — the band's sentence is the one that says `Whole`.
    private fun whole(typed: String, field: Field, band: IntRange, outside: String): Read {
        val raw = typed.trim().replace("−", "-")
        if (raw.isEmpty()) return Read()
        val normalised = raw.replace(",", ".")
        if (normalised.count { it == '.' } > 1) {
            return Read(refused = Reading.Refused(field, onePoint))
        }
        val value = normalised.toDoubleOrNull()
        if (value == null || !value.isFinite()) {
            return Read(refused = Reading.Refused(field, notANumber))
        }
        if (value == 0.0) return Read(refused = Reading.Refused(field, zeroTarget))
        if (value != kotlin.math.floor(value)) return Read(refused = Reading.Refused(field, outside))
        val counted = value.toInt()
        if (counted !in band) return Read(refused = Reading.Refused(field, outside))
        return Read(whole = counted)
    }

    private fun load(typed: String): Read {
        val raw = typed.trim().replace("−", "-")
        if (raw.isEmpty()) return Read()
        val normalised = raw.replace(",", ".")
        if (normalised.count { it == '.' } > 1) {
            return Read(refused = Reading.Refused(Field.Weight, onePoint))
        }
        val value = normalised.toDoubleOrNull()
        if (value == null || !value.isFinite()) {
            return Read(refused = Reading.Refused(Field.Weight, notANumber))
        }
        if (kotlin.math.abs(value) > maxWeightKg) {
            return Read(refused = Reading.Refused(Field.Weight, overWeight))
        }
        if (value == 0.0) return Read(refused = Reading.Refused(Field.Weight, zeroTarget))
        return Read(kg = Ladder.round(value))
    }
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

    // Sets are what make a line a target at all; cleared reps mean `max` and a cleared load means
    // `last time`, which is the domain's own reading of a null.
    fun targeting(exerciseId: String, sets: Int, reps: Int?, weightKg: Double?): RoutineDraft =
        mapping(exerciseId) {
            it.copy(targetSets = sets, targetReps = reps, targetWeightKg = weightKg?.let(Ladder::round))
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
