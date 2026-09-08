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
    const val maxSets = Scheme.maxSets
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

// The target sheet's two zooms — the head, which speaks about every set at once, and the ladder,
// one row per set — and the six refusals, each drawn under the row that carries it. The sheet holds
// TEXT until the commit, so a half-typed row survives every keystroke; this is where the text is
// read into a scheme. Emptying a field IS how it is cleared, and the placeholder says what empty
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

    const val setsPlaceholder = "open"
    const val repsPlaceholder = "max"
    const val weightPlaceholder = "last time"
    // The head's placeholder while the rows disagree; typing over it writes every row again.
    const val varies = "varies"

    // What the open line MEANS, said once, on the target sheet, where the lifter is deciding it.
    // `Readout.openTarget` is the compact token a row prints; this is the sentence, and it is the
    // same one on every surface.
    const val openLine = "You decide the numbers at the rack."

    const val everySet = "Every set"
    const val setBySet = "Set by set"
    const val addSet = "Add set"
    const val fill = "Fill"
    const val rampUp = "Ramp up"
    const val matchSetOne = "Match set 1"
    const val delete = "Delete"
    // The deviation sheet's button on a scheme whose sets disagree.
    const val saveTodaysSets = "Save today’s sets"

    enum class Field { Sets, Reps, Weight }

    // One ladder row as typed: text per field, never numbers.
    data class TypedSet(val reps: String = "", val weight: String = "") {
        constructor(set: SetTarget) :
            this(set.reps?.toString() ?: "", set.weightKg?.let(Readout::weight) ?: "")
    }

    sealed interface Reading {
        // One refusal at a time. `row` is null under the head's Sets field, else the 0-based ladder
        // row carrying the fault.
        data class Refused(val row: Int?, val field: Field, val said: String) : Reading

        // The head's Sets is empty: the line is open, whatever the hidden rows still hold.
        data object Open : Reading

        data class Scheme(val sets: List<SetTarget>) : Reading
    }

    // The count is read first, then the rows top to bottom, reps before load in each, so the lifter
    // is never told about a lower row while a higher one is still nonsense. A blank Sets is the open
    // line — the rows are hidden, not lost — and only a commit of it drops them. The rows past the
    // count are hidden the same way: the reading is the count's prefix, `resized` up to it.
    fun reading(sets: String, rows: List<TypedSet>): Reading {
        if (sets.isBlank()) return Reading.Open
        val counted = whole(sets, setsBand, outsideSets)
        counted.said?.let { return Reading.Refused(null, Field.Sets, it) }
        val ladder = resized(rows, counted.whole!!)
        val scheme = ladder.mapIndexed { index, row ->
            val repeated = whole(row.reps, repsBand, outsideReps)
            repeated.said?.let { return Reading.Refused(index, Field.Reps, it) }
            val loaded = load(row.weight)
            loaded.said?.let { return Reading.Refused(index, Field.Weight, it) }
            SetTarget(reps = repeated.whole, weightKg = loaded.kg)
        }
        return Reading.Scheme(scheme)
    }

    // The head's derived text: the value every row shares, or "" where they differ.
    fun sharedReps(rows: List<TypedSet>): String = shared(rows.map { it.reps })

    fun sharedWeight(rows: List<TypedSet>): String = shared(rows.map { it.weight })

    // Whether the head's empty field means `varies` rather than its own placeholder.
    fun repsVary(rows: List<TypedSet>): Boolean = rows.map { it.reps.trim() }.distinct().size > 1

    fun weightVaries(rows: List<TypedSet>): Boolean = rows.map { it.weight.trim() }.distinct().size > 1

    // The head's copy-down: that text into every row.
    fun withReps(rows: List<TypedSet>, reps: String): List<TypedSet> = rows.map { it.copy(reps = reps) }

    fun withWeight(rows: List<TypedSet>, weight: String): List<TypedSet> = rows.map { it.copy(weight = weight) }

    // Growing copies the last row rather than adding a blank; shrinking drops from the end.
    fun resized(rows: List<TypedSet>, count: Int): List<TypedSet> {
        val wanted = count.coerceIn(1, Program.maxSets)
        if (rows.size >= wanted) return rows.take(wanted)
        val top = rows.lastOrNull() ?: TypedSet()
        return rows + List(wanted - rows.size) { top }
    }

    // What typing the count does to the sheet's rows: grows them, never shrinks them. A count typed
    // under the rows hides the tail; typing it back reveals the same rows.
    fun grown(rows: List<TypedSet>, count: Int): List<TypedSet> =
        if (rows.size >= count) rows else resized(rows, count)

    // The rows the sheet draws: the count's prefix while the count reads as one, else every row.
    fun shown(rows: List<TypedSet>, sets: String): List<TypedSet> {
        val count = whole(sets, setsBand, outsideSets).whole ?: return rows
        return rows.take(count)
    }

    // Whose fault a refusal is. The count's is always the head's; a reps or load refusal is the
    // head's when every shown row carries the text the head shows — typed there, it was written
    // into every row and read at the first — and that row's otherwise.
    fun inTheHead(refused: Reading.Refused, shown: List<TypedSet>): Boolean = when (refused.field) {
        Field.Sets -> true
        Field.Reps -> sharedReps(shown).isNotEmpty()
        Field.Weight -> sharedWeight(shown).isNotEmpty()
    }

    fun matchFirst(rows: List<TypedSet>): List<TypedSet> {
        val first = rows.firstOrNull() ?: return rows
        return rows.map { first }
    }

    // Both ends have to read as sets before there is anything to ramp between.
    fun canRamp(rows: List<TypedSet>): Boolean {
        if (rows.size < 3) return false
        if (set(rows.first()) == null || set(rows.last()) == null) return false
        return Scheme.canRamp(rows.map { set(it) ?: SetTarget() })
    }

    fun rampUp(rows: List<TypedSet>): List<TypedSet> {
        if (!canRamp(rows)) return rows
        return Scheme.rampUp(rows.map { set(it) ?: SetTarget() }).map(::TypedSet)
    }

    fun rows(sets: List<SetTarget>): List<TypedSet> = sets.map(::TypedSet)

    // The commit button's tail, in the words the row itself will print: `open` · `5 × 5 · 80` on a
    // straight scheme · `5 sets` where the sets disagree · none while something is refused, when the
    // button reads `Set` alone and is disabled.
    fun commit(reading: Reading): String? = when (reading) {
        Reading.Open -> Readout.openTarget
        is Reading.Refused -> null
        is Reading.Scheme ->
            if (Scheme.straight(reading.sets)) Readout.target(reading.sets)
            else "${reading.sets.size} sets"
    }

    fun commitLabel(reading: Reading): String = listOfNotNull("Set", commit(reading)).joinToString(" · ")

    private fun shared(typed: List<String>): String = typed.map { it.trim() }.distinct().singleOrNull() ?: ""

    // A row read on its own: null where either field refuses.
    private fun set(row: TypedSet): SetTarget? {
        val repeated = whole(row.reps, repsBand, outsideReps)
        if (repeated.said != null) return null
        val loaded = load(row.weight)
        if (loaded.said != null) return null
        return SetTarget(repeated.whole, loaded.kg)
    }

    private data class Read(val whole: Int? = null, val kg: Double? = null, val said: String? = null)

    // The same six steps as `load`, in the same order, so a field that counts refuses for the same
    // reasons a field that weighs does: a comma is a decimal point, a second point is its own fault,
    // what will not parse is not a number, a typed zero is no target, and a number that is real but
    // not whole is refused BY ITS BAND — the band's sentence is the one that says `Whole`.
    private fun whole(typed: String, band: IntRange, outside: String): Read {
        val raw = typed.trim().replace("−", "-")
        if (raw.isEmpty()) return Read()
        val normalised = raw.replace(",", ".")
        if (normalised.count { it == '.' } > 1) return Read(said = onePoint)
        val value = normalised.toDoubleOrNull()
        if (value == null || !value.isFinite()) return Read(said = notANumber)
        if (value == 0.0) return Read(said = zeroTarget)
        if (value != kotlin.math.floor(value)) return Read(said = outside)
        val counted = value.toInt()
        if (counted !in band) return Read(said = outside)
        return Read(whole = counted)
    }

    private fun load(typed: String): Read {
        val raw = typed.trim().replace("−", "-")
        if (raw.isEmpty()) return Read()
        val normalised = raw.replace(",", ".")
        if (normalised.count { it == '.' } > 1) return Read(said = onePoint)
        val value = normalised.toDoubleOrNull()
        if (value == null || !value.isFinite()) return Read(said = notANumber)
        if (kotlin.math.abs(value) > maxWeightKg) return Read(said = overWeight)
        if (value == 0.0) return Read(said = zeroTarget)
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

    // Zero-based, both ends clamped to the rows that exist, the same arithmetic as the web's
    // `reorderEntries`: the line leaves `from` and lands at `to`, and every position is renumbered.
    fun moving(from: Int, to: Int): RoutineDraft {
        if (entries.isEmpty()) return this
        val ordered = entries.sortedBy { it.position }.toMutableList()
        val entry = ordered.removeAt(from.coerceIn(0, ordered.lastIndex))
        ordered.add(to.coerceIn(0, ordered.size), entry)
        return copy(entries = renumbered(ordered))
    }

    // The line's scheme, loads on the ladder's grid; a set's null reps mean `max` and a null load
    // means `last time`, which is the domain's own reading of them.
    fun targeting(exerciseId: String, sets: List<SetTarget>): RoutineDraft =
        mapping(exerciseId) { it.copy(sets = Scheme.rounded(sets)) }

    // Opens the line: no sets at all, which is the absence the wire carries.
    fun opening(exerciseId: String): RoutineDraft =
        mapping(exerciseId) { it.copy(sets = emptyList()) }

    fun entry(exerciseId: String): RoutineEntry? = entries.firstOrNull { it.exerciseId == exerciseId }

    // One-based; a movement no longer in the day answers null.
    fun placeOf(exerciseId: String): Int? =
        entries.indexOfFirst { it.exerciseId == exerciseId }.takeIf { it >= 0 }?.plus(1)

    // Every routine write is a WHOLE document, and a line's position is its place in the day.
    val write: List<RoutineEntryWrite>
        get() = entries.sortedBy { it.position }.map {
            RoutineEntryWrite(it.exerciseId, it.sets, it.restSeconds)
        }

    private fun mapping(exerciseId: String, move: (RoutineEntry) -> RoutineEntry): RoutineDraft =
        copy(entries = entries.map { if (it.exerciseId == exerciseId) move(it) else it })

    private fun renumbered(entries: List<RoutineEntry>): List<RoutineEntry> =
        entries.mapIndexed { index, entry -> entry.copy(position = index + 1) }

    companion object {
        fun of(routine: Routine): RoutineDraft = RoutineDraft(
            id = routine.id,
            name = routine.name,
            position = routine.position,
            entries = routine.entries.sortedBy { it.position },
            trained = !routine.untested,
        )
    }
}
