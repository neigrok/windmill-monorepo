package works.windmill.gym.store

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import works.windmill.gym.domain.*
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.core.ClockReading
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.*
import works.windmill.sync.schema.SyncSchema

class WorkoutImportsTests {
    private val scope = WorkoutImports.scope
    private val timing = RequestTiming(ClockReading(100_000, 100_000, "boot"), ClockReading(100_000, 100_000, "boot"))
    private fun engine(snapshot: Json? = null, pushMaxBytes: Int? = null) = if (pushMaxBytes == null) Engine.memory(SyncSchema.registry, snapshot,
        clock = object : EngineClock { override fun now() = 100_000L },
        commandResultWrites = WorkoutImports.commandResultWrites,
        pendingDeviceWork = WorkoutImports.pendingDeviceWork, rewriteDeviceValue = WorkoutImports.rewriteDeviceValue)
        else Engine.memory(SyncSchema.registry, snapshot, clock = object : EngineClock { override fun now() = 100_000L }, pushMaxBytes = pushMaxBytes,
        commandResultWrites = WorkoutImports.commandResultWrites,
        pendingDeviceWork = WorkoutImports.pendingDeviceWork, rewriteDeviceValue = WorkoutImports.rewriteDeviceValue)
    private fun finished(id: String = "session01", start: Long = 1_000, finish: Long = 3_000) =
        SavedWorkout(Session(id, start, finish), listOf(TrainingSet("set00001", "back-squat", weightKg = 60.0,
            reps = 5, completedAtMs = 2_000)), deleted = listOf("deleted01"))
    private fun outbox(engine: Engine): List<Json> = engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }
    private fun sources(engine: Engine) = engine.read(scope) { reader -> reader.devices(WorkoutImports.journalPrefix).values
        .flatMap { it.member("items").obj().values } }

    private fun pull(engine: Engine, server: ModelServer) {
        val request = engine.pullRequest(listOf(scope))!!
        val reply = server.pull(request, Credential.Account("A"), 100_000)
        assertEquals(200, reply.status)
        engine.onPullResponse(request, SyncResponse(reply.status, reply.body), timing)
    }

    private fun push(engine: Engine, server: ModelServer) {
        while (true) {
            val request = engine.nextPush() ?: break
            val reply = server.push(request, Credential.Account("A"), 100_000)
            assertEquals(200, reply.status)
            engine.onPushResponse(request, SyncResponse(reply.status, reply.body), timing)
            pull(engine, server)
        }
    }

    private fun refuseNext(engine: Engine, code: String, at: Int? = null) {
        val request = (if (at == null) engine.nextPush() else engine.nextPush(at))!!
        val n = request.member("intents").arr().single().member("n")
        engine.onPushResponse(request, SyncResponse(200, Json.objectOf("epoch" to Json.of("ep-1"), "as" to Json.of("A"), "lastN" to n,
            "results" to Json.array(Json.objectOf("n" to n, "s" to Json.of("refused"), "code" to Json.of(code))))), timing)
    }

    // The account holds an open workout of its own before the phone signs in.
    private suspend fun accountWorkout(server: ModelServer) = engine().use { remote ->
        remote.signIn("A", emptyMap()); pull(remote, server)
        EngineTraining(remote) { null }.startSession(SessionStart("existing1", 500)); push(remote, server)
    }

    @Test fun repackagingLinkedAnonymousHistoryRollsBackOnCrashAndResumesWithOneDurableImport() = runBlocking {
        engine().use { local ->
            val gym = EngineTraining(local) { null }
            val exercise = gym.createExercise(ExerciseWrite("exercise1", "Custom", "isolation", "machine"))
            val routine = gym.createRoutine(RoutineWrite("routine01", "Original", 0, listOf(RoutineEntryWrite(exercise.id, listOf(SetTarget(5, 60.0))))))
            val row = finished().copy(session = finished().session.copy(routineId = routine.id, plan = PlanSnapshot(routine)),
                sets = listOf(finished().sets.single().copy(exerciseId = exercise.id)), deleted = emptyList())
            val imports = WorkoutImports(local)
            val before = local.snapshot(); val born = local.read(scope) { it.drawn("routine", RecordID(routine.id))!!.born }
            local.failNextCommit(); assertThrows(CommitFailure::class.java) { imports.prepare(row) }
            assertEquals(before, local.snapshot())
            imports.prepare(row)
            assertEquals(3, outbox(local).size)
            val intent = outbox(local).single { it.member("intent")["cmd"] != null }.member("intent")
            assertEquals("gym.importSession", intent.member("cmd").member("name").str())
            assertEquals(born!!.json, intent.member("d").arr().single().member("born"))
            assertEquals(row, imports.retainedWorkouts().single())
            engine(local.snapshot()).use { reopened ->
                val stable = reopened.snapshot(); WorkoutImports(reopened).prepare(row)
                assertEquals(stable, reopened.snapshot()); assertEquals(3, outbox(reopened).size)
                assertEquals(row, WorkoutImports(reopened).retainedWorkouts().single())
            }
        }
    }

    @Test fun anOpenWorkoutMeetingTheAccountsOwnKeepsEverySetAndKeepImportsThemInPerformedOrder() = runBlocking {
        val server = EngineRoomFixture.server()
        accountWorkout(server)
        engine().use { local ->
            val gym = EngineTraining(local) { null }
            gym.startSession(SessionStart("session01", 1_000))
            listOf("original1" to 2_000L, "zzzzzzzz" to 2_500L, "aaaaaaaa" to 2_500L, "fourth01" to 3_000L).forEach { (id, at) ->
                gym.appendSet("session01", SetWrite(id, "back-squat", 60.0, 5, SetKind.Working, at))
            }
            gym.prepareAdoption()
            assertEquals(4, WorkoutImports(local).retainedWorkouts().single().sets.size)
            local.signIn("A", emptyMap()); pull(local, server); push(local, server)
            local.notices("gym").notices.value.forEach { local.dismissNotice(it.id) }
            engine(local.snapshot()).use { reopened ->
                val imports = WorkoutImports(reopened)
                assertEquals(4, imports.retainedWorkouts().single().sets.size)
                assertEquals("session-open", imports.refusals().single().code)
                imports.keepWorkout("session01")
                val command = outbox(reopened).single().member("intent").member("cmd")
                assertEquals("gym.importSession", command.member("name").str()); assertEquals(3_000L, command.member("args").member("finishedAt").long())
                assertEquals(listOf("original1", "aaaaaaaa", "zzzzzzzz", "fourth01"), command.member("args").member("sets").arr().map { it.member("id").str() })
                assertTrue(imports.operations().isEmpty()); push(reopened, server)
                val actual = EngineTraining(reopened) { null }
                assertTrue(actual.session("existing1")!!.session.isOpen)
                assertEquals(listOf(1, 2, 3, 4), actual.session("session01")!!.sets.map { it.setNumber })
            }
        }
    }

    @Test fun aFailedKeepRetainsTheFinishedSourceForRetryAfterRestart() = runBlocking {
        val server = EngineRoomFixture.server()
        accountWorkout(server)
        val (set, refused) = engine().use { local ->
            val gym = EngineTraining(local) { null }
            gym.startSession(SessionStart("session01", 1_000))
            gym.appendSet("session01", SetWrite("set00001", "back-squat", 60.0, 5, SetKind.Working, 2_000))
            gym.fixSet("session01", "set00001", SetFix(note = "n".repeat(3_000)))
            val set = gym.session("session01")!!.sets.single()
            gym.prepareAdoption()
            local.signIn("A", emptyMap()); pull(local, server); push(local, server)
            assertEquals("session-open", WorkoutImports(local).refusals().single().code)
            set to local.snapshot()
        }
        engine(refused, pushMaxBytes = 800).use { limited ->
            val imports = WorkoutImports(limited)
            imports.keepWorkout("session01")
            val refusal = imports.refusals().single()
            assertEquals("too-large", refusal.code); assertEquals(2_000L, refusal.session!!.finishedAtMs); assertEquals(listOf(set), refusal.sets)
            val source = sources(limited).single { it["kind"] == Json.of("finished") && it["state"] == Json.of("refused") }
            assertEquals(set, diskJson.decodeFromString(OwedSet.serializer(), source.member("original").member("entries").member(set.id).jcs).set)
            assertTrue(outbox(limited).isEmpty()); assertTrue(imports.operations().isEmpty())
            engine(limited.snapshot()).use { reopened ->
                assertEquals(refusal, WorkoutImports(reopened).refusals().single())
                WorkoutImports(reopened).retry("session01")
                assertEquals("gym.importSession", outbox(reopened).single().member("intent").member("cmd").member("name").str())
                assertEquals(source.member("original"), sources(reopened).single { it["kind"] == Json.of("finished") && it["state"] == Json.of("queued") }.member("original"))
            }
        }
    }

    @Test fun refreshedFinishedSnapshotsPreserveExplicitCorrectionsToDefaultValues() = runBlocking {
        engine().use { local ->
            val gym = EngineTraining(local) { null }; gym.createExercise(ExerciseWrite("exercise1", "Custom", "isolation", "machine"))
            gym.startSession(SessionStart("session01", 1_000))
            gym.appendSet("session01", SetWrite("set00001", "exercise1", 60.0, 5, SetKind.Warmup, 2_000))
            gym.fixSet("session01", "set00001", SetFix(rpe = 9.0, rpeNamed = true, note = "Before"))
            gym.finishSession("session01", 3_000)
            fun row() = gym.details().single().let { SavedWorkout(it.session, it.sets) }
            val imports = WorkoutImports(local)
            imports.prepare(row())
            gym.fixSet("session01", "set00001", SetFix(kind = SetKind.Working, rpe = null, rpeNamed = true, note = ""))
            val corrected = row(); imports.prepare(corrected)
            val sets = outbox(local).single { it.member("intent")["cmd"] != null }.member("intent").member("cmd").member("args").member("sets").arr()
            assertEquals(Json.of("working"), sets.single().member("kind")); assertEquals(Json.Null, sets.single().member("rpe")); assertEquals(Json.of(""), sets.single().member("note"))
            assertEquals(corrected, imports.retainedWorkouts().single())
        }
    }

    @Test fun anUnknownLocalBornPrerequisiteCannotPartiallyWriteTheCommandOrItsDeviceJournal() {
        engine().use { e ->
            val before = e.snapshot()
            assertThrows(CommitFailure::class.java) { e.commitWithPrerequisites(scope) {
                works.windmill.sync.api.Gesture(listOf(works.windmill.sync.api.Change.update("routine", RecordID("unknown1"))),
                    command = works.windmill.sync.api.Command("gym.start", Json.objectOf("id" to Json.of("session01"), "startedAt" to Json.of(1_000))),
                    local = listOf(works.windmill.sync.api.DeviceWrite(WorkoutImports.journalPrefix + "unknown", Json.of("original source")))) to Unit
            } }
            assertEquals(before, e.snapshot()); assertTrue(outbox(e).isEmpty())
        }
    }

    @Test fun anExplicitNumberingGapIsRetainedUntilThePersonRenumbersItsSets() {
        val row = finished().copy(sets = listOf(finished().sets.single().copy(setNumber = 2)), deleted = emptyList())
        engine().use { e ->
            val imports = WorkoutImports(e)
            imports.prepare(row)
            assertEquals("source-numbering", imports.refusals().single().code)
            assertEquals(2, imports.refusals().single().sets.single().setNumber)
            val original = sources(e).single().member("source")
            imports.replaceAndRetry(row.session.id, row.copy(sets = row.sets.map { it.copy(setNumber = 1) }))
            imports.retry(row.session.id)
            assertEquals(1, outbox(e).size); assertEquals(original, sources(e).single().member("original"))
        }
    }

    @Test fun explicitContiguousNumbersAreCheckedIndependentlyForEachMovement() {
        val row = finished().copy(sets = listOf(finished().sets.single().copy(setNumber = 1),
            finished().sets.single().copy(id = "set00002", exerciseId = "bench-press", setNumber = 1),
            finished().sets.single().copy(id = "set00003", setNumber = 2)), deleted = emptyList())
        engine().use { e ->
            WorkoutImports(e).prepare(row)
            assertTrue(WorkoutImports(e).refusals().isEmpty()); assertEquals(1, outbox(e).size)
        }
    }

    @Test fun anExplicitRefusalDiscardSurvivesReopenAndLeavesItsOriginalSourceOnThePhone() {
        engine().use { e ->
            WorkoutImports(e).prepare(finished(start = 101_000, finish = 103_000))
            val original = sources(e).single().member("source")
            WorkoutImports(e).discardRefusal("session01")
            engine(e.snapshot()).use { reopened ->
                val imports = WorkoutImports(reopened)
                assertTrue(imports.refusals().isEmpty()); assertTrue(imports.deletedSets().isEmpty())
                assertEquals(original, sources(reopened).single().member("source")); assertEquals("discarded", sources(reopened).single().member("state").str())
            }
        }
    }

    @Test fun strictFutureRefusalKeepsExactSourceAndExplicitCorrectionRetriesSameIds() {
        val row = finished(start = 101_000, finish = 103_000).copy(sets = listOf(finished().sets.single().copy(completedAtMs = 102_000)))
        engine().use { engine ->
            val imports = WorkoutImports(engine)
            imports.prepare(row)
            assertEquals(emptyList<Json>(), outbox(engine))
            assertEquals(listOf(ImportRefusal(row.session.id, row.session, row.sets, row.deleted, "bad-instant",
                WorkoutImports.reason("bad-instant"))), imports.refusals())
            val retained = sources(engine).single().member("source")
            imports.retry(row.session.id)
            assertEquals(retained, sources(engine).single().member("source"))
            imports.replaceAndRetry(row.session.id, finished())
            assertEquals(1, outbox(engine).size)
            assertEquals(retained, sources(engine).single().member("original"))
            assertEquals("queued", sources(engine).single().member("state").str())
            assertEquals("session01", engine.read(scope) { it.drawn("session", RecordID("session01")) }!!.id.string)
        }
    }

    // A signed-out workout started from a routine that was deleted before sign-in.
    @Test fun frozenPlanLineageRefusesMissingRoutineWithoutAlteration() {
        val row = finished().copy(session = finished().session.copy(routineId = "routine01",
            plan = PlanSnapshot("Original", listOf(PlanEntry("back-squat", listOf(SetTarget(5, 60.0)))))))
        engine().use { engine ->
            WorkoutImports(engine).prepare(row)
            val refusal = WorkoutImports(engine).refusals().single()
            assertEquals("frozen-plan-changed", refusal.code)
            assertEquals(row.session, refusal.session)
            assertEquals(row.sets, refusal.sets)
            assertEquals(emptyList<Json>(), outbox(engine))
        }
    }

    @Test fun refusalOfARoutineAtomicallyRetainsItsFoldedImportWithAVisibleRetryReason() = runBlocking {
        engine().use { engine ->
            val routine = EngineTraining(engine) { null }.createRoutine(RoutineWrite("routine01", "Original", 0,
                listOf(RoutineEntryWrite("back-squat", listOf(SetTarget(5, 60.0))))))
            val row = finished().copy(session = finished().session.copy(routineId = routine.id, plan = PlanSnapshot(routine)))
            WorkoutImports(engine).prepare(row)
            assertEquals(2, outbox(engine).size)
            engine.signIn("A", emptyMap())
            refuseNext(engine, "id-taken", at = 1)
            val refusal = WorkoutImports(engine).refusals().single()
            assertEquals("parent-dead", refusal.code)
            assertEquals(row.session, refusal.session)
            assertEquals(row.sets, refusal.sets)
            assertEquals(emptyList<Json>(), outbox(engine))
            assertEquals(1, engine.signOut().member("pending").long().toInt())
            engine(engine.snapshot()).use { reopened ->
                assertEquals(listOf(refusal), WorkoutImports(reopened).refusals())
            }
        }
    }

    @Test fun recoverableClockRefusalKeepsTheOriginalImportQueuedWithoutASecondSourceCount() {
        engine().use { engine ->
            WorkoutImports(engine).prepare(finished().copy(deleted = emptyList()))
            engine.signIn("A", emptyMap())
            val source = sources(engine).single().member("source")
            refuseNext(engine, "clock-skew")
            assertEquals("queued", sources(engine).single().member("state").str())
            assertEquals(source, sources(engine).single().member("source"))
            assertEquals(emptyList<ImportRefusal>(), WorkoutImports(engine).refusals())
            assertEquals("ready", outbox(engine).single().member("state").str())
            assertEquals(emptyMap<String, Json>(), engine.read(scope) { reader ->
                reader.devices(WorkoutImports.journalPrefix).values.single().member("count").obj()
            })
        }
    }

    @Test fun remoteStrictRefusalIsDurableAndRetriedWithNewGestureWithoutChangingSource() {
        val server = EngineRoomFixture.server()
        engine().use { engine ->
            WorkoutImports(engine).prepare(finished())
            engine.signIn("A", emptyMap())
            pull(engine, server)
            val request = engine.nextPush()!!
            server.refuse(code = "session-overlap")
            val reply = server.push(request, Credential.Account("A"), 100_000)
            val source = sources(engine).single().member("source")
            val priorGesture = sources(engine).single().member("gestureId")
            engine.onPushResponse(request, SyncResponse(reply.status, reply.body), timing)
            assertEquals("session-overlap", WorkoutImports(engine).refusals().single().code)
            assertEquals(source, sources(engine).single().member("source"))
            engine(engine.snapshot()).use { reopened ->
                assertEquals("session-overlap", WorkoutImports(reopened).refusals().single().code)
                WorkoutImports(reopened).retry("session01")
                assertNotEquals(priorGesture, sources(reopened).single().member("gestureId"))
                assertEquals(source, sources(reopened).single().member("source"))
                assertEquals(1, outbox(reopened).size)
            }
        }
    }

    @Test fun deletedSetResolutionRetainsItsOriginalTombstoneAndCannotReappearAfterRestart() {
        engine().use { engine ->
            WorkoutImports(engine).prepare(finished())
            val deletion = WorkoutImports(engine).deletedSets().single()
            assertEquals("session01", deletion.sessionId)
            assertEquals("deleted01", deletion.setId)
            WorkoutImports(engine).resolveDeletion(deletion.token)
            assertEquals(emptyList<ImportDeletion>(), WorkoutImports(engine).deletedSets())
            assertEquals(listOf(Json.of("deleted01")), sources(engine).single().member("source").member("deleted").arr())
            engine(engine.snapshot()).use { reopened ->
                assertEquals(emptyList<ImportDeletion>(), WorkoutImports(reopened).deletedSets())
                assertEquals(listOf(Json.of("deleted01")), sources(reopened).single().member("source").member("deleted").arr())
            }
        }
    }
}
