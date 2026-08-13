package works.windmill.gym.domain

import kotlinx.serialization.Serializable

// BUILDING A DAY BEFORE YOU GO (§M) — the third door onto a routine, and the rules behind it with no
// Compose in them. Two doors already existed: a routine falls out of a session you already did
// (screen 3, the default and the only one a first-time user meets), or an agent proposes one. This
// is the one a lifter with a program in a notebook reaches for first, and it is the only door that
// runs before any training has happened at all.
//
// WHICH IS WHY EVERY NUMBER HERE IS TYPED AND NONE OF THEM IS GUESSED. There is no last time to
// reach for — the routine has not been trained yet, by construction — so the sheet says so and the
// steppers open on the empty bar rather than on somebody's history. A prefill here would be the app
// inventing a target and then quietly attributing it to the lifter.
//
// A ROUTINE IS SAVABLE WHILE INCOMPLETE. A row with no set target is `open` and simply asks at the
// rack; `untested` marks the whole day until its first session, so the first session is allowed to
// disagree with it. Nothing in this file is a wizard, a step counter, a template gallery or a week:
// a routine is a list with a name, and a week is a thing lifters keep in their head.
object Program {
    // The board's counter, and it is TIGHTER than the column: the log takes 80 bytes and this takes
    // 60 characters. A client bound inside the server's costs nothing and refuses nothing already
    // stored — where the two disagree (a 60-character name in a script that runs three bytes to the
    // character) the log answers in its own words and the room repeats it.
    const val maxNameLength = 60

    // The server's own bounds, restated so the builder stops offering a step the log can only
    // refuse — a day of 51 movements, a target of 21 sets, a rep count of 101. They are ceilings and
    // never suggestions: nothing here dials toward them.
    const val maxEntries = 50
    const val maxSets = 20
    const val maxReps = 100

    // SUGGESTIONS, NEVER RULES — tapping one fills the field, and typing over it is the expected
    // case. They are the board's three, spelled as constants rather than derived from the clock: a
    // weekday read off this device would make the third one a different word every day, and a
    // suggestion that moves is one nobody can learn.
    val suggestions = listOf("Push C", "Lower B", "Thursday")

    // Counted in CODE POINTS and not in UTF-16 units, because the cap is a promise about characters:
    // a name with an emoji in it would otherwise burn two of the sixty on one glyph.
    fun length(name: String): Int = name.codePointCount(0, name.length)

    fun counter(name: String): String = "${length(name)}/$maxNameLength"

    // The overflow is refused and nothing already typed is touched — a field that truncated from the
    // front, or cleared itself, would be the room throwing away what somebody typed.
    fun capped(typed: String): String {
        if (length(typed) <= maxNameLength) return typed
        return typed.substring(0, typed.offsetByCodePoints(0, maxNameLength))
    }

    // A name is the one thing a routine cannot be saved without: §M asks for it FIRST and asks once,
    // because a routine built on purpose deserves the word you call it and not "Workout 3".
    fun named(name: String): String? = name.trim().takeIf { it.isNotEmpty() }

    // A RENAME IS A CHANGE OR IT IS NOTHING (§N: "neither ever costs you history"). Renaming a
    // routine to the name it already has is not free — the write is the whole document, so it moves
    // the revision and supersedes every proposal waiting on that day, which is the right consequence
    // for a real rename and a theft for a no-op. So the sheet's own button is what refuses it, on
    // the same rule for both doors: the TRIMMED name is compared, because the trimmed name is the
    // one that would be written.
    fun renamed(from: String, typed: String): String? = named(typed)?.takeIf { it != from }

    // WHAT THE ROUTINE'S OWN PAGE SAYS ABOUT ITSELF (screen 30) — the chip and the line beside it.
    // A day that has run says when it last ran, which is the fact both lists sort by; a day that has
    // not says when it was BUILT, which is the only date it has. They are never both drawn: two
    // dates over one name is a lifter working out which one they are reading.
    //
    // The built date comes off the created row of the HISTORY THE SCREEN READ, and it is handed in
    // rather than read off the routine: the routine on this screen came from the LIST, which carries
    // no history at all, so a head that reached into the document in hand would have drawn the
    // fallback forever and the board's line never once. It is absent until that read lands, and
    // absent for good signed out or on a routine the shelf still holds, where the line falls back to
    // what the lists print. Nothing here invents a build date: the device does not know one, and a
    // routine claimed onto an account later is created on the log the day the claim lands.
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

    // THE FACT UNDER THE LIST, and it is a fact rather than an explanation: `Barbell Row has no
    // target — it will ask at the rack` tells the lifter what will happen to their training. Why
    // this product allows open rows at all is an argument, and arguments live on the board.
    //
    // Silent where every row has a target, because there is nothing to say — and never a reassurance
    // that a complete routine is complete.
    fun openLine(movements: List<String>): String? {
        if (movements.isEmpty()) return null
        if (movements.size == 1) return "${movements.first()} has no target — it will ask at the rack."
        val head = movements.dropLast(1).joinToString(", ")
        return "$head and ${movements.last()} have no targets — they will ask at the rack."
    }

    fun movements(count: Int): String = if (count == 1) "1 movement" else "$count movements"
}

// THE DAY BEING BUILT, and it is a document rather than a wizard's accumulated answers: the name,
// the movements in the order they will be performed, and whatever targets have been typed so far.
// It is savable at every point after the first movement lands, which is why there is no step
// counter — nothing here is a stage anybody has to complete.
//
// IT IS SERIALIZABLE BECAUSE IT HAS TO OUTLIVE THE PROCESS. A half-typed routine exists nowhere but
// in memory — it is not on the log, not on the shelf and not in the queue — so an activity that is
// reclaimed mid-build would take an evening of typing with it. The room saves it (GymRoom), the same
// way it saves a conversation, and for the same reason.
//
// `id` ABSENT IS A ROUTINE THAT DOES NOT EXIST YET. Present, this is an edit and a rename: the same
// document, PUT whole, which is what moves the revision and supersedes any pending proposal — the
// consequence a routine's name changing is supposed to have.
@Serializable
data class RoutineDraft(
    val id: String? = null,
    val name: String = "",
    val position: Int = 0,
    val entries: List<RoutineEntry> = emptyList(),
    // Whether the routine behind this draft has ever been trained. False for everything built here,
    // by construction, and it is what withholds `Never logged — these are your numbers.` from an
    // edit of a day that has run: that line is true of a new routine and a lie about an old one.
    val trained: Boolean = false,
) {
    val savable: Boolean get() = Program.named(name) != null && entries.isNotEmpty()

    val full: Boolean get() = entries.size >= Program.maxEntries

    fun named(to: String): RoutineDraft = copy(name = Program.capped(to))

    // Appended at the foot, OPEN — the movement is in the day before any number is, which is the
    // order §M puts them in: movements, then targets in a sheet over the list. A movement already in
    // the day is not added twice; the routine is a list of movements and not of lines.
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

    // `Leave it open` CLEARS THE WHOLE ROW and not only its set count: the log refuses a half-open
    // line — reps or a weight with no sets — and a row reading `open` beside a weight it still
    // carried would be two answers to one question.
    fun opening(exerciseId: String): RoutineDraft =
        mapping(exerciseId) { it.copy(targetSets = null, targetReps = null, targetWeightKg = null) }

    fun entry(exerciseId: String): RoutineEntry? = entries.firstOrNull { it.exerciseId == exerciseId }

    // Which movement this is, of how many — the sheet's own place line, one-based because it is read
    // by a person. A movement no longer in the day answers null and the sheet closes over it.
    fun placeOf(exerciseId: String): Int? =
        entries.indexOfFirst { it.exerciseId == exerciseId }.takeIf { it >= 0 }?.plus(1)

    // The document as the wire takes it, in the order the list stands in — every routine write in
    // this product is a WHOLE document, and the position of a line is its place in the day.
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
        // The steppers' first position on a row nobody has typed a number into. Three sets of five
        // at the empty bar is the product's own starting point and not a guess about this lifter —
        // and the whole reason it may be a constant is that nothing here reaches for their history.
        const val startingSets = 3
        const val startingReps = 5

        // Editing a routine that already stands (screen 30's `Edit` and its `Rename`): the same
        // document, carried whole, because the write it becomes is a whole-document PUT.
        fun of(routine: Routine): RoutineDraft = RoutineDraft(
            id = routine.id,
            name = routine.name,
            position = routine.position,
            entries = routine.entries.sortedBy { it.position },
            trained = !routine.untested,
        )

        // `Duplicate` — the movements and their targets, and deliberately NOT the name: a copy is a
        // new day and §M asks for its name the way it asks for every other one, once and first.
        fun copying(routine: Routine, position: Int): RoutineDraft = RoutineDraft(
            position = position,
            entries = routine.entries.sortedBy { it.position }
                .mapIndexed { index, entry -> entry.copy(position = index + 1) },
        )
    }
}
