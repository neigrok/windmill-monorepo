package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.compareBytes

class TrainingHistory(private val read: Reader) {
    val log = TrainingLog(read)
    private val catalogue = Catalogue(read)
    private val routineValues = read.repository(Routine).all(ViewMode.drawn).filter { it.entries.isNotEmpty() }
    private val proposalValues = read.repository(Proposal).all(ViewMode.drawn).sortedWith { a, b ->
        val dates = (read.repository(Proposal).record(b.id, ViewMode.drawn)?.rc ?: 0).compareTo(read.repository(Proposal).record(a.id, ViewMode.drawn)?.rc ?: 0)
        if (dates == 0) b.id.compareTo(a.id) else dates
    }
    private val finished get() = log.drawnSessions.filter { !it.isOpen }

    private fun exerciseDocument(value: Exercise): Json = Json.Obj((value.fields() + mapOf("id" to value.id.json,
        "custom" to Json.of(SeedExercises.all.none { it.id == value.id })) +
        if (value.aliases.isEmpty()) emptyMap() else mapOf("aliases" to Json.Arr(value.aliases.map(Json::of)))).toList())

    fun exercises(): Json = Json.Arr(catalogue.exercises.sortedWith { a, b ->
        compareBytes(a.pattern, b.pattern).takeIf { it != 0 } ?: compareBytes(a.name, b.name).takeIf { it != 0 } ?: a.id.compareTo(b.id)
    }.map(::exerciseDocument))

    private fun sessionDocument(value: Session): Json = Json.Obj(buildList {
        add("id" to value.id.json); add("startedAt" to Json.of(value.startedAt.ms))
        value.finishedAt?.let { add("finishedAt" to Json.of(it.ms)) }
        value.routineId?.let { add("routineId" to it.json) }; value.plan?.let { add("plan" to it.json) }
        value.displayName?.let { add("routineName" to Json.of(it)) }
    })

    private fun setDocument(value: TrainingSet): Json = Json.Obj(buildList {
        add("id" to value.id.json); add("exerciseId" to value.exerciseId.json)
        value.setNumber?.let { add("setNumber" to Json.of(it)) }
        add("weightKg" to Json.of(value.weightKg)); add("reps" to Json.of(value.reps)); add("kind" to Json.of(value.kind))
        add("note" to Json.of(value.note)); add("completedAt" to Json.of(value.completedAt.ms))
        value.rpe?.let { add("rpe" to Json.of(it)) }
    })

    fun session(id: Id<Session>): Json = log.drawnSessions.firstOrNull { it.id == id }?.let {
        Json.objectOf("session" to sessionDocument(it), "sets" to Json.Arr(log.sets(id).map(::setDocument)))
    } ?: Json.Null

    private fun top(sets: List<TrainingSet>): TrainingSet? = sets.sortedWith(compareByDescending<TrainingSet> { it.weightKg }.thenByDescending { it.reps }.thenBy { it.id }).firstOrNull()

    private fun tonnage(sets: List<TrainingSet>): Double = sets.filter { it.kind == "working" }.sumOf { maxOf(0.0, works.windmill.sync.core.Quantum.halfAway(it.weightKg * 100)) * it.reps } / 100

    private fun summary(value: Session): Json {
        val sets = log.sets(value.id)
        val worked = sets.filter { it.kind == "working" }
        val result = sessionDocument(value).obj().toMutableMap()
        result.putAll(mapOf("setCount" to Json.of(sets.size), "workingSetCount" to Json.of(worked.size), "tonnageKg" to Json.of(tonnage(sets)),
            "exercises" to Json.Arr(sets.mapNotNull { catalogue.find(it.exerciseId)?.name }.distinct().sortedWith(::compareBytes).map(Json::of)),
            "record" to Json.of(worked.size >= 4 && recordFor(value) != null), "closedItself" to Json.of(if (value.closedBy != null) value.closedBy == "stale" else value.finishedAt == SessionRules.lastActivity(value, sets))))
        top(worked)?.let { result["topSet"] = Json.objectOf("weightKg" to Json.of(it.weightKg), "reps" to Json.of(it.reps)) }
        log.topE1rm(value.id)?.let { result["topE1rm"] = Json.of(it) }
        return Json.Obj(result.toList())
    }

    fun sessions(query: Json = Json.objectOf()): Json {
        val f = Fields(query)
        val before = f.optionalInstant("before")?.ms ?: SessionRules.maxInstantMs
        val beforeId = f.optionalString("beforeId") ?: ""
        val limit = f.optionalInt("limit")?.takeIf { it > 0 }?.coerceAtMost(200) ?: 50
        return Json.Arr(log.drawnSessions.filter { it.startedAt.ms < before || (it.startedAt.ms == before && compareBytes(it.id.record.string ?: "", beforeId) > 0) }.take(limit).map(::summary))
    }

    fun lastTime(id: Id<Exercise>): Json {
        val last = log.lastTime(id)
        return Json.Obj(buildList {
            add("exerciseId" to id.json)
            last.session?.let { add("session" to sessionDocument(it)); add("sets" to Json.Arr(last.sets.sortedWith(compareBy<TrainingSet> { it.setNumber ?: 0 }.thenBy { it.id }).map(::setDocument))) }
            last.routine?.let { add("routine" to Json.of(it)) }
        })
    }

    fun lastSets(): Json = Json.Arr(finished.flatMap { log.sets(it.id) }.filter { it.kind != "warmup" }.map { it.exerciseId }.distinct().sorted().mapNotNull { id ->
        val last = log.lastTime(id)
        last.sets.sortedWith(compareBy<TrainingSet> { it.setNumber ?: 0 }.thenBy { it.id }).lastOrNull()?.let { Json.objectOf("exerciseId" to id.json, "weightKg" to Json.of(it.weightKg), "reps" to Json.of(it.reps), "at" to Json.of(last.session!!.startedAt.ms)) }
    })

    fun progress(): Json = log.progress.json

    private fun point(value: MovementProgress.Point, estimate: Boolean): Json {
        val fact = if (estimate) value.fact.estimate!!.performed else value.fact.heaviest
        return Json.Obj(buildList {
            add("at" to Json.of(value.startedAt.ms)); add("weightKg" to Json.of(fact.weightKg)); add("reps" to Json.of(fact.reps))
            val e1rm = if (estimate) value.fact.estimate!!.e1rm else GymEstimate.value(fact.weightKg, fact.reps, rpe = fact.rpe)
            e1rm?.let { add("e1rm" to Json.of(it)) }
        })
    }

    fun record(id: Id<Exercise>): Json {
        val exercise = catalogue.find(id) ?: return Json.Null
        val series = log.progress.movement(id)
        val routines = routineValues.filter { it.entries.any { entry -> entry.exerciseId == id } }.sortedWith(compareBy({ it.position }, { it.id }))
        return Json.Obj(buildList {
            add("exercise" to exerciseDocument(exercise)); add("sessionCount" to Json.of(series.sessions.size)); add("routineCount" to Json.of(routines.size))
            if (routines.isNotEmpty()) add("routines" to Json.Arr(routines.map { Json.of(it.name) }))
            series.best?.let { add("bestE1rm" to point(it, true)) }; series.heaviest?.let { add("heaviest" to point(it, false)) }
            val window = series.window(read.moment.now, read.moment.zone).estimates
            if (window.isNotEmpty()) add("e1rmSeries" to Json.Arr(window.map { point(it, true) }))
            if (series.records.isNotEmpty()) add("records" to Json.Arr(series.records.reversed().map { point(it, true) }))
            val recent = finished.filter { log.sets(it.id).any { set -> set.exerciseId == id && set.kind != "warmup" } }.take(10)
            if (recent.isNotEmpty()) add("recentDays" to Json.Arr(recent.map { session ->
                Json.objectOf("sessionId" to session.id.json, "startedAt" to Json.of(session.startedAt.ms), "sets" to Json.Arr(log.sets(session.id).filter { it.exerciseId == id && it.kind != "warmup" }.sortedWith(compareBy<TrainingSet> { it.setNumber ?: 0 }.thenBy { it.id }).map(::setDocument)))
            }))
        })
    }

    private fun historyWorkout(value: Session): Json {
        val sets = log.sets(value.id)
        val worked = sets.filter { it.kind == "working" }
        return Json.Obj(buildList {
            add("id" to value.id.json); add("startedAt" to Json.of(value.startedAt.ms)); value.finishedAt?.let { add("finishedAt" to Json.of(it.ms)) }
            value.historyRoutineId?.let { add("routineId" to it.json) }; add("routineName" to Json.of(value.name ?: ""))
            add("setCount" to Json.of(sets.size)); add("workingSetCount" to Json.of(worked.size)); add("reps" to Json.of(worked.sumOf { it.reps })); add("tonnageKg" to Json.of(tonnage(worked)))
            add("sets" to Json.Arr(sets.map { set -> Json.Obj((setDocument(set).obj() - setOf("kind", "note") + ("exercise" to Json.of(catalogue.find(set.exerciseId)?.name ?: ""))).toList()) }))
            add("movements" to Json.Arr(sets.map { it.exerciseId }.distinct().sorted().map { id ->
                val held = worked.filter { it.exerciseId == id }
                Json.objectOf("exerciseId" to id.json, "sets" to Json.of(held.size), "reps" to Json.of(held.sumOf { it.reps }), "tonnageKg" to Json.of(tonnage(held)))
            }))
            add("exerciseNames" to Json.Arr(sets.map { catalogue.find(it.exerciseId)?.name ?: "" }.distinct().sortedWith(::compareBytes).map(Json::of)))
        })
    }

    fun history(query: Json = Json.objectOf()): Json {
        val f = Fields(query)
        val from = f.optionalInstant("from")?.ms ?: 0
        val until = f.optionalInstant("until")?.ms ?: SessionRules.maxInstantMs
        val before = f.optionalInstant("before")?.ms ?: SessionRules.maxInstantMs
        val beforeId = f.optionalString("beforeId") ?: ""
        val limit = f.optionalInt("limit")?.takeIf { it > 0 }?.coerceAtMost(200) ?: 50
        val exercise = f.optionalString("exercise").orEmpty()
        val routine = f.optionalString("routine").orEmpty()
        val scoped = finished.filter { it.startedAt.ms >= from && it.startedAt.ms < until &&
            (exercise.isEmpty() || log.sets(it.id).any { set -> set.exerciseId.record.string == exercise }) &&
            (routine.isEmpty() || it.historyRoutineId?.record?.string == routine) }
        val afterCursor = scoped.filter { it.startedAt.ms < before || (it.startedAt.ms == before && compareBytes(it.id.record.string ?: "", beforeId) > 0) }
        val page = afterCursor.take(limit)
        val months = scoped.groupingBy { LocalDay.from(it.startedAt, read.moment.zone).text.take(7) }.eachCount()
        val allSets = scoped.flatMap { log.sets(it.id) }
        val worked = allSets.filter { it.kind == "working" }
        val exercises = allSets.map { it.exerciseId }.distinct().map { id ->
            val known = catalogue.find(id)
            Json.Obj(buildList { add("id" to id.json); add("name" to Json.of(known?.name ?: "")); add("sessions" to Json.of(scoped.count { log.sets(it.id).any { set -> set.exerciseId == id } })); known?.let { add("equipment" to Json.of(it.equipment)) } })
        }
        val routines = scoped.mapNotNull { it.historyRoutineId }.distinct().map { id ->
            val held = scoped.filter { it.historyRoutineId == id }
            Json.objectOf("id" to id.json, "name" to Json.of(held.first().name ?: ""), "sessions" to Json.of(held.size))
        }
        val facetOrder = Comparator<Json> { a, b -> compareBytes(a.member("name").str(), b.member("name").str()).takeIf { it != 0 } ?: compareBytes(a.member("id").str(), b.member("id").str()) }
        return Json.Obj(buildList {
            add("sessions" to Json.Arr(page.map(::historyWorkout))); add("summary" to Json.objectOf("sessions" to Json.of(scoped.size), "sets" to Json.of(worked.size), "reps" to Json.of(worked.sumOf { it.reps }), "tonnageKg" to Json.of(tonnage(worked))))
            add("months" to Json.Arr(months.keys.sortedDescending().map { Json.objectOf("month" to Json.of(it), "sessions" to Json.of(months.getValue(it))) }))
            add("exercises" to Json.Arr(exercises.sortedWith(facetOrder))); add("routines" to Json.Arr(routines.sortedWith(facetOrder)))
            add("next" to if (afterCursor.size > limit && page.isNotEmpty()) Json.objectOf("before" to Json.of(page.last().startedAt.ms), "beforeId" to page.last().id.json) else Json.Null)
            if (f.optionalString("projection") == "progress") add("progress" to StatsProgress(TrainingLog(scoped, allSets, read.moment, log.firstPullComplete)).json)
        })
    }

    fun stats(): Json {
        fun week(at: Instant): Long { val day = LocalDay.from(at, FixedZone(0)); return LocalDay.parse("1970-01-01")!!.daysUntil(day.adding(1L - day.weekday)) * 86_400_000 }
        val weeks = mutableListOf<Json>()
        if (finished.isNotEmpty()) {
            var start = week(finished.last().startedAt)
            val end = week(finished.first().startedAt)
            while (start <= end) { val held = finished.filter { week(it.startedAt) == start }; weeks += Json.objectOf("startedAt" to Json.of(start), "sessions" to Json.of(held.size), "workingSets" to Json.of(held.sumOf { log.sets(it.id).count { set -> set.kind == "working" } })); start += 604_800_000 }
        }
        val movements = log.progress.sessions.flatMap { it.movements }.map { it.exerciseId }.distinct().map { id ->
            val series = log.progress.movement(id)
            Json.Obj(buildList { add("exerciseId" to id.json); add("lastTrainedAt" to Json.of(series.sessions.last().startedAt.ms)); add("points" to Json.Arr(series.sessions.map { point(it, false) })); series.best?.let { add("bestE1rm" to point(it, true)) }; series.heaviest?.let { add("heaviest" to point(it, false)) } })
        }.sortedWith { a, b -> b.member("lastTrainedAt").num().compareTo(a.member("lastTrainedAt").num()).takeIf { it != 0 } ?: compareBytes(a.member("exerciseId").str(), b.member("exerciseId").str()) }
        return Json.objectOf("weeks" to Json.Arr(weeks), "movements" to Json.Arr(movements))
    }

    private fun proposalHead(value: Proposal): Json = Json.Obj(buildList {
        add("id" to value.id.json); add("routineId" to value.routineId.json); add("intent" to Json.of(value.intent)); add("state" to Json.of(value.state)); add("summary" to Json.of(value.summary))
        read.repository(Proposal).record(value.id, ViewMode.drawn)?.rc?.let { add("createdAt" to Json.of(it)) }
        value.changeCount?.let { add("changeCount" to Json.of(it)) }; value.settledAt?.let { add("settledAt" to Json.of(it.ms)) }
        add("source" to Json.Obj(buildList { add("door" to Json.of(value.door)); if (value.connection.isNotEmpty()) add("connection" to Json.of(value.connection)); if (value.agent.isNotEmpty()) add("agent" to Json.of(value.agent)); value.threadId?.let { add("thread" to Json.of(it)) } }))
    })

    fun proposals(query: Json = Json.objectOf()): Json {
        val f = Fields(query)
        return Json.Arr(proposalValues.filter { (f.optionalString("routineId") == null || it.routineId.record.string == f.optionalString("routineId")) && (f.optionalString("state") != "pending" || it.state == "pending") }.map(::proposalHead))
    }

    fun proposal(id: Id<Proposal>): Json {
        val value = proposalValues.firstOrNull { it.id == id } ?: return Json.Null
        val result = proposalHead(value).obj().toMutableMap()
        result["name"] = Json.of(value.proposedName)
        result["changes"] = Json.Arr(value.changes.mapIndexed { index, change -> Json.Obj(buildList {
            addAll(change.json.obj().toList()); add("position" to Json.of(index + 1)); if (change.kind == "removed") add("loggedSets" to Json.of(log.drawnSessions.sumOf { session -> log.sets(session.id).count { it.exerciseId == change.exerciseId } }))
        }) })
        value.baseName?.let { result["baseName"] = Json.of(it) }; value.baseRevision?.let { result["baseRevision"] = Json.of(it) }
        return Json.Obj(result.toList())
    }

    private fun routineDocument(value: Routine): Json = Json.Obj(buildList {
        add("id" to value.id.json); add("name" to Json.of(value.name)); add("position" to Json.of(value.position))
        add("entries" to Json.Arr(value.entries.mapIndexed { index, entry -> Json.Obj(entry.json.obj().toList() + ("position" to Json.of(index + 1))) }))
        value.revision?.let { add("revision" to Json.of(it)) }
        log.drawnSessions.firstOrNull { it.routineId == value.id }?.let { add("lastTrainedAt" to Json.of(it.startedAt.ms)) }
        proposalValues.firstOrNull { it.routineId == value.id && it.state == "pending" }?.let { add("pendingProposal" to proposalHead(it)) }
    })

    fun routines(): Json = Json.Arr(routineValues.sortedWith { a, b ->
        val dates = (log.drawnSessions.firstOrNull { it.routineId == b.id }?.startedAt?.ms ?: -1).compareTo(log.drawnSessions.firstOrNull { it.routineId == a.id }?.startedAt?.ms ?: -1)
        if (dates != 0) dates else a.position.compareTo(b.position).takeIf { it != 0 } ?: a.id.compareTo(b.id)
    }.map(::routineDocument))

    fun routine(id: Id<Routine>): Json {
        val value = routineValues.firstOrNull { it.id == id } ?: return Json.Null
        val history = proposalValues.filter { it.routineId == id }.take(20).map { proposal -> Json.Obj(buildList {
            add("kind" to Json.of("proposal")); read.repository(Proposal).record(proposal.id, ViewMode.drawn)?.rc?.let { add("at" to Json.of(it)) }; add("proposal" to proposalHead(proposal))
        }) } + Json.Obj(buildList {
            add("kind" to Json.of("created")); read.repository(Routine).record(id, ViewMode.drawn)?.rc?.let { add("at" to Json.of(it)) }
            value.createdDoor?.let { add("by" to Json.of(it)) }; value.createdEntries?.let { add("movements" to Json.of(it)) }
        })
        return Json.Obj(routineDocument(value).obj().toList() + ("history" to Json.Arr(history)))
    }

    fun preferences(): Json {
        val value = read.repository(Preferences).find(Id("prefs", Preferences), ViewMode.drawn) ?: Preferences()
        val rest = restSettings(read)
        return Json.Obj(value.fields().toList() + listOf("restSeconds" to (rest.seconds?.let(Json::of) ?: Json.Null), "restSound" to Json.of(rest.sound)))
    }

    fun notes(): Json {
        val stored = read.repository(Note).all(ViewMode.stored)
        return Json.Arr(read.repository(Note).all(ViewMode.drawn).map { note -> Json.Obj(buildList {
            add("id" to note.id.json); add("title" to Json.of(note.title)); add("body" to Json.of(note.body)); add("position" to Json.of(stored.indexOfFirst { it.id == note.id }))
            note.updatedAt?.let { add("updatedAt" to Json.of(it.ms)) }
        }) })
    }

    fun bodyweight(): Json {
        val values = read.repository(WeighIn).all(ViewMode.drawn)
        val entries = Bodyweight(read).entries.map { entry -> Json.Obj(buildList {
            add("dateLocal" to Json.of(entry.day.text)); add("weightKg" to Json.of(entry.kg)); values.firstOrNull { it.day == entry.day }?.recordedAt?.let { add("recordedAt" to Json.of(it.ms)) }
        }) }
        return Json.Obj(buildList { add("entries" to Json.Arr(entries)); entries.lastOrNull()?.let { add("latest" to it) } })
    }

    private fun recordFor(value: Session): Json? {
        if (!log.firstPullComplete) return null
        val previous = finished.filter { it.startedAt < value.startedAt || (it.startedAt == value.startedAt && it.id < value.id) }
        val prior = StatsProgress(TrainingLog(previous, log.sets, read.moment))
        val current = StatsProgress(TrainingLog(listOf(value), log.sets, read.moment))
        data class Candidate(val rank: Int, val kind: String, val exercise: Id<Exercise>, val fact: PerformedFact, val amount: Double, val before: Double, val beforeAt: Instant) {
            val estimate get() = GymEstimate.value(fact.weightKg, fact.reps, rpe = fact.rpe) ?: 0.0
        }
        val candidates = mutableListOf<Candidate>()
        for (fact in current.sessions.flatMap { it.movements }) {
            val now = fact.estimate
            val before = prior.movement(fact.exerciseId).best
            if (now != null && before != null && now.e1rm > before.fact.estimate!!.e1rm)
                candidates += Candidate(0, "e1rm", fact.exerciseId, now.performed, now.e1rm, before.fact.estimate!!.e1rm, before.startedAt)
            val today = log.sets(value.id).filter { it.exerciseId == fact.exerciseId && it.kind == "working" }
            val priors = previous.flatMap { session -> log.sets(session.id).filter { it.exerciseId == fact.exerciseId && it.kind == "working" }.map { it to session } }
            val heavy = priors.sortedWith(compareByDescending<Pair<TrainingSet, Session>> { it.first.weightKg }.thenByDescending { it.first.reps }.thenBy { it.second.startedAt }.thenBy { it.first.id }).firstOrNull()
            val todayTop = top(today)
            if (todayTop != null && heavy != null && todayTop.weightKg > heavy.first.weightKg)
                candidates += Candidate(1, "heaviest", fact.exerciseId, PerformedFact(todayTop), todayTop.weightKg, heavy.first.weightKg, heavy.second.startedAt)
            for (load in today.map { it.weightKg }.distinct()) {
                val atLoad = top(today.filter { it.weightKg == load })!!
                val earlier = priors.filter { it.first.weightKg == load }.sortedWith(compareByDescending<Pair<TrainingSet, Session>> { it.first.reps }.thenBy { it.second.startedAt }.thenBy { it.first.id }).firstOrNull()
                if (earlier != null && atLoad.reps > earlier.first.reps)
                    candidates += Candidate(2, "reps-at-weight", fact.exerciseId, PerformedFact(atLoad), atLoad.reps.toDouble(), earlier.first.reps.toDouble(), earlier.second.startedAt)
            }
        }
        val best = candidates.sortedWith(compareBy<Candidate> { it.rank }.thenByDescending { it.estimate }.thenByDescending { it.fact.weightKg }.thenBy { it.exercise }).firstOrNull() ?: return null
        return Json.objectOf("kind" to Json.of(best.kind), "exerciseId" to best.exercise.json, "value" to Json.of(best.amount), "weightKg" to Json.of(best.fact.weightKg),
            "reps" to Json.of(best.fact.reps), "previous" to Json.of(best.before), "previousAt" to Json.of(best.beforeAt.ms))
    }

    fun review(id: Id<Session>): Json {
        val value = log.drawnSessions.firstOrNull { it.id == id } ?: return Json.Null
        val facts = log.readout(id)!!
        val stats = Json.Obj(buildList { add("durationMs" to Json.of(facts.durationMs ?: maxOf(0, SessionRules.lastActivity(value, log.sets).ms - value.startedAt.ms))); add("workingSets" to Json.of(facts.workingSetCount)); facts.topE1rm?.let { add("topE1rm" to Json.of(it)) } })
        val result = mutableMapOf("stats" to stats, "slight" to Json.of(facts.workingSetCount < 4))
        if (facts.workingSetCount < 4) return Json.Obj(result.toList())
        recordFor(value)?.let { result["record"] = it }
        val previous = finished.firstOrNull { it.routineId == value.routineId && value.routineId != null && (it.startedAt < value.startedAt || (it.startedAt == value.startedAt && it.id < value.id)) }
        if (previous != null) {
            fun best(sets: List<TrainingSet>): Json? = top(sets)?.let { top -> Json.objectOf("weightKg" to Json.of(top.weightKg), "reps" to Json.of(top.reps), "sets" to Json.of(sets.count { it.weightKg == top.weightKg })) }
            val worked = log.sets(id).filter { it.kind == "working" }
            result["against"] = Json.Obj(buildList {
                add("sessionId" to previous.id.json); add("startedAt" to Json.of(previous.startedAt.ms)); previous.plan?.routine?.takeIf { it.isNotEmpty() }?.let { add("routine" to Json.of(it)) }
                add("movements" to Json.Arr(worked.map { it.exerciseId }.distinct().map { exercise -> Json.Obj(buildList {
                    add("exerciseId" to exercise.json); add("now" to (best(worked.filter { it.exerciseId == exercise }) ?: Json.Null))
                    best(log.sets(previous.id).filter { it.exerciseId == exercise && it.kind == "working" })?.let { add("before" to it) }
                    value.plan?.entries?.firstOrNull { it.exerciseId == exercise }?.let { add("planned" to Json.Obj(if (it.sets == null) emptyList() else listOf("sets" to Json.Arr(it.sets.map { target -> target.json })))) }
                }) }))
            })
        }
        return Json.Obj(result.toList())
    }
}
