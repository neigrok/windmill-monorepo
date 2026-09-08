package works.windmill.gym.domain

// Raised once per movement per session at the exercise boundary, only when lifted beats planned.

data class DeviationOffer(
    val exerciseId: String,
    val routineId: String,
    val routine: String,
    val position: Int,
    val plannedKg: Double,
    val liftedKg: Double,
    val scheme: List<SetTarget>,
    val lifted: List<SetTarget>,
) {
    // A scheme whose sets disagree is offered as the sets lifted, drawn as a ladder before and after.
    val ladder: Boolean get() = !Scheme.straight(scheme)

    // What Save writes to the line: on a straight scheme every set at the load lifted, reps kept; on
    // a ladder the sets as they were lifted today.
    val proposed: List<SetTarget>
        get() = if (ladder) lifted else scheme.map { it.copy(weightKg = Ladder.round(liftedKg)) }

    val saveLabel: String
        get() = if (ladder) TargetEntry.saveTodaysSets else "Save ${Readout.weight(liftedKg)} to $routine"

    fun sentence(movement: String): String =
        "Today’s $movement ran at ${Readout.weight(liftedKg)} against a planned " +
            "${Readout.weight(plannedKg)}. Today’s session already has it. $routine does not."

    companion object {
        // Plan index i is routine position i+1; the line holding the heaviest planned set wins.
        fun leaving(exerciseId: String, session: Session?, sets: List<TrainingSet>,
                    asked: Set<String>): DeviationOffer? {
            if (session == null) return null
            val routineId = session.routineId ?: return null
            val plan = session.plan ?: return null
            if (exerciseId in asked) return null
            val (planIndex, planned) = plan.entries.withIndex()
                .filter { it.value.exerciseId == exerciseId }
                .mapNotNull { (index, entry) -> entry.sets.mapNotNull { it.weightKg }.maxOrNull()?.let { index to it } }
                .maxByOrNull { it.second } ?: return null
            val working = sets.filter { it.exerciseId == exerciseId && it.kind == SetKind.Working }
            val lifted = working.maxOfOrNull { it.weightKg } ?: return null
            if (lifted <= planned) return null
            // A ladder is offered as the sets lifted, and a line holds twenty sets at most: past
            // that nothing could be saved, so nothing rises.
            val scheme = plan.entries[planIndex].sets
            if (!Scheme.straight(scheme) && working.size > Scheme.maxSets) return null

            return DeviationOffer(exerciseId = exerciseId, routineId = routineId,
                                  routine = plan.routine, position = planIndex + 1,
                                  plannedKg = planned, liftedKg = lifted,
                                  scheme = scheme, lifted = Scheme.lifted(working))
        }
    }
}
