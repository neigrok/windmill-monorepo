package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.core.Json
import works.windmill.sync.testing.Vector

fun trainingReadsForm(vector: Vector, read: Reader): Json {
    val f = Fields(vector.input.member("input"))
    val log = TrainingLog(read)
    return when (vector.input.member("read").str()) {
        "TrainingHistory" -> {
            val history = TrainingHistory(read)
            val args = vector.input.member("input").member("args").arr()
            val query = args.firstOrNull() ?: Json.objectOf()
            when (f.string("method")) {
                "exercises" -> history.exercises()
                "preferences" -> history.preferences()
                "notes" -> history.notes()
                "bodyweight" -> history.bodyweight()
                "routines" -> history.routines()
                "routine" -> history.routine(Id(query.str(), Routine))
                "proposals" -> history.proposals(query)
                "proposal" -> history.proposal(Id(query.str(), Proposal))
                "sessions" -> history.sessions(query)
                "session" -> history.session(Id(query.str(), Session))
                "review" -> history.review(Id(query.str(), Session))
                "history" -> history.history(query)
                "progress" -> history.progress()
                "stats" -> history.stats()
                "lastTime" -> history.lastTime(Id(query.str(), Exercise))
                "lastSets" -> history.lastSets()
                "record" -> history.record(Id(query.str(), Exercise))
                else -> error("unclaimed training history")
            }
        }
        "GymEstimate" -> nullable(GymEstimate.value(f.double("weightKg"), f.int("reps"), f.string("kind", "working"), f.optionalDouble("rpe")))
        "TrainingLog" -> {
            val id = f.ref("sessionId", Session)
            Json.objectOf("drawnSessions" to Json.Arr(log.drawnSessions.map { it.id.json }), "open" to (log.open?.id?.json ?: Json.Null),
                "liveHint" to Json.of(log.liveHint), "sets" to Json.Arr(log.sets(id).map { it.id.json }),
                "volumeKg" to Json.of(log.volumeKg(id)), "topE1rm" to nullable(log.topE1rm(id)))
        }
        "SessionReadout" -> log.readout(f.ref("sessionId", Session))?.let {
            Json.objectOf("sessionId" to it.sessionId.json, "name" to nullable(it.name), "durationMs" to nullable(it.durationMs),
                "workingSetCount" to Json.of(it.workingSetCount), "movementCount" to Json.of(it.movementCount), "volumeKg" to Json.of(it.volumeKg), "topE1rm" to nullable(it.topE1rm))
        } ?: Json.Null
        "LastTime" -> log.lastTime(f.ref("exerciseId", Exercise)).let {
            Json.objectOf("sessionId" to (it.session?.id?.json ?: Json.Null), "routine" to nullable(it.routine), "sets" to Json.Arr(it.sets.map { set -> set.id.json }), "isFirstTime" to Json.of(it.isFirstTime))
        }
        "Prefill" -> {
            val last = log.lastTime(f.ref("exerciseId", Exercise))
            val today = f.optionalRef("todaySessionId", Session)?.let { log.sets(it).filter { set -> set.exerciseId == last.exerciseId } } ?: emptyList()
            val prefill = Prefill.of(today, f.optionalValue("planEntry", RoutineEntry), last)
            Json.objectOf("weightKg" to Json.of(prefill.weightKg), "reps" to Json.of(prefill.reps))
        }
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
        "Readout" -> when (f.string("operation")) {
            "estimate" -> Json.of(Readout.estimate(f.double("value")))
            "target" -> Json.of(Readout.target(f.optionalList("sets", SetTarget)))
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
