package works.windmill.gym.domain.sync

import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.domain.testing.*
import works.windmill.sync.api.Notice
import works.windmill.sync.api.NoticeContent
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Command
import works.windmill.sync.core.Delta
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.testing.Vector

class CorpusTests {
    val book = GymRules.book
    val corpus = ProductCorpus(book)
    val paths = listOf("gym/domain/rules.json", "gym/domain/values.json", "gym/domain/notes-actions.json",
        "gym/domain/bodyweight-actions.json", "gym/domain/routines-actions.json", "gym/domain/catalogue-actions.json",
        "gym/domain/preferences-actions.json", "gym/domain/proposals-actions.json", "gym/domain/training-actions.json",
        "gym/domain/recovery-actions.json", "gym/domain/training-reads.json", "gym/domain/units.json", "gym/rules/bodyweight.json")

    @Test fun everyProductFileIsClaimedAndEveryVectorPasses() {
        assertEquals(paths.sorted(), Contract.files("gym"))
        val failures = mutableListOf<String>()
        try { RuleBookParity.check(book, paths[0]) } catch (error: Exception) {
            failures += "${paths[0]} · ${error.message}"
        }
        var cases = 1
        for (path in paths.drop(1)) for (vector in Contract.vectors(path)) {
            try {
                val actual = run(vector)
                if (vector.expect.jcs != actual.jcs) failures += "$path · ${vector.name}\n  got    ${actual.jcs}\n  expect ${vector.expect.jcs}"
            } catch (error: Exception) { failures += "$path · ${vector.name}\n  threw ${error.javaClass.simpleName}: ${error.message}" }
            cases++
        }
        failures.forEach(::println)
        assertTrue("${failures.size} gym corpus failures:\n${failures.joinToString("\n")}", failures.isEmpty())
        println("Gym corpus: ${paths.size}/${paths.size} files, $cases cases, no pending case, no unclaimed file")
    }

    @Test fun everySharedLocalRuleAndCodeIsCovered() {
        RuleBookCheck.check(book, GymRefusal, "gym/domain/values.json", paths.filter { it.endsWith("-actions.json") })
    }

    @Test fun ladderDirectlyRunsTheSharedCrossSurfaceContract() {
        val file = Contract.json("gym-ladder.json")
        for (item in file.member("weightCases").arr()) {
            val value = item.member("weight").num()
            assertEquals(item.member("labels").arr().map { it.str() }, WeightLadder.labels(value))
            for ((field, direction, big) in listOf(Triple("down", -1, false), Triple("downBig", -1, true), Triple("up", 1, false), Triple("upBig", 1, true)))
                assertEquals("$value · $field", item.member(field).num(), WeightLadder.bump(value, direction, big), 0.0)
        }
        for (item in file.member("roundCases").arr())
            assertEquals(item.member("rounded").num(), WeightLadder.round(item.member("value").num()), 0.0)
        for (item in file.member("repCases").arr()) {
            val value = item.member("reps").long().toInt()
            assertEquals(item.member("down").long().toInt(), WeightLadder.bumpReps(value, -1))
            assertEquals(item.member("up").long().toInt(), WeightLadder.bumpReps(value, 1))
        }
    }

    fun run(vector: Vector): Json {
        val input = vector.input["input"]
        return when (vector.file) {
            "gym/domain/values.json" -> corpus.value(vector)
            "gym/domain/notes-actions.json" -> when (vector.input.member("action").str()) {
                "SaveNoteCall" -> corpus.decision(SaveNoteCall(Note.fromForm(input!!.member("note"))), vector, { it.json }, ::refusalForm)
                "MoveNote" -> corpus.decision(moveNote(Fields(input!!).ref("id", Note), Fields(input).optionalRef("below", Note)), vector, { Json.Null }, ::refusalForm)
                else -> error("unclaimed notes action")
            }
            "gym/domain/bodyweight-actions.json" -> when (vector.input.member("action").str()) {
                "SaveWeighIn" -> {
                    val blank = WeighIn(LocalDay.parse(input!!.member("day").str())!!)
                    corpus.save(WeighIn, GymRefusal, vector, blank,
                        { it.copy(kg = input["kg"]?.orNull()?.num()) },
                        { Json.objectOf("id" to blank.id.json, "fields" to Json.Obj(it.values.toList())) }, ::refusalForm)
                }
                "DeleteWeighIn" -> corpus.decision(deleteWeighIn(WeighIn(LocalDay.parse(input!!.member("day").str())!!).id), vector, { Json.Null }, ::refusalForm)
                else -> error("unclaimed bodyweight action")
            }
            "gym/rules/bodyweight.json" -> corpus.read(vector, WeighIn.scope) { bodyweightForm(Bodyweight(it), input) }
            "gym/domain/routines-actions.json" -> routines(vector, input!!)
            "gym/domain/catalogue-actions.json" -> catalogue(vector, input!!)
            "gym/domain/preferences-actions.json" -> preferences(vector, input!!)
            "gym/domain/proposals-actions.json" -> proposals(vector, input!!)
            "gym/domain/training-actions.json" -> training(vector, input!!)
            "gym/domain/recovery-actions.json" -> recovery(vector, input!!)
            "gym/domain/training-reads.json" -> corpus.read(vector, Session.scope) { trainingReadsForm(vector, it) }
            "gym/domain/units.json" -> unitsForm(vector.input)
            else -> error("unclaimed gym file ${vector.file}")
        }
    }

    fun routines(vector: Vector, input: Json): Json {
        return when (vector.input["action"]?.str()) {
            "SaveRoutine" -> {
                val value = Routine.fromForm(input.member("routine"))
                corpus.save(Routine, GymRefusal, vector, Routine(value.id), { value }, { it.form }, ::refusalForm)
            }
            "CreateRoutine" -> corpus.decision(saveRoutine(Routine.fromForm(input.member("routine"))), vector, { it.form }, ::refusalForm)
            "ReorderRoutines" -> corpus.decision(ReorderRoutines(input.member("order").arr().map { Id(RecordID(it), Routine) }), vector, { Json.Null }, ::refusalForm)
            "DeleteRoutine" -> corpus.decision(deleteRoutine(Id(RecordID(input.member("id")), Routine)), vector, { Json.Null }, ::refusalForm)
            null -> decoded {
                corpus.read(vector, Routine.scope) { read -> when (vector.input.member("read").str()) {
                    "Routines" -> Json.Arr(Routine.ordered(read.repository(Routine).all(ViewMode.drawn)).map { entityForm(it.id, it.fields()) })
                    "RoutineMetadata" -> {
                        val value = read.repository(Routine).find(Id(RecordID(input.member("id")), Routine), ViewMode.drawn)!!
                        Json.objectOf("revision" to nullable(value.revision), "createdEntries" to nullable(value.createdEntries),
                            "createdDoor" to nullable(value.createdDoor), "fields" to Json.Obj(value.fields().toList()))
                    }
                    "SessionPlan" -> PlanSnapshot.decode(input["plan"])?.json ?: Json.Null
                    else -> error("unclaimed routine read")
                } }
            }
            else -> error("unclaimed routine action")
        }
    }

    fun catalogue(vector: Vector, input: Json): Json = when (vector.input["action"]?.str()) {
        "CreateExercise" -> {
            val exercise = Exercise.fromForm(input.member("exercise"))
            val value = input["loadCount"]?.let { exercise.copy(loadCount = it.long().toInt()) } ?: exercise
            corpus.decision(CreateExercise(value), vector, { it.json }, ::refusalForm)
        }
        "RenameExercise" -> corpus.decision(RenameExercise(Id(RecordID(input.member("id")), Exercise), input.member("name").str()), vector, { Json.Null }, ::refusalForm)
        null -> decoded { corpus.read(vector, Exercise.scope) { read -> when (vector.input.member("read").str()) {
            "SeedExercises" -> Json.Arr(SeedExercises.all.map(::exerciseForm))
            "Catalogue" -> {
                val catalogue = Catalogue(read)
                Json.Arr((input["id"]?.let { catalogue.find(Id(RecordID(it), Exercise))?.let(::listOf) ?: emptyList() }
                    ?: catalogue.search(input["query"]?.str() ?: "")).map(::exerciseForm))
            }
            "RenamedAliases" -> Json.Arr(ExerciseRules.renamedAliases(input.member("previous").str(), input.member("next").str(), input.member("aliases").arr().map { it.str() }).map(Json::of))
            "DefaultStepKg" -> Json.Obj(listOf("barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell").map { it to Json.of(ExerciseRules.defaultStepKg(it)) })
            else -> error("unclaimed catalogue read")
        } } }
        else -> error("unclaimed catalogue action")
    }

    fun preferences(vector: Vector, input: Json): Json = when (vector.input["action"]?.str()) {
        "SavePreferences" -> {
            val value = Preferences.fromForm(input.member("preferences"))
            corpus.save(Preferences, GymRefusal, vector, Preferences(), { value }, { it.form }, ::refusalForm)
        }
        null -> corpus.read(vector, Preferences.scope) { read -> when (vector.input.member("read").str()) {
            "Preferences" -> (read.repository(Preferences).find(Preferences().id, ViewMode.drawn) ?: Preferences()).let { entityForm(it.id, it.fields()) }
            "RestSettings" -> restSettings(read).let { Json.objectOf("seconds" to nullable(it.seconds), "sound" to Json.of(it.sound)) }
            else -> error("unclaimed preferences read")
        } }
        else -> error("unclaimed preferences action")
    }

    fun proposals(vector: Vector, input: Json): Json {
        val f = Fields(input)
        return when (vector.input.member("action").str()) {
            "ProposeRoutine" -> corpus.decision(ProposeRoutine(f.ref("id", Proposal), f.ref("routineId", Routine), f.string("name", ""),
                f.list("entries", RoutineEntry), f.string("summary", ""), f.bool("removing", false)), vector, { it.json }, ::refusalForm)
            "ApplyProposal" -> corpus.decision(ApplyProposal(f.ref("id", Proposal)), vector, { Json.Null }, ::refusalForm)
            "DismissProposal" -> corpus.decision(DismissProposal(f.ref("id", Proposal)), vector, { Json.Null }, ::refusalForm)
            "Diff" -> Json.objectOf("changes" to Json.Arr(ProposalRules.changesBetween(f.list("base", RoutineEntry), f.list("proposed", RoutineEntry)).map { it.json }))
            "ChangeCount" -> Json.objectOf("changeCount" to Json.of(Proposal.fromForm(input.member("proposal")).changeCount(Routine.fromForm(input.member("base")))))
            "Metadata" -> {
                val p = Proposal.fromForm(input)
                val provenance = when (p.door) {
                    "ask" -> Json.objectOf("door" to Json.of("ask"), "threadId" to nullable(p.threadId))
                    else -> Json.objectOf("door" to Json.of(p.door), "connection" to Json.of(p.connection), "agent" to Json.of(p.agent))
                }
                Json.objectOf("baseRevision" to nullable(p.baseRevision), "baseName" to nullable(p.baseName), "changeCount" to nullable(p.changeCount),
                    "state" to Json.of(p.state), "provenance" to provenance)
            }
            "RoutineCreation" -> Json.objectOf("snapshot" to (RoutineCreation.fromForm(input).snapshot ?: Json.Null))
            "StateRefusal", "OutOfDate" -> {
                val p = input["proposal"]?.orNull()?.let { Proposal.fromForm(it) }
                val r = input["routine"]?.orNull()?.let { Routine.fromForm(it) }
                val state = ProposalState(p, r, moment(vector.input), f.bool("routineVisible", true), input["confirmedRoutine"]?.let { Routine.fromForm(it) } ?: r)
                if (vector.input.member("action").str() == "OutOfDate") Json.objectOf("outOfDate" to Json.of(state.outOfDate))
                else Json.objectOf("refusal" to (state.refusal(Id("proposal1", Proposal), f.bool("applying"))?.let(::refusalForm) ?: Json.Null))
            }
            "ValidateProposal" -> try { Json.objectOf("fields" to Json.Obj(Valid(Proposal.fromForm(input), Proposal, at = moment(vector.input)).value.fields().toList())) }
                catch (violation: Violation) { Json.objectOf("violation" to violation.json) }
            else -> error("unclaimed proposal action")
        }
    }

    fun training(vector: Vector, input: Json): Json {
        val f = Fields(input)
        if (vector.input["read"] != null) return corpus.read(vector, Session.scope) { read ->
            when (vector.input.member("read").str()) {
                "TrainingLog" -> {
                    val log = TrainingLog(read)
                    val id = f.ref("sessionId", Session)
                    Json.objectOf("sessions" to Json.Arr(log.drawnSessions.map { entityForm(it.id, it.fields()) }),
                        "sets" to Json.Arr(log.sets(id).map { entityForm(it.id, it.fields() + (it.setNumber?.let { number -> mapOf("setNumber" to Json.of(number)) } ?: emptyMap())) }),
                        "open" to (log.open?.id?.json ?: Json.Null), "liveHint" to Json.of(log.liveHint), "volumeKg" to Json.of(log.volumeKg(id)), "topE1rm" to nullable(log.topE1rm(id)))
                }
                "SessionRules" -> when (f.string("operation")) {
                    "drawn" -> SessionRules.drawn(Session.fromForm(input.member("session")), read.repository(TrainingSet).all(ViewMode.drawn), read.moment.now).let { entityForm(it.id, it.fields()) }
                    "crosses" -> Json.of(SessionRules.crosses(f.instant("startedAt"), f.instant("finishedAt"), Session.fromForm(input.member("session"))))
                    "canStartAt" -> Json.of(SessionRules.canStartAt(f.instant("startedAt"), read.moment.now))
                    "canFinishAt" -> Json.of(SessionRules.canFinishAt(Session.fromForm(input.member("session")), f.instant("finishedAt")))
                    else -> error("unclaimed session rule")
                }
                "SetRules" -> nullable(SetRules.nextNumber(read.repository(TrainingSet).all(ViewMode.stored), f.ref("sessionId", Session), f.ref("exerciseId", Exercise)))
                else -> error("unclaimed training read")
            }
        }
        return when (vector.input.member("action").str()) {
            "StartSession" -> corpus.decision(StartSession(f.ref("id", Session), f.optionalRef("routineId", Routine), f.optionalInstant("startedAt")), vector, { it.json }, ::refusalForm)
            "FinishSession" -> corpus.decision(FinishSession(f.ref("id", Session), f.optionalInstant("finishedAt")), vector, { Json.Null }, ::refusalForm)
            "AppendSet" -> corpus.decision(AppendSet(TrainingSet.fromForm(input.member("set"))), vector, { it.json }, ::refusalForm)
            "CorrectSet" -> corpus.decision(CorrectSet(TrainingSet.fromForm(input.member("set"))), vector, { Json.Null }, ::refusalForm)
            "DiscardSession" -> corpus.decision(DiscardSession(f.ref("id", Session)), vector, { Json.Null }, ::refusalForm)
            "DeleteSet" -> corpus.decision(deleteSet(f.ref("id", TrainingSet)), vector, { Json.Null }, ::refusalForm)
            "ImportSession" -> {
                val sets = input.member("sets").arr().map { raw ->
                    val s = Fields(raw)
                    ImportedSet(s.ref("id", TrainingSet), s.ref("exerciseId", Exercise), s.double("weightKg"), s.int("reps"), s.instant("completedAt"),
                        s.optionalDouble("rpe"), s.optionalString("note"), raw["rpe"] != null)
                }
                corpus.decision(ImportSession(f.ref("id", Session), f.instant("startedAt"), f.instant("finishedAt"), sets, f.optionalRef("routineId", Routine)), vector, { it.json }, ::refusalForm)
            }
            "CorrectSession" -> {
                val sets = input.member("sets").arr().map { raw ->
                    val s = Fields(raw)
                    CorrectedSet(s.ref("id", TrainingSet), s.ref("exerciseId", Exercise), raw.member("setNumber").long(), s.double("weightKg"), s.int("reps"), s.instant("completedAt"),
                        s.optionalDouble("rpe"), s.optionalString("note"), raw["rpe"] != null)
                }
                corpus.decision(CorrectSession(f.ref("sessionId", Session), f.string("requestId"), f.instant("startedAt"), f.instant("finishedAt"), f.optionalString("routineName"), sets,
                    input["preserveOtherSets"] == Json.of(true)), vector, { Json.Null }, ::refusalForm)
            }
            else -> error("unclaimed training action")
        }
    }

    fun recovery(vector: Vector, input: Json): Json {
        val f = Fields(input)
        if (vector.input["read"] != null) return corpus.read(vector, Session.scope) { read ->
            val saved = SignedOutWorkout.read(read)
            val log = TrainingLog(read)
            val catalogue = Catalogue(read)
            val rows = WorkoutRecovery.review(saved, input["notices"]?.arr().orEmpty().map(::notice), log, catalogue)
            when (vector.input.member("read").str()) {
                "WorkoutRecovery" -> Json.Arr(rows.map { row ->
                    Json.objectOf("id" to row.id.json, "reason" to Json.of(row.reason.label), "retry" to Json.of(row.retry.name),
                        "noticeIds" to Json.Arr(row.noticeIds.map(Json::of)), "strandedSets" to Json.Arr(row.strandedSets.map { it.id.json }),
                        "refusal" to (row.refusal?.let(::refusalForm) ?: Json.Null), "canFix" to Json.of(row.canFix))
                })
                "owns" -> Json.of(saved.first { it.session.id == f.ref("id", Session) }.owns(notice(input.member("notice"))))
                "WorkoutFix" -> {
                    val id = f.ref("id", Session)
                    var fix = rows.firstOrNull { it.id == id }?.let { WorkoutFix(it) } ?: WorkoutFix(saved.first { it.session.id == id })
                    f.optionalInstant("startedAt")?.let { fix = fix.copy(startedAt = it) }
                    if (input["finishedAt"] != null) fix = fix.copy(finishedAt = f.optionalInstant("finishedAt"))
                    input["sets"]?.let { sets -> fix = fix.copy(sets = sets.arr().map { set ->
                        WorkoutFix.SetFix(TrainingSet.decode(Fields(TrainingSet.type, RecordID(set.member("id")), set.obj() - "id" + ("sessionId" to id.json))))
                    }) }
                    Json.objectOf("landed" to Json.of(fix.landed), "sets" to Json.Arr(fix.sets.map { it.id.json }),
                        "refusal" to (fix.refusal(log.moment, log.drawnSessions, catalogue)?.let(::refusalForm) ?: Json.Null))
                }
                else -> error("unclaimed recovery read")
            }
        }
        val id = f.ref("id", Session)
        val revised = input["revised"]?.let(SignedOutWorkout::decode)
        return when (vector.input.member("action").str()) {
            "AdoptWorkout" -> corpus.decision(AdoptWorkout(id, if (f.string("mode") == "keep") AdoptWorkout.Mode.keep else AdoptWorkout.Mode.restart, revised), vector, { Json.Null }, ::refusalForm)
            "RecoverStrandedSets" -> corpus.decision(RecoverStrandedSets(id,
                if (f.string("placement") == "intoWorkout") RecoverStrandedSets.Placement.intoWorkout else RecoverStrandedSets.Placement.separately, revised), vector, { Json.Null }, ::refusalForm)
            "DiscardSignedOutWorkout" -> corpus.decision(DiscardSignedOutWorkout(id), vector, { Json.Null }, ::refusalForm)
            else -> error("unclaimed recovery action")
        }
    }
}

// The kit corpus's notice form, `{id, scope, code, detail?, content: {d, cmd?, dependents?}, at, dismissed?}`.
fun notice(json: Json): DomainNotice<GymRefusal> {
    fun content(json: Json): NoticeContent = NoticeContent(json["d"]?.arr().orEmpty().map { Delta(it) }, json["cmd"]?.let { Command(it) },
        json["dependents"]?.arr().orEmpty().map { content(it) })
    val notice = Notice(json.member("id").str(), "gym", ScopeRef(json.member("scope").str()), RefusalCode(json.member("code").str()), json["detail"],
        content(json.member("content")), json["at"]?.long() ?: 0, json["dismissed"]?.bool() ?: false)
    return DomainNotice(notice, SyncSchema.registry, GymRefusal)
}

fun nullable(value: Number?): Json = value?.let(Json::of) ?: Json.Null
fun nullable(value: String?): Json = value?.let(Json::of) ?: Json.Null
fun <E : Entity<E>> entityForm(id: Id<E>, fields: Map<String, Json>): Json = Json.objectOf("id" to id.json, "fields" to Json.Obj(fields.toList()))
fun exerciseForm(value: Exercise): Json = Json.objectOf("id" to value.id.json, "fields" to Json.Obj(value.fields().toList()), "aliases" to Json.Arr(value.aliases.map(Json::of)))
fun decoded(body: () -> Json): Json = try { body() } catch (error: DecodeError) {
    Json.objectOf("decodeError" to Json.objectOf("type" to Json.of(error.type), "field" to Json.of(error.field), "reason" to Json.of(error.reason)))
}

fun refusalForm(value: GymRefusal): Json = when (value) {
    is GymRefusal.Invalid -> Json.objectOf("invalid" to value.violation.json)
    is GymRefusal.Stale -> Json.objectOf("stale" to Json.objectOf("subject" to value.subject.form, "path" to Json.of(value.path.name)))
    is GymRefusal.Gone -> Json.objectOf("gone" to Json.objectOf("subject" to value.subject.form, "path" to Json.of(value.path.name)))
    is GymRefusal.Taken -> Json.objectOf("taken" to Json.objectOf("subject" to value.subject.form, "path" to Json.of(value.path.name)))
    is GymRefusal.Future -> Json.objectOf("future" to Json.objectOf("subject" to value.subject.form, "path" to Json.of(value.path.name)))
    is GymRefusal.Full -> Json.objectOf("full" to Json.objectOf("type" to Json.of(value.type), "cap" to Json.of(value.cap), "path" to Json.of(value.path.name)))
    is GymRefusal.Other -> Json.objectOf("other" to value.refused.form)
    is GymRefusal.SessionFinished -> Json.objectOf("sessionFinished" to value.refused.form)
    is GymRefusal.SessionOpen -> Json.objectOf("sessionOpen" to value.refused.form)
    is GymRefusal.SessionOverlap -> Json.objectOf("sessionOverlap" to value.refused.form)
    is GymRefusal.PayloadConflict -> Json.objectOf("payloadConflict" to value.refused.form)
    is GymRefusal.UnknownExercise -> Json.objectOf("unknownExercise" to value.refused.form)
    is GymRefusal.BadInstant -> Json.objectOf("badInstant" to value.refused.form)
    is GymRefusal.ProposalSettled -> Json.objectOf("proposalSettled" to value.refused.form)
    is GymRefusal.ProposalSuperseded -> Json.objectOf("proposalSuperseded" to value.refused.form)
}

fun bodyweightForm(value: Bodyweight, input: Json?): Json {
    fun entry(item: Bodyweight.Entry) = Json.objectOf("day" to Json.of(item.day.text), "kg" to Json.of(item.kg))
    fun chart(window: Bodyweight.Window): Json {
        val drawn = value.chart(window)
        return Json.objectOf("dots" to Json.Arr(drawn.dots.map(::entry)), "gaps" to Json.Arr(drawn.gaps.map {
            Json.objectOf("after" to Json.of(it.after.text), "before" to Json.of(it.before.text))
        }))
    }
    return Json.objectOf("stance" to Json.of(value.stance.name), "today" to Json.of(value.today.text), "reading" to (value.reading?.let {
        Json.objectOf("entry" to entry(it.entry), "daysAgo" to Json.of(it.daysAgo))
    } ?: Json.Null), "recent" to chart(Bodyweight.Window.recent), "all" to chart(Bodyweight.Window.all),
        "list" to Json.Arr(value.entries(input?.get("from")?.orNull()?.str()?.let(LocalDay::parse), input?.get("to")?.orNull()?.str()?.let(LocalDay::parse)).map(::entry)))
}
