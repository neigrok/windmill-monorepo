package works.windmill.gym.store

import kotlin.math.floor
import works.windmill.gym.domain.*

internal object EngineReadouts {
    private fun estimate(set: TrainingSet): Double? = if (set.weightKg > 0) floor(set.weightKg * (1 + set.reps / 30.0) * 10 + .5) / 10 else null
    private fun working(detail: SessionDetail) = detail.sets.filter { it.kind == SetKind.Working }.sortedWith(compareBy({ it.completedAtMs }, { it.id }))
    private fun prior(detail: SessionDetail, history: List<SessionDetail>) = history.filter {
        !it.session.isOpen && it.session.startedAtMs < detail.session.startedAtMs
    }.sortedWith(compareBy({ it.session.startedAtMs }, { it.session.id }))
    private fun marks(history: List<SessionDetail>): List<Pair<TrainingSet, Long>> = history.flatMap { detail -> working(detail).map { it to it.completedAtMs } }
        .groupBy { it.first.exerciseId to it.first.weightKg }.values.map { values ->
            values.sortedWith(compareByDescending<Pair<TrainingSet, Long>> { it.first.reps }.thenBy { it.second }).first()
        }
    private fun earned(detail: SessionDetail, history: List<SessionDetail>): PersonalRecord? {
        data class Candidate(val rank: Int, val record: PersonalRecord, val set: TrainingSet)
        val before = marks(prior(detail, history))
        val candidates = mutableListOf<Candidate>()
        for ((exercise, sets) in working(detail).groupBy { it.exerciseId }) {
            val earlier = before.filter { it.first.exerciseId == exercise }
            val best = sets.filter { estimate(it) != null }.maxByOrNull { estimate(it)!! }
            val priorBest = earlier.filter { estimate(it.first) != null }.maxByOrNull { estimate(it.first)!! }
            if (best != null && priorBest != null && estimate(best)!! > estimate(priorBest.first)!!) candidates += Candidate(0,
                PersonalRecord("e1rm", exercise, estimate(best)!!, best.weightKg, best.reps, estimate(priorBest.first), priorBest.second), best)
            val heavy = sets.sortedWith(compareByDescending<TrainingSet> { it.weightKg }.thenByDescending { it.reps }
                .thenBy { it.completedAtMs }.thenBy { it.id }).first()
            val priorHeavy = earlier.maxWithOrNull(compareBy({ it.first.weightKg }, { it.first.reps }))
            if (priorHeavy != null && heavy.weightKg > priorHeavy.first.weightKg) candidates += Candidate(1,
                PersonalRecord("heaviest", exercise, heavy.weightKg, heavy.weightKg, heavy.reps, priorHeavy.first.weightKg, priorHeavy.second), heavy)
            for (set in sets.groupBy { it.weightKg }.values.map { it.maxBy { set -> set.reps } }) {
                val priorLoad = earlier.firstOrNull { it.first.weightKg == set.weightKg } ?: continue
                if (set.reps > priorLoad.first.reps) candidates += Candidate(2,
                    PersonalRecord("reps-at-weight", exercise, set.reps.toDouble(), set.weightKg, set.reps, priorLoad.first.reps.toDouble(), priorLoad.second), set)
            }
        }
        return candidates.sortedWith(compareBy<Candidate> { it.rank }.thenByDescending { estimate(it.set) ?: 0.0 }
            .thenByDescending { it.set.weightKg }.thenBy { it.set.completedAtMs }).firstOrNull()?.record
    }
    private fun effort(sets: List<TrainingSet>): Effort? {
        val top = sets.maxWithOrNull(compareBy({ it.weightKg }, { it.reps })) ?: return null
        return Effort(sets.count { it.weightKg == top.weightKg }, top.reps, top.weightKg)
    }
    fun review(detail: SessionDetail, history: List<SessionDetail>): Review {
        val working = working(detail)
        val base = Review.of(detail).copy(stats = Review.of(detail).stats.copy(topE1rm = working.mapNotNull(::estimate).maxOrNull()))
        if (base.slight) return base
        val previous = detail.session.routineId?.let { id -> prior(detail, history).lastOrNull { it.session.routineId == id } }
        val against = previous?.let { before -> Against(before.session.id, before.session.plan?.routine, before.session.startedAtMs,
            working.groupBy { it.exerciseId }.map { (id, sets) -> AgainstMovement(id, effort(sets)!!,
                effort(working(before).filter { it.exerciseId == id }), detail.session.plan?.entry(id)?.let { PlannedLine(it.sets) }) }) }
        return base.copy(record = earned(detail, history), against = against)
    }
    fun summary(detail: SessionDetail, history: List<SessionDetail>): SessionSummary {
        val sets = working(detail)
        return SessionSummary(detail.session, detail.sets).copy(topE1rm = sets.mapNotNull(::estimate).maxOrNull(),
            record = sets.size >= Review.slightWorkingSets && earned(detail, history) != null)
    }
    fun record(exercise: Exercise, history: List<SessionDetail>, routines: List<Routine>, now: Long): MovementRecord {
        val base = MovementRecord.of(exercise, history, routines.sortedWith(compareBy<Routine> { it.position }.thenBy { it.id }))
        val days = history.filter { !it.session.isOpen }.sortedWith(compareBy({ it.session.startedAtMs }, { it.session.id }))
        val points = days.mapNotNull { detail -> working(detail).filter { it.exerciseId == exercise.id && estimate(it) != null }
            .maxByOrNull { estimate(it)!! }?.let { RecordMark(it.weightKg, it.reps, detail.session.startedAtMs, estimate(it)) } }
        val records = mutableListOf<RecordMark>()
        var best: RecordMark? = null
        for (point in points) {
            if (best != null && point.e1rm!! <= best.e1rm!!) continue
            if (best != null) records += point
            best = point
        }
        val heaviest = days.flatMap { detail -> working(detail).filter { it.exerciseId == exercise.id }
            .map { RecordMark(it.weightKg, it.reps, detail.session.startedAtMs, estimate(it)) } }
            .sortedWith(compareByDescending<RecordMark> { it.weightKg }.thenByDescending { it.reps }.thenBy { it.atMs }).firstOrNull()
        return base.copy(bestE1rm = best, heaviest = heaviest, e1rmSeries = points.filter { it.atMs >= now - 12L * 7 * 24 * 60 * 60 * 1000 }, records = records.reversed())
    }
}
