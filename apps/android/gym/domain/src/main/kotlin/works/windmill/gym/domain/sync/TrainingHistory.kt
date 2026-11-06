package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.compareBytes

// The log, the program and their documents as Coach's reads compose them: the session summaries, the statistics, a workout's review, and each routine's last workout and waiting proposal.
class TrainingHistory(private val read: Reader) {
    val log = TrainingLog(read)
    private val catalogue = log.catalogue
    internal val routineValues = read.repository(Routine).all(ViewMode.drawn).filter { it.entries.isNotEmpty() }
    internal val proposalValues = read.repository(Proposal).all(ViewMode.drawn).sortedWith { a, b ->
        val dates = (read.repository(Proposal).record(b.id, ViewMode.drawn)?.rc ?: 0).compareTo(read.repository(Proposal).record(a.id, ViewMode.drawn)?.rc ?: 0)
        if (dates == 0) b.id.compareTo(a.id) else dates
    }
    private val finished get() = log.drawnSessions.filter { !it.isOpen }

    private fun tonnage(sets: List<TrainingSet>): Double? = GymVolume.of(sets, catalogue)

    fun summary(value: Session): Json {
        val sets = log.sets(value.id)
        val result = sessionDocument(value).obj().toMutableMap()
        result.putAll(mapOf("setCount" to Json.of(sets.size), "workingSetCount" to Json.of(sets.size), "tonnageKg" to (tonnage(sets)?.let(Json::of) ?: Json.Null),
            "exercises" to Json.Arr(sets.mapNotNull { catalogue.find(it.exerciseId)?.name }.distinct().sortedWith(::compareBytes).map(Json::of)),
            "record" to Json.of(sets.size >= SessionReview.slightSets && PersonalRecord.of(value, log) != null), "closedItself" to Json.of(if (value.closedBy != null) value.closedBy == "stale" else value.finishedAt == SessionRules.lastActivity(value, sets))))
        topSet(sets)?.let { result["topSet"] = Json.objectOf("weightKg" to Json.of(it.weightKg), "reps" to Json.of(it.reps)) }
        result["topE1rm"] = log.topE1rm(value.id)?.let(Json::of) ?: Json.Null
        return Json.Obj(result.toList())
    }

    internal fun point(value: MovementProgress.Point, estimate: Boolean): Json {
        val fact = if (estimate) value.fact.estimate!!.performed else value.fact.heaviest
        return Json.Obj(buildList {
            add("at" to Json.of(value.startedAt.ms)); add("weightKg" to Json.of(fact.weightKg)); add("reps" to Json.of(fact.reps))
            val e1rm = if (estimate) value.fact.estimate!!.e1rm else GymEstimate.value(fact.weightKg, fact.reps, fact.rpe)
            e1rm?.let { add("e1rm" to Json.of(it)) }
        })
    }

    fun stats(): Json {
        fun week(at: Instant): Long { val day = LocalDay.from(at, FixedZone(0)); return LocalDay.parse("1970-01-01")!!.daysUntil(day.adding(1L - day.weekday)) * 86_400_000 }
        val weeks = mutableListOf<Json>()
        if (finished.isNotEmpty()) {
            var start = week(finished.last().startedAt)
            val end = week(finished.first().startedAt)
            val byWeek = finished.groupBy { week(it.startedAt) }
            while (start <= end) { val held = byWeek[start].orEmpty(); weeks += Json.objectOf("startedAt" to Json.of(start), "sessions" to Json.of(held.size), "workingSets" to Json.of(held.sumOf { log.sets(it.id).size })); start += 604_800_000 }
        }
        val progress = log.progress
        val movements = progress.sessions.flatMap { it.movements }.map { it.exerciseId }.distinct().map { id ->
            val series = progress.movement(id)
            Json.Obj(buildList { add("exerciseId" to id.json); add("lastTrainedAt" to Json.of(series.sessions.last().startedAt.ms)); add("points" to Json.Arr(series.sessions.map { point(it, false) })); series.best?.let { add("bestE1rm" to point(it, true)) }; series.heaviest?.let { add("heaviest" to point(it, false)) } })
        }.sortedWith { a, b -> b.member("lastTrainedAt").num().compareTo(a.member("lastTrainedAt").num()).takeIf { it != 0 } ?: compareBytes(a.member("exerciseId").str(), b.member("exerciseId").str()) }
        return Json.objectOf("weeks" to Json.Arr(weeks), "movements" to Json.Arr(movements))
    }

    fun lastTrainedAt(routine: Id<Routine>): Instant? = log.drawnSessions.firstOrNull { it.routineId == routine }?.startedAt

    fun pendingProposal(routine: Id<Routine>): Proposal? = proposalValues.firstOrNull { it.routineId == routine && it.state == "pending" }

    // The routines that hold a movement, the most recently trained first, then by their position and id.
    val program: List<Routine> get() = routineValues.sortedWith { a, b ->
        val dates = (lastTrainedAt(b.id)?.ms ?: -1).compareTo(lastTrainedAt(a.id)?.ms ?: -1)
        if (dates != 0) dates else a.position.compareTo(b.position).takeIf { it != 0 } ?: a.id.compareTo(b.id)
    }

    fun review(id: Id<Session>): Json = SessionReview.of(id, log)?.json ?: Json.Null

    // The documents a movement, a workout and a set read as, on every read that prints one. A set's number stands only once the log confirmed it (Coach INV-3).
    companion object {
        fun exerciseDocument(value: Exercise): Json = Json.Obj((value.fields() + mapOf("id" to value.id.json,
            "custom" to Json.of(SeedExercises.all.none { it.id == value.id })) +
            (if (value.equipment == "dumbbell") mapOf("loadCount" to Json.of(value.loadCount)) else emptyMap()) +
            if (value.aliases.isEmpty()) emptyMap() else mapOf("aliases" to Json.Arr(value.aliases.map(Json::of)))).toList())

        fun sessionDocument(value: Session): Json = Json.Obj(buildList {
            add("id" to value.id.json); add("startedAt" to Json.of(value.startedAt.ms))
            value.finishedAt?.let { add("finishedAt" to Json.of(it.ms)) }
            value.routineId?.let { add("routineId" to it.json) }; value.plan?.let { add("plan" to it.json) }
            value.displayName?.let { add("routineName" to Json.of(it)) }
        })

        fun setDocument(value: TrainingSet): Json = Json.Obj(buildList {
            add("id" to value.id.json); add("exerciseId" to value.exerciseId.json)
            value.setNumber?.let { add("setNumber" to Json.of(it)) }
            add("weightKg" to Json.of(value.weightKg)); add("reps" to Json.of(value.reps))
            add("note" to Json.of(value.note)); add("completedAt" to Json.of(value.completedAt.ms))
            value.rpe?.let { add("rpe" to Json.of(it)) }
        })
    }
}
