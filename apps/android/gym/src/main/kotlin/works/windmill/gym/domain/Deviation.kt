package works.windmill.gym.domain

// CHANGE TODAY, OR CHANGE THE PROGRAM — the one moment gym asks a question it did not have to ask.
// The plan snapshot is frozen, so last Tuesday keeps reading correctly whichever way this is
// answered; what is at stake is only whether next week's target moves with the lifter.
//
// THE SERVER NEVER INFERS THIS. It never auto-writes a routine and never asks — a store that noticed
// a heavier set and quietly rewrote the program would be changing what somebody wrote down, on the
// evidence of one afternoon. The offer is the client's, it is raised ONCE per movement per session
// at the exercise boundary, and declining costs nothing.
//
// ONLY HEAVIER. The design's own title says so and the restriction is the honest half of the rule:
// dropping the weight mid-exercise is a bad night far more often than it is a decision, and writing
// that back would lower next week's target off one session and then read as a failed session every
// time it came round.
//
// This is the pure offer rule alone; ui/DeviationSheet.kt renders it.

data class DeviationOffer(
    val exerciseId: String,
    val routineId: String,
    val routine: String,
    val position: Int,
    val plannedKg: Double,
    val liftedKg: Double,
) {
    fun sentence(movement: String): String =
        "Today’s $movement ran at ${Readout.weight(liftedKg)} against a planned " +
            "${Readout.weight(plannedKg)}. Today’s session already has it. $routine does not."

    val saveLabel: String get() = "Save ${Readout.weight(liftedKg)} to $routine"

    companion object {
        // The heaviest WORKING set of the movement being left, against the weight the frozen snapshot
        // named for it. Warmups, drops and failures are not what the session was, so none of them can
        // raise this.
        //
        // WHICH LINE, when the plan holds the movement twice: the HEAVIEST planned one — the top set.
        // A lifted weight that beat only the back-off is not a deviation from the program. The
        // offer carries that line's routine POSITION (the snapshot is written from the routine's rows
        // in position order, so plan index i is routine position i + 1) and the save addresses that
        // one row, not every row naming the movement.
        fun leaving(exerciseId: String, session: Session?, sets: List<TrainingSet>,
                    asked: Set<String>): DeviationOffer? {
            if (session == null) return null
            val routineId = session.routineId ?: return null
            val plan = session.plan ?: return null
            if (exerciseId in asked) return null
            val planIndex = plan.entries.withIndex()
                .filter { it.value.exerciseId == exerciseId && it.value.weightKg != null }
                .maxByOrNull { it.value.weightKg!! }?.index ?: return null
            val planned = plan.entries[planIndex].weightKg!!
            val lifted = sets
                .filter { it.exerciseId == exerciseId && it.kind == SetKind.Working }
                .maxOfOrNull { it.weightKg } ?: return null
            if (lifted <= planned) return null

            return DeviationOffer(exerciseId = exerciseId, routineId = routineId,
                                  routine = plan.routine, position = planIndex + 1,
                                  plannedKg = planned, liftedKg = lifted)
        }
    }
}
