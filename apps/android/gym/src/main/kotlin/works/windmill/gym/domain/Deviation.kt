package works.windmill.gym.domain

// Raised once per movement per session at the exercise boundary, only when lifted beats planned.

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
        // Plan index i is routine position i+1; the heaviest planned line wins.
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
