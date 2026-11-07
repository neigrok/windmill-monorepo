package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.compareBytes
import works.windmill.sync.testing.Vector

// The mirror documents `training-reads.json` pins beyond what Coach reads: composed through the same entities and reads as `TrainingHistory`, so the shared vectors keep holding this surface to them.
internal class HistoryDocuments(private val read: Reader) {
    val history = TrainingHistory(read)
    private val log = history.log
    private val catalogue = log.catalogue
    private val routineValues = history.routineValues
    private val proposalValues = history.proposalValues
    private val drawnSessions = log.drawnSessions
    private val finished get() = drawnSessions.filter { !it.isOpen }

    private fun tonnage(sets: List<TrainingSet>): Double? = GymVolume.of(sets, catalogue)

    fun exercises(): Json = Json.Arr(catalogue.exercises.sortedWith { a, b ->
        compareBytes(a.pattern, b.pattern).takeIf { it != 0 } ?: compareBytes(a.name, b.name).takeIf { it != 0 } ?: a.id.compareTo(b.id)
    }.map(TrainingHistory::exerciseDocument))

    fun session(id: Id<Session>): Json = drawnSessions.firstOrNull { it.id == id }?.let {
        Json.objectOf("session" to TrainingHistory.sessionDocument(it), "sets" to Json.Arr(log.sets(id).map(TrainingHistory::setDocument)))
    } ?: Json.Null

    fun sessions(query: Json = Json.objectOf()): Json {
        val f = Fields(query)
        val before = f.optionalInstant("before")?.ms ?: SessionRules.maxInstantMs
        val beforeId = f.optionalString("beforeId") ?: ""
        val limit = f.optionalInt("limit")?.takeIf { it > 0 }?.coerceAtMost(200) ?: 50
        return Json.Arr(drawnSessions.filter { it.startedAt.ms < before || (it.startedAt.ms == before && compareBytes(it.id.record.string ?: "", beforeId) > 0) }.take(limit).map(history::summary))
    }

    fun lastTime(id: Id<Exercise>): Json {
        val last = log.lastTime(id)
        return Json.Obj(buildList {
            add("exerciseId" to id.json)
            last.session?.let { add("session" to TrainingHistory.sessionDocument(it)); add("sets" to Json.Arr(last.sets.map(TrainingHistory::setDocument))) }
            last.routine?.let { add("routine" to Json.of(it)) }
        })
    }

    fun lastSets(): Json = Json.Arr(LastSet.all(log).map {
        Json.objectOf("exerciseId" to it.exerciseId.json, "weightKg" to Json.of(it.weightKg), "reps" to Json.of(it.reps), "at" to Json.of(it.at.ms))
    })

    fun progress(): Json = log.progress.json

    fun record(id: Id<Exercise>): Json {
        val exercise = catalogue.find(id) ?: return Json.Null
        val series = log.progress.movement(id)
        val routines = routineValues.filter { it.entries.any { entry -> entry.exerciseId == id } }.sortedWith(compareBy({ it.position }, { it.id }))
        return Json.Obj(buildList {
            add("exercise" to TrainingHistory.exerciseDocument(exercise)); add("sessionCount" to Json.of(series.sessions.size)); add("routineCount" to Json.of(routines.size))
            if (routines.isNotEmpty()) add("routines" to Json.Arr(routines.map { Json.of(it.name) }))
            series.best?.let { add("bestE1rm" to history.point(it, true)) }; series.heaviest?.let { add("heaviest" to history.point(it, false)) }
            val window = series.window(read.moment.now, read.moment.zone).estimates
            if (window.isNotEmpty()) add("e1rmSeries" to Json.Arr(window.map { history.point(it, true) }))
            if (series.records.isNotEmpty()) add("records" to Json.Arr(series.records.reversed().map { history.point(it, true) }))
            val recent = log.recentDays(id)
            if (recent.isNotEmpty()) add("recentDays" to Json.Arr(recent.map { day ->
                Json.objectOf("sessionId" to day.session.id.json, "startedAt" to Json.of(day.session.startedAt.ms), "sets" to Json.Arr(day.sets.map(TrainingHistory::setDocument)))
            }))
        })
    }

    private fun historyWorkout(value: Session): Json {
        val sets = log.sets(value.id)
        return Json.Obj(buildList {
            add("id" to value.id.json); add("startedAt" to Json.of(value.startedAt.ms)); value.finishedAt?.let { add("finishedAt" to Json.of(it.ms)) }
            value.historyRoutineId?.let { add("routineId" to it.json) }; add("routineName" to Json.of(value.name ?: ""))
            add("setCount" to Json.of(sets.size)); add("workingSetCount" to Json.of(sets.size)); add("reps" to Json.of(sets.sumOf { it.reps })); add("tonnageKg" to (tonnage(sets)?.let(Json::of) ?: Json.Null))
            add("sets" to Json.Arr(sets.map { set -> Json.Obj((TrainingHistory.setDocument(set).obj() - "note" + ("exercise" to Json.of(catalogue.find(set.exerciseId)?.name ?: ""))).toList()) }))
            add("movements" to Json.Arr(sets.map { it.exerciseId }.distinct().sorted().map { id ->
                val held = sets.filter { it.exerciseId == id }
                Json.objectOf("exerciseId" to id.json, "sets" to Json.of(held.size), "reps" to Json.of(held.sumOf { it.reps }), "tonnageKg" to (tonnage(held)?.let(Json::of) ?: Json.Null))
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
            add("sessions" to Json.Arr(page.map(::historyWorkout))); add("summary" to Json.objectOf("sessions" to Json.of(scoped.size), "sets" to Json.of(allSets.size), "reps" to Json.of(allSets.sumOf { it.reps }), "tonnageKg" to (tonnage(allSets)?.let(Json::of) ?: Json.Null)))
            add("months" to Json.Arr(months.keys.sortedDescending().map { Json.objectOf("month" to Json.of(it), "sessions" to Json.of(months.getValue(it))) }))
            add("exercises" to Json.Arr(exercises.sortedWith(facetOrder))); add("routines" to Json.Arr(routines.sortedWith(facetOrder)))
            add("next" to if (afterCursor.size > limit && page.isNotEmpty()) Json.objectOf("before" to Json.of(page.last().startedAt.ms), "beforeId" to page.last().id.json) else Json.Null)
            if (f.optionalString("projection") == "progress") add("progress" to StatsProgress(log.copy(sessions = scoped, sets = allSets)).json)
        })
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
            addAll(change.json.obj().toList()); add("position" to Json.of(index + 1)); if (change.kind == "removed") add("loggedSets" to Json.of(drawnSessions.sumOf { session -> log.sets(session.id).count { it.exerciseId == change.exerciseId } }))
        }) })
        value.baseName?.let { result["baseName"] = Json.of(it) }; value.baseRevision?.let { result["baseRevision"] = Json.of(it) }
        return Json.Obj(result.toList())
    }

    private fun routineDocument(value: Routine): Json = Json.Obj(buildList {
        add("id" to value.id.json); add("name" to Json.of(value.name)); add("position" to Json.of(value.position))
        add("entries" to Json.Arr(value.entries.mapIndexed { index, entry -> Json.Obj(entry.json.obj().toList() + ("position" to Json.of(index + 1))) }))
        value.revision?.let { add("revision" to Json.of(it)) }
        history.lastTrainedAt(value.id)?.let { add("lastTrainedAt" to Json.of(it.ms)) }
        history.pendingProposal(value.id)?.let { add("pendingProposal" to proposalHead(it)) }
    })

    fun routines(): Json = Json.Arr(history.program.map(::routineDocument))

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
}

fun trainingReadsForm(vector: Vector, read: Reader): Json {
    val f = Fields(vector.input.member("input"))
    val log = TrainingLog(read)
    return when (vector.input.member("read").str()) {
        "TrainingHistory" -> {
            val documents = HistoryDocuments(read)
            val args = vector.input.member("input").member("args").arr()
            val query = args.firstOrNull() ?: Json.objectOf()
            when (f.string("method")) {
                "exercises" -> documents.exercises()
                "preferences" -> documents.preferences()
                "notes" -> documents.notes()
                "bodyweight" -> documents.bodyweight()
                "routines" -> documents.routines()
                "routine" -> documents.routine(Id(query.str(), Routine))
                "proposals" -> documents.proposals(query)
                "proposal" -> documents.proposal(Id(query.str(), Proposal))
                "sessions" -> documents.sessions(query)
                "session" -> documents.session(Id(query.str(), Session))
                "review" -> documents.history.review(Id(query.str(), Session))
                "history" -> documents.history(query)
                "progress" -> documents.progress()
                "stats" -> documents.history.stats()
                "lastTime" -> documents.lastTime(Id(query.str(), Exercise))
                "lastSets" -> documents.lastSets()
                "record" -> documents.record(Id(query.str(), Exercise))
                else -> error("unclaimed training history")
            }
        }
        "GymEstimate" -> nullable(GymEstimate.value(f.double("weightKg"), f.int("reps"), f.optionalDouble("rpe")))
        "GymEstimateScore" -> {
            val left = Fields(f.json("left")!!); val right = Fields(f.json("right")!!)
            val a = GymEstimate.score(left.double("weightKg"), left.int("reps"), left.optionalDouble("rpe"))
            val b = GymEstimate.score(right.double("weightKg"), right.int("reps"), right.optionalDouble("rpe"))
            if (a == null || b == null) Json.Null else Json.of(a.compareTo(b).compareTo(0))
        }
        "GymVolume" -> nullable(GymVolume.total(f.json("parts")!!.arr().map { value ->
            val fields = Fields(value)
            VolumePart(fields.string("id"), fields.optionalDouble("weightKg"), fields.optionalInt("reps"), fields.optionalInt("loadCount"))
        }))
        "TrainingLog" -> {
            val id = f.ref("sessionId", Session)
            Json.objectOf("drawnSessions" to Json.Arr(log.drawnSessions.map { it.id.json }), "open" to (log.open?.id?.json ?: Json.Null),
                "liveHint" to Json.of(log.liveHint), "sets" to Json.Arr(log.sets(id).map { it.id.json }),
                "volumeKg" to nullable(log.volumeKg(id)), "topE1rm" to nullable(log.topE1rm(id)))
        }
        "SessionReadout" -> log.readout(f.ref("sessionId", Session))?.let {
            Json.objectOf("sessionId" to it.sessionId.json, "name" to nullable(it.name), "durationMs" to nullable(it.durationMs),
                "workingSetCount" to Json.of(it.workingSetCount), "movementCount" to Json.of(it.movementCount), "volumeKg" to nullable(it.volumeKg), "topE1rm" to nullable(it.topE1rm))
        } ?: Json.Null
        "LastTime" -> log.lastTime(f.ref("exerciseId", Exercise)).let {
            Json.objectOf("sessionId" to (it.session?.id?.json ?: Json.Null), "routine" to nullable(it.routine), "sets" to Json.Arr(it.sets.map { set -> set.id.json }), "isFirstTime" to Json.of(it.isFirstTime))
        }
        "Prefill", "ExpectedLoads" -> {
            val last = log.lastTime(f.ref("exerciseId", Exercise))
            val today = f.optionalRef("todaySessionId", Session)?.let { log.sets(it).filter { set -> set.exerciseId == last.exerciseId } } ?: emptyList()
            val plan = f.optionalValue("planEntry", RoutineEntry)
            if (vector.input.member("read").str() == "ExpectedLoads") Json.Arr(Prefill.expectedLoads(today.size, plan, last).map { nullable(it) })
            else Prefill.of(today, plan, last).let { Json.objectOf("weightKg" to Json.of(it.weightKg), "reps" to Json.of(it.reps)) }
        }
        "RestTarget" -> RestTarget.of(f.optionalValue("planEntry", RoutineEntry), restSettings(read))?.let {
            Json.objectOf("seconds" to Json.of(it.seconds), "reached" to Json.of(it.isReached(f.int("sinceMs").toLong())))
        } ?: Json.Null
        "StatsProgress" -> log.progress.json
        "BodyweightReps" -> {
            val progress = log.progress.movement(f.ref("exerciseId", Exercise))
            val series = if (f.bool("window", false)) progress.window(read.moment.now, read.moment.zone) else progress
            val best = series.bodyweightReps
            Json.objectOf("sessions" to Json.Arr(series.sessions.map { point ->
                Json.objectOf("sessionId" to point.id.json, "mostReps" to point.fact.mostReps.json,
                    "bodyweightReps" to (point.fact.bodyweightReps?.json ?: Json.Null))
            }), "best" to (best?.let { Json.objectOf("sessionId" to it.id.json, "fact" to it.fact.bodyweightReps!!.json) } ?: Json.Null))
        }
        "ProgressCompleteness" -> Json.objectOf("isComplete" to Json.of(log.progress.isComplete))
        "Consistency" -> nullable(log.progress.consistency(read.moment.now, read.moment.zone))
        "MovementProgress" -> {
            val progress = log.progress.movement(f.ref("exerciseId", Exercise))
            val series = if (f.bool("window", false)) progress.window(read.moment.now, read.moment.zone) else progress
            Json.objectOf("sessions" to Json.Arr(series.sessions.map { it.id.json }), "estimates" to Json.Arr(series.estimates.map { it.id.json }),
                "latest" to (series.latest?.id?.json ?: Json.Null), "best" to (series.best?.id?.json ?: Json.Null), "heaviest" to (series.heaviest?.id?.json ?: Json.Null),
                "mostReps" to (series.mostReps?.id?.json ?: Json.Null), "records" to Json.Arr(series.records.map { it.id.json }),
                "hasChart" to Json.of(series.hasChart(read.moment.zone)), "gaps" to Json.Arr(series.gaps(read.moment.zone).map {
                    Json.objectOf("before" to it.before.id.json, "after" to it.after.id.json)
                }))
        }
        "ProgressRecords" -> ProgressRecords(log.progress).let { records ->
            Json.objectOf("movements" to Json.Obj(records.movements.map { (id, run) -> id.record.string!! to Json.Arr(run.map {
                Json.objectOf("session" to it.point.id.json, "previous" to it.previous.id.json, "estimate" to Json.of(it.estimate), "gain" to Json.of(it.gain))
            }) }), "sessions" to Json.Arr(records.sessions.sorted().map { it.json }))
        }
        "Readout" -> when (f.string("operation")) {
            "weight" -> Json.of(Readout.weight(f.double("value")))
            "estimate" -> Json.of(Readout.estimate(f.double("value")))
            "target" -> Json.of(Readout.target(f.optionalList("sets", SetTarget)))
            "loadUnit" -> Json.of(Readout.loadUnit(f.optionalString("equipment"), f.int("loadCount")))
            "ladder" -> Json.of(Readout.ladder(f.list("sets", SetTarget)))
            "tonnes" -> nullable(Readout.tonnes(f.double("value")))
            "duration" -> Json.of(Readout.duration(f.instant("value").ms))
            "briefDay" -> Json.of(Readout.briefDay(f.instant("value"), read.moment.now, read.moment.zone))
            "ago" -> Json.of(Readout.ago(f.instant("value"), read.moment.now, read.moment.zone))
            else -> error("unclaimed readout operation")
        }
        else -> error("unclaimed training read")
    }
}

fun unitsForm(input: Json): Json {
    val value = input.member("value").num()
    val units = GymUnits.reading(input["units"]?.str())
    return when (input.member("operation").str()) {
        "ladder" -> Json.objectOf("labels" to Json.Arr(WeightLadder.labels(value).map(Json::of)),
            "down" to Json.of(WeightLadder.bump(value, -1)), "downBig" to Json.of(WeightLadder.bump(value, -1, true)),
            "up" to Json.of(WeightLadder.bump(value, 1)), "upBig" to Json.of(WeightLadder.bump(value, 1, true)))
        "round" -> Json.objectOf("rounded" to Json.of(WeightLadder.round(value)))
        "grid" -> Json.objectOf("rounded" to Json.of(WeightLadder.onGrid(value)))
        "reps" -> Json.objectOf("down" to Json.of(WeightLadder.bumpReps(value.toInt(), -1)), "up" to Json.of(WeightLadder.bumpReps(value.toInt(), 1)))
        "display" -> Json.objectOf("value" to Json.of(units.display(value)))
        "input" -> Json.objectOf("value" to Json.of(units.kilograms(value)))
        "estimate" -> Json.objectOf("text" to Json.of(Readout.estimate(value, units)))
        "weight" -> Json.objectOf("text" to Json.of(Readout.weight(value, units)))
        else -> error("unclaimed units operation")
    }
}
