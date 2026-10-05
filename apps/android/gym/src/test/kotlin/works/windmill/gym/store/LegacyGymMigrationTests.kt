package works.windmill.gym.store

import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.api.CommitOutcome
import works.windmill.sync.core.ClockReading
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.*
import works.windmill.sync.schema.SyncSchema

class LegacyGymMigrationTests {
    @get:Rule val temporary = TemporaryFolder()
    private val scope = LegacyGymMigration.scope
    private fun engine(snapshot: Json? = null) = Engine.memory(SyncSchema.registry, snapshot,
        clock = object : EngineClock { override fun now() = 100_000L },
        commandResultWrites = LegacyGymMigration.commandResultWrites,
        pendingDeviceWork = LegacyGymMigration.pendingDeviceWork, rewriteDeviceValue = LegacyGymMigration.rewriteDeviceValue)
    private fun finished(id: String = "session01", start: Long = 1_000, finish: Long = 3_000) =
        LocalLog.FinishedSession(Session(id, start, finish), listOf(TrainingSet("set00001", "squat", weightKg = 60.0,
            reps = 5, completedAtMs = 2_000)), deleted = listOf("deleted01"))
    private fun shelf(row: LocalLog.FinishedSession, owner: String? = null) {
        LocalLog(File(temporary.root, LocalLog.fileName), owner).hold(row)
    }
    private fun outbox(engine: Engine): List<Json> = engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }
    private fun sources(engine: Engine) = engine.read(scope) { reader -> reader.devices(LegacyGymMigration.journalPrefix).values
        .flatMap { it.member("items").obj().values } }

    private fun pull(engine: Engine, server: ModelServer) {
        val request = engine.pullRequest(listOf(scope))!!
        val reply = server.pull(request, Credential.Account("A"), 100_000)
        assertEquals(200, reply.status)
        val reading = ClockReading(100_000, 100_000, "boot")
        engine.onPullResponse(request, SyncResponse(reply.status, reply.body), RequestTiming(reading, reading))
    }

    private fun push(engine: Engine, server: ModelServer) {
        while (true) {
            val request = engine.nextPush() ?: break
            val reply = server.push(request, Credential.Account("A"), 100_000)
            assertEquals(200, reply.status)
            val reading = ClockReading(100_000, 100_000, "boot")
            engine.onPushResponse(request, SyncResponse(reply.status, reply.body), RequestTiming(reading, reading))
            pull(engine, server)
        }
    }

    @Test fun aLostFinishReplyAdoptsOnlyItsExactlyMatchingConfirmedWorkoutWithoutReminting() = kotlinx.coroutines.runBlocking {
        val server = ModelServer(SyncSchema.registry, GymServerRules())
        val row = finished().copy(sets = listOf(finished().sets.single().copy(exerciseId = "exercise1")), deleted = emptyList())
        engine().use { remote ->
            remote.signIn("A", emptyMap()); pull(remote, server)
            val gym = EngineTraining(remote) { null }
            gym.createExercise(ExerciseWrite("exercise1", "Custom", "isolation", "machine"))
            gym.startSession(SessionStart(row.session.id, row.session.startedAtMs))
            val set = row.sets.single()
            gym.appendSet(row.session.id, SetWrite(set.id, set.exerciseId, set.weightKg, set.reps, set.kind, set.completedAtMs))
            gym.finishSession(row.session.id, row.session.finishedAtMs!!); push(remote, server)
        }
        shelf(row, "A")
        engine().use { local ->
            local.signIn("A", emptyMap()); pull(local, server)
            val original = local.read(scope) { it.confirmed("session", RecordID(row.session.id)) }!!
            LegacyGymMigration(temporary.root, local, "A").run()
            assertTrue(LegacyGymMigration.refusals(local).isEmpty()); assertTrue(outbox(local).isEmpty())
            assertEquals("admitted", sources(local).single().member("state").str())
            assertEquals(original, local.read(scope) { it.confirmed("session", RecordID(row.session.id)) })
            assertEquals(row, EngineTraining(local) { null }.details().single().let { LocalLog.FinishedSession(it.session, it.sets.map { set -> set.copy(setNumber = null) }) })
        }
    }

    @Test fun locallyHiddenExtraConfirmedSetsStillRefuseAnInexactLostReplyAdoption() = kotlinx.coroutines.runBlocking {
        val server = ModelServer(SyncSchema.registry, GymServerRules()); val row = finished().copy(sets = listOf(finished().sets.single().copy(exerciseId = "exercise1")), deleted = emptyList())
        engine().use { remote ->
            remote.signIn("A", emptyMap()); pull(remote, server); val gym = EngineTraining(remote) { null }
            gym.createExercise(ExerciseWrite("exercise1", "Custom", "isolation", "machine"))
            gym.startSession(SessionStart(row.session.id, row.session.startedAtMs))
            val set = row.sets.single()
            gym.appendSet(row.session.id, SetWrite(set.id, set.exerciseId, set.weightKg, set.reps, set.kind, set.completedAtMs))
            gym.appendSet(row.session.id, SetWrite("extra001", set.exerciseId, set.weightKg, set.reps, set.kind, 2_500))
            gym.finishSession(row.session.id, row.session.finishedAtMs!!); push(remote, server)
        }
        shelf(row, "A")
        engine().use { local ->
            local.signIn("A", emptyMap()); pull(local, server)
            EngineTraining(local) { null }.deleteSet(row.session.id, "extra001")
            assertFalse(local.read(scope) { it.drawn("set", RecordID("extra001")) }!!.isVisible)
            LegacyGymMigration(temporary.root, local, "A").run()
            assertEquals("session-id-taken", LegacyGymMigration.refusals(local).single().code)
            assertEquals(row.sets, LegacyGymMigration.refusals(local).single().sets)
            assertEquals(1, outbox(local).size)
        }
    }

    @Test fun ownedCachedHistoryWaitsForRealBornDependenciesThenImportsItsExactFrozenPlanAutomatically() = kotlinx.coroutines.runBlocking {
        val server = ModelServer(SyncSchema.registry, GymServerRules())
        lateinit var routine: Routine
        lateinit var exercise: Exercise
        engine().use { remote ->
            val gym = EngineTraining(remote) { null }
            exercise = gym.createExercise(ExerciseWrite("exercise1", "Custom", "isolation", "machine"))
            routine = gym.createRoutine(RoutineWrite("routine01", "Original", 0, entries = listOf(RoutineEntryWrite(exercise.id, listOf(SetTarget(5, 60.0))))))
            remote.signIn("A", emptyMap()); push(remote, server)
        }
        val row = finished().copy(session = finished().session.copy(routineId = routine.id, plan = PlanSnapshot(routine)),
            sets = listOf(finished().sets.single().copy(exerciseId = exercise.id)), deleted = emptyList())
        shelf(row, "A")
        val copy = DeviceCopy(File(temporary.root, DeviceCopy.fileName)); copy.hold("A", listOf(exercise)); copy.holdRoutines("A", listOf(routine))
        engine().use { local ->
            LegacyGymMigration(temporary.root, local, "A").run()
            assertTrue(outbox(local).isEmpty()); assertTrue(LegacyGymMigration.refusals(local).isEmpty())
            assertEquals(listOf(row), LegacyGymMigration.pendingFinished(local))
            engine(local.snapshot()).use { deleted ->
                val original = sources(deleted).first { it["kind"] == Json.of("finished") }.member("source")
                LegacyGymMigration.discardRefusal(deleted, row.session.id); pull(deleted, server); LegacyGymMigration.reconcileConfirmed(deleted)
                assertTrue(LegacyGymMigration.pendingFinished(deleted).isEmpty()); assertTrue(outbox(deleted).isEmpty())
                assertEquals(original, sources(deleted).first { it["kind"] == Json.of("finished") }.member("source"))
            }
            local.read(scope) { assertNull(it.stored("exercise", RecordID(exercise.id))); assertNull(it.stored("routine", RecordID(routine.id))) }
            pull(local, server); val before = local.read(scope) { it.confirmed("routine", RecordID(routine.id))!! }
            local.failNextCommit(); assertThrows(CommitFailure::class.java) { LegacyGymMigration.reconcileConfirmed(local) }
            assertEquals(listOf(row), LegacyGymMigration.pendingFinished(local)); assertTrue(outbox(local).isEmpty())
            LegacyGymMigration.reconcileConfirmed(local)
            assertTrue(LegacyGymMigration.pendingFinished(local).isEmpty()); assertEquals(1, outbox(local).size)
            LegacyGymMigration.reconcileConfirmed(local)
            assertTrue(LegacyGymMigration.refusals(local).isEmpty()); assertEquals(1, outbox(local).size)
            val prerequisite = outbox(local).single().member("intent").member("d").arr().single()
            assertEquals("routine", prerequisite.member("t").str()); assertEquals(before.born!!.json, prerequisite.member("born")); assertNull(prerequisite["f"])
            engine(local.snapshot()).use { reopened -> assertEquals(outbox(local), outbox(reopened)) }
            assertEquals("gym.importSession", outbox(local).single().member("intent").member("cmd").member("name").str())
            push(local, server)
            assertEquals(before, local.read(scope) { it.confirmed("routine", RecordID(routine.id))!! })
            val actual = EngineTraining(local) { null }.session(row.session.id)!!
            assertEquals(row.session, actual.session); assertEquals(row.sets.map { it.copy(setNumber = 1) }, actual.sets)
        }
    }

    @Test fun futureAuthoredFieldsStayUpdateOnlyAndCannotDisappearDuringAnUnrelatedEdit() {
        shelf(finished().copy(deleted = emptyList())); val file = File(temporary.root, LocalLog.fileName)
        file.writeText(file.readText().replace("\"startedAt\":1000", "\"startedAt\":1000,\"futureLineage\":\"exact\""))
        val original = file.readText()
        engine().use { e ->
            LegacyGymMigration(temporary.root, e).run(); val saved = sources(e).single().member("source")
            assertEquals("source-needs-update", LegacyGymMigration.refusals(e).single().code)
            assertThrows(IllegalStateException::class.java) { LegacyGymMigration.replaceAndRetry(e, "session01", finished().copy(deleted = emptyList())) }
            assertEquals(saved, sources(e).single().member("source")); assertTrue(outbox(e).isEmpty()); assertEquals(original, file.readText())
        }
    }

    @Test fun aRoutineChangedBetweenEnqueueAndAdmissionRefusesInsteadOfChangingTheFrozenPlan() = kotlinx.coroutines.runBlocking {
        val server = ModelServer(SyncSchema.registry, GymServerRules())
        engine().use { remote ->
            val gym = EngineTraining(remote) { null }
            val exercise = gym.createExercise(ExerciseWrite("exercise1", "Custom", "isolation", "machine"))
            val routine = gym.createRoutine(RoutineWrite("routine01", "Original", 0, entries = listOf(RoutineEntryWrite(exercise.id, listOf(SetTarget(5, 60.0))))))
            remote.signIn("A", emptyMap()); push(remote, server)
            val row = finished().copy(session = finished().session.copy(routineId = routine.id, plan = PlanSnapshot(routine)),
                sets = listOf(finished().sets.single().copy(exerciseId = exercise.id)), deleted = emptyList())
            shelf(row, "A")
            engine().use { local ->
                LegacyGymMigration(temporary.root, local, "A").run(); pull(local, server); LegacyGymMigration.reconcileConfirmed(local)
                val original = sources(local).first { it["kind"] == Json.of("finished") }.member("source")
                assertEquals(2, outbox(local).single().member("intent").member("guard").arr().size)
                gym.replaceRoutine(routine.id, RoutineWrite(gym.routine(routine.id)!!).copy(name = "Changed")); push(remote, server)
                push(local, server)
                val refusal = LegacyGymMigration.refusals(local).single()
                assertEquals("stale", refusal.code); assertEquals(row.session, refusal.session); assertEquals(row.sets, refusal.sets)
                assertEquals(original, sources(local).first { it["kind"] == Json.of("finished") }.member("source"))
                assertNull(local.read(scope) { it.confirmed("session", RecordID(row.session.id)) })
            }
        }
    }

    @Test fun aRoutineDeletedBetweenEnqueueAndAdmissionRefusesTheWholeImportWithoutResurrectingIt() = kotlinx.coroutines.runBlocking {
        val server = ModelServer(SyncSchema.registry, GymServerRules())
        engine().use { remote ->
            val gym = EngineTraining(remote) { null }
            val exercise = gym.createExercise(ExerciseWrite("exercise1", "Custom", "isolation", "machine"))
            val routine = gym.createRoutine(RoutineWrite("routine01", "Original", 0, entries = listOf(RoutineEntryWrite(exercise.id, listOf(SetTarget(5, 60.0))))))
            remote.signIn("A", emptyMap()); push(remote, server)
            val row = finished().copy(session = finished().session.copy(routineId = routine.id, plan = PlanSnapshot(routine)),
                sets = listOf(finished().sets.single().copy(exerciseId = exercise.id)), deleted = emptyList())
            shelf(row, "A")
            engine().use { local ->
                LegacyGymMigration(temporary.root, local, "A").run(); pull(local, server); LegacyGymMigration.reconcileConfirmed(local)
                val original = sources(local).first { it["kind"] == Json.of("finished") }.member("source")
                gym.deleteRoutine(routine.id); remote.releaseHeld(true); push(remote, server)
                assertFalse(remote.read(scope) { it.confirmed("routine", RecordID(routine.id)) }?.isVisible == true)
                push(local, server)
                val refusal = LegacyGymMigration.refusals(local).single()
                assertEquals("record-dead", refusal.code); assertEquals(row.session, refusal.session); assertEquals(row.sets, refusal.sets)
                assertEquals(original, sources(local).first { it["kind"] == Json.of("finished") }.member("source"))
                assertNull(local.read(scope) { it.confirmed("session", RecordID(row.session.id)) })
                assertTrue(server.state.rows["acct:A/gym"]!!.values.none { record -> record["t"] == Json.of("routine") && record["life"]?.arr()?.firstOrNull() == Json.of("alive") })
            }
        }
    }

    @Test fun anUnknownLocalBornPrerequisiteCannotPartiallyWriteTheCommandOrItsDeviceJournal() {
        engine().use { e ->
            val before = e.snapshot()
            assertThrows(CommitFailure::class.java) { e.commitLegacy(scope) {
                works.windmill.sync.api.Gesture(listOf(works.windmill.sync.api.Change.update("routine", RecordID("unknown1"))),
                    command = works.windmill.sync.api.Command("gym.start", Json.objectOf("id" to Json.of("session01"), "startedAt" to Json.of(1_000))),
                    local = listOf(works.windmill.sync.api.DeviceWrite("rack:legacyMigrationunknown", Json.of("original source")))) to Unit
            } }
            assertEquals(before, e.snapshot()); assertTrue(outbox(e).isEmpty())
        }
    }

    @Test fun unknownLiveSetKindsRemainRawUntilAnExplicitKindChoicePreservingAttempts() {
        val q = SetQueue(File(temporary.root, SetQueue.fileName)); q.hold(Session("session01", 1_000), true)
        q.store(finished().sets.single(), "session01", true); q.sending(q.pending.single())
        val file = File(temporary.root, SetQueue.fileName); file.writeText(file.readText().replace("\"reps\":5", "\"kind\":\"future-kind\",\"reps\":5"))
        engine().use { e ->
            LegacyGymMigration(temporary.root, e).run()
            assertEquals(setOf("session01", "set00001"), LegacyGymMigration.refusals(e).map { it.id }.toSet())
            assertTrue(LegacyGymMigration.cached(e, "start").isEmpty()); assertTrue(LegacyGymMigration.operations(e).isEmpty()); assertTrue(outbox(e).isEmpty())
            val original = sources(e).first { it["kind"] == Json.of("start") }.member("source")
            LegacyGymMigration.replaceStartAndRetry(e, "session01", Session("session01", 1_000), mapOf("set00001" to SetKind.Working))
            assertTrue(LegacyGymMigration.refusals(e).isEmpty()); assertTrue(LegacyGymMigration.operations(e).single().entry.attempted)
            assertEquals(original, sources(e).first { it["kind"] == Json.of("start") }.member("original"))
        }
    }

    @Test fun anExplicitNumberingGapIsRetainedUntilThePersonRenumbersItsSets() {
        val row = finished().copy(sets = listOf(finished().sets.single().copy(setNumber = 2)))
        shelf(row)
        engine().use { e -> LegacyGymMigration(temporary.root, e).run()
            assertEquals("source-numbering", LegacyGymMigration.refusals(e).single().code)
            assertEquals(2, LegacyGymMigration.refusals(e).single().sets.single().setNumber)
            val original = sources(e).single().member("source")
            LegacyGymMigration.replaceAndRetry(e, row.session.id, row.copy(sets = row.sets.map { it.copy(setNumber = 1) }))
            LegacyGymMigration.retry(e, row.session.id)
            assertEquals(1, outbox(e).size); assertEquals(original, sources(e).single().member("original"))
        }
    }

    @Test fun explicitContiguousNumbersAreCheckedIndependentlyForEachMovement() {
        val row = finished().copy(sets = listOf(finished().sets.single().copy(setNumber = 1),
            finished().sets.single().copy(id = "set00002", exerciseId = "bench-press", setNumber = 1),
            finished().sets.single().copy(id = "set00003", setNumber = 2)))
        shelf(row)
        engine().use { e -> LegacyGymMigration(temporary.root, e).run()
            assertTrue(LegacyGymMigration.refusals(e).isEmpty()); assertEquals(1, outbox(e).size)
        }
    }

    @Test fun aDrawnWorkoutWithTheSameIdNeverSilentlyAcceptsDifferentHistory() {
        val row = finished(); shelf(row)
        engine().use { e ->
            kotlinx.coroutines.runBlocking {
                val gym = EngineTraining(e) { null }
                gym.startSession(SessionStart(row.session.id, 100)); gym.finishSession(row.session.id, 500)
            }
            LegacyGymMigration(temporary.root, e).run()
            val refusal = LegacyGymMigration.refusals(e).single()
            assertEquals("session-id-taken", refusal.code); assertEquals(row.session, refusal.session); assertEquals(row.sets, refusal.sets)
            assertEquals(Json.of(100), e.read(scope) { it.drawn("session", RecordID(row.session.id)) }!!.values.getValue("startedAt"))
            assertEquals(2, outbox(e).size)
        }
    }

    @Test fun approvedIdenticalPayloadsKeepBothOriginalSeatLineagesInsteadOfCoalescingTheirMarkers() {
        val row = finished().copy(deleted = emptyList()); shelf(row)
        val file = File(temporary.root, LocalLog.fileName)
        val shelf = Json.parse(file.readText()).member("shelves").member("anon")
        file.writeText(Json.objectOf("shelves" to Json.objectOf(Seat.anonymous to shelf, Seat.quarantine to shelf)).jcs)
        val log = LocalLog(file)
        legacyConsent(temporary.root, ClaimConsent.Approved(ClaimBatch("batch01", log.claimItems()), "A"))
        engine().use { e -> e.signIn("A", emptyMap()); pull(e, ModelServer(SyncSchema.registry, GymServerRules())); LegacyGymMigration(temporary.root, e).run()
            val histories = sources(e).filter { it["kind"] == Json.of("finished") }
            assertEquals(2, histories.size); assertEquals(setOf(Seat.anonymous, Seat.quarantine), histories.map { it.member("sourceSeat").str() }.toSet())
            assertTrue(histories.all { it.member("source") == histories.first().member("source") })
            assertEquals("session-id-taken", LegacyGymMigration.refusals(e).single().code)
            LegacyGymMigration.retry(e, row.session.id)
            assertEquals(1, outbox(e).size); assertEquals("session-id-taken", LegacyGymMigration.refusals(e).single().code)
        }
    }

    @Test fun anUnrecognizedLegacySeatNeverBecomesAnonymousTrainingWithoutAVerifiedOwnerDecision() {
        val row = finished(); shelf(row)
        val file = File(temporary.root, LocalLog.fileName)
        file.writeText(file.readText().replace("\"anon\":", "\"unknown-seat\":"))
        val original = file.readText()
        engine().use { e ->
            LegacyGymMigration(temporary.root, e).run()
            assertEquals("identity-unresolved", LegacyGymMigration.refusals(e).single().code)
            assertEquals(row.session, LegacyGymMigration.refusals(e).single().session)
            assertEquals("unknown-seat", sources(e).single().member("sourceSeat").str())
            assertThrows(IllegalStateException::class.java) { LegacyGymMigration.retry(e, row.session.id) }
            assertTrue(outbox(e).isEmpty()); assertEquals(original, file.readText())
        }
    }

    @Test fun unrelatedTypedEditsCannotDropUnknownSetKindsOrAutomaticClosureMarkers() {
        shelf(finished().copy(deleted = emptyList()))
        val file = File(temporary.root, LocalLog.fileName)
        file.writeText(file.readText().replace("\"startedAt\":1000", "\"startedAt\":1000,\"closedItself\":true")
            .replace("\"reps\":5", "\"kind\":\"future-kind\",\"reps\":5"))
        val originalFile = file.readText()
        engine().use { e -> LegacyGymMigration(temporary.root, e).run()
            val original = sources(e).single().member("source")
            assertEquals(listOf("set00001"), LegacyGymMigration.refusals(e).single().unrecognizedKindSetIds)
            val corrected = finished().copy(sets = listOf(finished().sets.single().copy(weightKg = 65.0)), deleted = emptyList())
            LegacyGymMigration.replaceAndRetry(e, "session01", corrected)
            assertEquals("source-kind", LegacyGymMigration.refusals(e).single().code)
            assertEquals(Json.of("future-kind"), sources(e).single().member("source").member("sets").arr().single().member("kind"))
            assertEquals(Json.of(true), sources(e).single().member("source").member("session").member("closedItself"))
            LegacyGymMigration.replaceAndRetry(e, "session01", corrected, correctedKinds = setOf("set00001"))
            assertEquals("source-auto-closed", LegacyGymMigration.refusals(e).single().code)
            LegacyGymMigration.replaceAndRetry(e, "session01", corrected, markFinished = true, correctedKinds = setOf("set00001"))
            assertTrue(LegacyGymMigration.refusals(e).isEmpty()); assertEquals(1, outbox(e).size)
            assertEquals(original, sources(e).single().member("original")); assertEquals(originalFile, file.readText())
        }
    }

    @Test fun anUnverifiedLiveWorkoutCannotRetryAnonymouslyButItsAccountRetryKeepsAttemptedChildren() {
        val queue = SetQueue(File(temporary.root, SetQueue.fileName))
        queue.hold(Session("session01", 1_000), true); queue.store(finished().sets.single(), "session01", true); queue.sending(queue.pending.single())
        val file = File(temporary.root, SetQueue.fileName)
        val tree = Json.parse(file.readText()).member("queues").member("anon")
        file.writeText(tree.jcs)
        engine().use { e -> LegacyGymMigration(temporary.root, e).run()
            assertEquals(Session("session01", 1_000), LegacyGymMigration.refusals(e).first { it.id == "session01" }.session)
            assertThrows(IllegalStateException::class.java) { LegacyGymMigration.retry(e, "session01") }
            assertTrue(outbox(e).isEmpty()); assertTrue(LegacyGymMigration.operations(e).isEmpty())
            e.signIn("A", emptyMap()); LegacyGymMigration.retry(e, "session01")
            assertTrue(outbox(e).single().member("intent").member("cmd").member("args").member("joinOpenSession").bool())
            assertTrue(LegacyGymMigration.operations(e).single().entry.attempted)
            assertEquals("set00001", LegacyGymMigration.operations(e).single().entry.set.id)
        }
    }

    @Test fun anExplicitRefusalDiscardSurvivesReopenAndLeavesItsOriginalArchiveOnThePhone() {
        shelf(finished(start = 101_000, finish = 103_000))
        engine().use { e -> LegacyGymMigration(temporary.root, e).run(); val original = sources(e).single().member("source")
            LegacyGymMigration.discardRefusal(e, "session01")
            engine(e.snapshot()).use { reopened -> LegacyGymMigration(temporary.root, reopened).run()
                assertTrue(LegacyGymMigration.refusals(reopened).isEmpty()); assertTrue(LegacyGymMigration.deletedSets(reopened).isEmpty())
                assertEquals(original, sources(reopened).single().member("source")); assertEquals("discarded", sources(reopened).single().member("state").str())
            }
        }
    }

    @Test fun deferredOfflineCacheEditsRetainTheirFirstBaseAndCountAsRealPendingWork() {
        engine().use { e -> e.signIn("A", emptyMap())
            val base = Json.objectOf("id" to Json.of("routine01"), "name" to Json.of("Before"), "revision" to Json.of(3))
            val changed = Json.objectOf("id" to Json.of("routine01"), "name" to Json.of("After"), "revision" to Json.of(3))
            LegacyGymMigration.deferEdit(e, "routine", "routine01", changed, base)
            LegacyGymMigration.deferEdit(e, "routine", "routine01", null, changed)
            val edit = LegacyGymMigration.edits(e).single(); assertEquals(base, edit.base); assertNull(edit.source)
            assertEquals(1L, e.signOut().member("pending").long())
            e.failNextCommit(); assertThrows(CommitFailure::class.java) { LegacyGymMigration.resolveEdit(e, edit.token) }
            assertEquals(listOf(edit), LegacyGymMigration.edits(e)); LegacyGymMigration.refuseEdit(e, edit.token, "routine-changed")
            assertEquals("routine01", LegacyGymMigration.refusals(e).single().id)
            LegacyGymMigration.retry(e, "routine01"); assertEquals(edit, LegacyGymMigration.edits(e).single())
        }
    }

    @Test fun anExplicitLiveStartCorrectionKeepsItsAttemptedChildrenAndUnmodifiedOriginalSource() {
        val q = SetQueue(File(temporary.root, SetQueue.fileName)); val session = Session("session01", 1_000, routineId = "routine01")
        q.hold(session, true); q.store(finished().sets.single(), session.id, true); q.sending(q.pending.single())
        engine().use { e -> LegacyGymMigration(temporary.root, e).run(); val original = sources(e).first { it["kind"] == Json.of("start") }.member("source")
            e.signIn("A", emptyMap()); val request = e.nextPush()!!; val n = request.member("intents").arr().single().member("n")
            val reading = ClockReading(100_000, 100_000, "boot")
            e.onPushResponse(request, SyncResponse(200, Json.objectOf("epoch" to Json.of("ep-1"), "as" to Json.of("A"), "lastN" to n,
                "results" to Json.array(Json.objectOf("n" to n, "s" to Json.of("refused"), "code" to Json.of("routine-missing"))))), RequestTiming(reading, reading))
            val attempted = LegacyGymMigration.operations(e).single()
            LegacyGymMigration.replaceStartAndRetry(e, session.id, session.copy(startedAtMs = 900, routineId = null))
            val saved = sources(e).first { it["kind"] == Json.of("start") }
            assertEquals(original, saved.member("original")); assertEquals(original.member("entries"), saved.member("source").member("entries"))
            assertEquals(attempted, LegacyGymMigration.operations(e).single()); assertTrue(outbox(e).single().member("intent").member("cmd").member("args").member("joinOpenSession").bool())
        }
    }

    @Test fun discardingARefusedLiveStartAlsoRetainsButStopsItsAttemptedChildren() {
        val q = SetQueue(File(temporary.root, SetQueue.fileName)); q.hold(Session("session01", 1_000), true)
        q.store(finished().sets.single(), "session01", true); q.sending(q.pending.single())
        val file = File(temporary.root, SetQueue.fileName); file.writeText(Json.parse(file.readText()).member("queues").member("anon").jcs)
        engine().use { e -> LegacyGymMigration(temporary.root, e).run(); val original = sources(e).first { it["kind"] == Json.of("operation") }.member("source")
            LegacyGymMigration.discardRefusal(e, "session01")
            assertTrue(LegacyGymMigration.operations(e).isEmpty()); assertTrue(LegacyGymMigration.refusals(e).isEmpty())
            assertEquals(original, sources(e).first { it["kind"] == Json.of("operation") }.member("source"))
            e.signIn("A", emptyMap()); assertTrue(outbox(e).isEmpty())
        }
    }

    @Test fun crashAfterDurableImportResumesWithoutDuplicateAndKeepsSourceAndDeletedIds() {
        val row = finished()
        shelf(row)
        val legacy = File(temporary.root, LocalLog.fileName).readText()
        val first = engine()
        first.crashAfterTransactions(1)
        assertThrows(EngineCrash::class.java) { LegacyGymMigration(temporary.root, first).run() }
        val durable = first.snapshot()
        first.close()
        engine(durable).use { reopened ->
            LegacyGymMigration(temporary.root, reopened).run()
            LegacyGymMigration(temporary.root, reopened).run()
            assertEquals(1, outbox(reopened).size)
            val command = outbox(reopened).single().member("intent").member("cmd")
            assertEquals("gym.importSession", command.member("name").str())
            assertEquals(Json.of("session01"), command.member("args").member("id"))
            assertEquals(Json.of("set00001"), command.member("args").member("sets").arr().single().member("id"))
            assertEquals(listOf(Json.of("deleted01")), sources(reopened).single().member("source").member("deleted").arr())
            assertEquals(legacy, File(temporary.root, LocalLog.fileName).readText())
            assertTrue(File(temporary.root, LegacyGymMigration.archiveName).exists())
        }
    }

    @Test fun failedEngineTransactionLeavesNoMarkerAndResumeImportsExactlyOnce() {
        shelf(finished())
        engine().use { engine ->
            val before = engine.snapshot()
            engine.failNextCommit()
            assertThrows(CommitFailure::class.java) { LegacyGymMigration(temporary.root, engine).run() }
            assertEquals(before, engine.snapshot())
            LegacyGymMigration(temporary.root, engine).run()
            assertEquals(1, outbox(engine).size)
            assertEquals(1, sources(engine).size)
        }
    }

    @Test fun strictFutureRefusalKeepsExactSourceAndExplicitCorrectionRetriesSameIds() {
        val row = finished(start = 101_000, finish = 103_000).copy(sets = listOf(finished().sets.single().copy(completedAtMs = 102_000)))
        shelf(row)
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            assertEquals(emptyList<Json>(), outbox(engine))
            assertEquals(listOf(LegacyMigrationRefusal(row.session.id, row.session, row.sets, row.deleted, "bad-instant",
                LegacyGymMigration.reason("bad-instant"))), LegacyGymMigration.refusals(engine))
            val retained = sources(engine).single().member("source")
            LegacyGymMigration.retry(engine, row.session.id)
            assertEquals(retained, sources(engine).single().member("source"))
            val fixed = finished()
            LegacyGymMigration.replaceAndRetry(engine, row.session.id, fixed)
            assertEquals(1, outbox(engine).size)
            assertEquals(retained, sources(engine).single().member("original"))
            assertEquals("queued", sources(engine).single().member("state").str())
            assertEquals("session01", engine.read(scope) { it.drawn("session", RecordID("session01")) }!!.id.string)
        }
    }

    @Test fun frozenPlanLineageRefusesMissingRoutineWithoutAlteration() {
        val row = finished().copy(session = finished().session.copy(routineId = "routine01",
            plan = PlanSnapshot("Original", listOf(PlanEntry("squat", listOf(SetTarget(5, 60.0)))))))
        shelf(row)
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            val refusal = LegacyGymMigration.refusals(engine).single()
            assertEquals("frozen-plan-changed", refusal.code)
            assertEquals(row.session, refusal.session)
            assertEquals(row.sets, refusal.sets)
            assertEquals(emptyList<Json>(), outbox(engine))
        }
    }

    @Test fun missingFrozenPlanCannotAcquireTodaysRoutinePlanDuringMigration() {
        val log = LocalLog(File(temporary.root, LocalLog.fileName))
        log.hold(Routine("routine01", "Today", entries = listOf(RoutineEntry(exerciseId = "squat", sets = listOf(SetTarget(5, 60.0))))))
        val row = finished().copy(session = finished().session.copy(routineId = "routine01", plan = null))
        log.hold(row)
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            assertEquals("frozen-plan-changed", LegacyGymMigration.refusals(engine).single().code)
            assertEquals(null, LegacyGymMigration.refusals(engine).single().session!!.plan)
            assertEquals(1, outbox(engine).size)
            assertNull(outbox(engine).single().member("intent")["cmd"])
        }
    }

    @Test fun unknownSavedSetKindIsRetainedAndRefusedInsteadOfBeingRewrittenAsWorking() {
        shelf(finished())
        val file = File(temporary.root, LocalLog.fileName)
        file.writeText(file.readText().replace("\"reps\":5", "\"kind\":\"future-kind\",\"reps\":5"))
        val raw = Json.parse(file.readText()).member("shelves").member("anon").member("finished").arr().single()
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            assertEquals("source-kind", LegacyGymMigration.refusals(engine).single().code)
            assertEquals(raw, sources(engine).single().member("source"))
            assertEquals(emptyList<Json>(), outbox(engine))
        }
    }

    @Test fun attemptedAppendWithCorrectionAndAttemptedDeleteKeepAllMetadataInOwnerReplica() {
        val queue = SetQueue(File(temporary.root, SetQueue.fileName), "A")
        queue.hold(Session("session01", 1_000), unclaimed = true)
        val set = finished().sets.single()
        queue.store(set, "session01", needsPush = true)
        val attempted = queue.sending(queue.pending.single())
        queue.fix(set.copy(weightKg = 65.0))
        val second = set.copy(id = "set00002")
        queue.store(second, "session01", needsPush = true)
        queue.sending(queue.pending.first { it.set.id == second.id })
        queue.delete(second.id)
        val expected = queue.pending
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine, "A").run()
            assertEquals("A", engine.snapshot().member("replicas").arr().first { it.member("meta").member("replica").str() == engine.activeReplica() }
                .member("meta").member("account").str())
            assertEquals(expected.sortedBy { it.set.id }, LegacyGymMigration.operations(engine).map { it.entry }.sortedBy { it.set.id })
            assertTrue(LegacyGymMigration.operations(engine).all { it.entry.attempted })
            assertEquals(Owed.Fix, LegacyGymMigration.operations(engine).first { it.entry.set.id == attempted.set.id }.entry.write)
            assertEquals(Owed.Delete, LegacyGymMigration.operations(engine).first { it.entry.set.id == second.id }.entry.write)
            assertEquals(null, engine.read(scope) { it.drawn("set", RecordID("set00001")) })
            val start = outbox(engine).single().member("intent").member("cmd")
            assertEquals("gym.start", start.member("name").str())
            assertTrue(start.member("args").member("joinOpenSession").bool())
        }
    }

    @Test fun joiningAnExistingWorkoutRewritesTargetsAtomicallyWhileKeepingOriginalAttemptedPayload() {
        val queue = SetQueue(File(temporary.root, SetQueue.fileName))
        queue.hold(Session("session01", 1_000), unclaimed = true)
        queue.store(finished().sets.single(), "session01", needsPush = true)
        queue.sending(queue.pending.single())
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            val original = LegacyGymMigration.operations(engine).single().entry
            engine.signIn("A", emptyMap())
            val request = engine.nextPush()!!
            val n = request.member("intents").arr().single().member("n")
            val timing = RequestTiming(ClockReading(100_000, 100_000, "boot"), ClockReading(100_000, 100_000, "boot"))
            val result = Json.objectOf("n" to n, "s" to Json.of("ok"), "seq" to Json.of(1), "write" to Json.array(Json.objectOf(
                "t" to Json.of("session"), "id" to Json.of("existing1"), "from" to Json.of("session01"), "f" to Json.objectOf())))
            engine.onPushResponse(request, SyncResponse(200, Json.objectOf("epoch" to Json.of("ep-1"), "as" to Json.of("A"), "lastN" to n,
                "results" to Json.array(result))), timing)
            assertEquals("existing1", LegacyGymMigration.operations(engine).single().sessionId)
            assertEquals(original, LegacyGymMigration.operations(engine).single().entry)
            assertEquals("existing1", LegacyGymMigration.cached(engine, "start").single().member("session").member("id").str())
            assertEquals("session01", LegacyGymMigration.sourceSessionId(engine, "existing1"))
            assertEquals("session01", sources(engine).first { it["kind"] == Json.of("start") }.member("source").member("session").member("id").str())
            engine(engine.snapshot()).use { reopened ->
                assertEquals("existing1", LegacyGymMigration.operations(reopened).single().sessionId)
                assertEquals(original, LegacyGymMigration.operations(reopened).single().entry)
            }
        }
    }

    @Test fun refusalOfARoutineAtomicallyRetainsItsFoldedImportWithAVisibleRetryReason() {
        val log = LocalLog(File(temporary.root, LocalLog.fileName))
        val routine = Routine("routine01", "Original", entries = listOf(RoutineEntry(exerciseId = "squat", sets = listOf(SetTarget(5, 60.0)))))
        log.hold(routine)
        val row = finished().copy(session = finished().session.copy(routineId = routine.id,
            plan = PlanSnapshot("Original", listOf(PlanEntry("squat", listOf(SetTarget(5, 60.0)))))))
        log.hold(row)
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            assertEquals(2, outbox(engine).size)
            engine.signIn("A", emptyMap())
            val request = engine.nextPush(1)!!
            val n = request.member("intents").arr().single().member("n")
            val timing = RequestTiming(ClockReading(100_000, 100_000, "boot"), ClockReading(100_000, 100_000, "boot"))
            engine.onPushResponse(request, SyncResponse(200, Json.objectOf("epoch" to Json.of("ep-1"), "as" to Json.of("A"), "lastN" to n,
                "results" to Json.array(Json.objectOf("n" to n, "s" to Json.of("refused"), "code" to Json.of("id-taken"))))), timing)
            val refusal = LegacyGymMigration.refusals(engine).single()
            assertEquals("parent-dead", refusal.code)
            assertEquals(row.session, refusal.session)
            assertEquals(row.sets, refusal.sets)
            assertEquals(emptyList<Json>(), outbox(engine))
            assertEquals(1, engine.signOut().member("pending").long().toInt())
            engine(engine.snapshot()).use { reopened ->
                assertEquals(listOf(refusal), LegacyGymMigration.refusals(reopened))
            }
        }
    }

    @Test fun recoverableClockRefusalKeepsTheOriginalImportQueuedWithoutASecondSourceCount() {
        shelf(finished().copy(deleted = emptyList()))
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            engine.signIn("A", emptyMap())
            val request = engine.nextPush()!!
            val n = request.member("intents").arr().single().member("n")
            val timing = RequestTiming(ClockReading(100_000, 100_000, "boot"), ClockReading(100_000, 100_000, "boot"))
            val source = sources(engine).single().member("source")
            engine.onPushResponse(request, SyncResponse(200, Json.objectOf("epoch" to Json.of("ep-1"), "as" to Json.of("A"), "lastN" to n,
                "results" to Json.array(Json.objectOf("n" to n, "s" to Json.of("refused"), "code" to Json.of("clock-skew"))))), timing)
            assertEquals("queued", sources(engine).single().member("state").str())
            assertEquals(source, sources(engine).single().member("source"))
            assertEquals(emptyList<LegacyMigrationRefusal>(), LegacyGymMigration.refusals(engine))
            assertEquals("ready", outbox(engine).single().member("state").str())
            assertEquals(emptyMap<String, Json>(), sources(engine).single().let { engine.read(scope) { reader ->
                reader.devices(LegacyGymMigration.journalPrefix).values.single().member("count").obj()
            } })
        }
    }

    @Test fun remoteStrictRefusalIsDurableAndRetriedWithNewGestureWithoutChangingSource() {
        shelf(finished())
        val server = ModelServer(SyncSchema.registry, GymServerRules())
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            engine.signIn("A", emptyMap())
            pull(engine, server)
            val request = engine.nextPush()!!
            val timing = RequestTiming(ClockReading(100_000, 100_000, "boot"), ClockReading(100_000, 100_000, "boot"))
            server.refuse(code = "session-overlap")
            val reply = server.push(request, Credential.Account("A"), 100_000)
            val response = SyncResponse(reply.status, reply.body)
            val source = sources(engine).single().member("source")
            val priorGesture = sources(engine).single().member("gestureId")
            engine.onPushResponse(request, response, timing)
            assertEquals("session-overlap", LegacyGymMigration.refusals(engine).single().code)
            assertEquals(source, sources(engine).single().member("source"))
            val snapshot = engine.snapshot()
            engine(snapshot).use { reopened ->
                assertEquals("session-overlap", LegacyGymMigration.refusals(reopened).single().code)
                LegacyGymMigration.retry(reopened, "session01")
                assertNotEquals(priorGesture, sources(reopened).single().member("gestureId"))
                assertEquals(source, sources(reopened).single().member("source"))
                assertEquals(1, outbox(reopened).size)
            }
        }
    }

    @Test fun deletedSetResolutionRetainsItsOriginalTombstoneAndCannotReappearAfterRestart() {
        shelf(finished())
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            val deletion = LegacyGymMigration.deletedSets(engine).single()
            assertEquals("session01", deletion.sessionId)
            assertEquals("deleted01", deletion.setId)
            LegacyGymMigration.resolveDeletion(engine, deletion.token)
            assertEquals(emptyList<LegacyDeletedSet>(), LegacyGymMigration.deletedSets(engine))
            assertEquals(listOf(Json.of("deleted01")), sources(engine).single().member("source").member("deleted").arr())
            engine(engine.snapshot()).use { reopened ->
                LegacyGymMigration(temporary.root, reopened).run()
                assertEquals(emptyList<LegacyDeletedSet>(), LegacyGymMigration.deletedSets(reopened))
                assertEquals(listOf(Json.of("deleted01")), sources(reopened).single().member("source").member("deleted").arr())
            }
        }
    }

    @Test fun approvedFrozenConsentKeepsItsExactWorkoutUnderTheApprovedAccount() {
        val row = finished()
        val log = LocalLog(File(temporary.root, LocalLog.fileName))
        log.hold(row)
        val batch = ClaimBatch("batch0001", log.claimItems())
        legacyConsent(temporary.root, ClaimConsent.Approved(batch, "B"))
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            assertEquals(emptyList<Json>(), outbox(engine).filter { it.member("lineage") == Json.of("anon") })
            assertTrue(outbox(engine).isEmpty())
            assertEquals("B", engine.dormantReplicas().single().account)
            engine.signIn("B", emptyMap())
            assertEquals(listOf(row), LegacyGymMigration.pendingFinished(engine))
            assertEquals("u.B", sources(engine).first { it["kind"] == Json.of("finished") }.member("seat").str())
        }
    }

    @Test fun previouslyAuthorizedDiscardRemovesOnlyExactCapturedRevisionsAndNeverReturns() {
        val row = finished()
        val log = LocalLog(File(temporary.root, LocalLog.fileName))
        log.hold(row)
        val captured = Exercise("exercise01", "Captured", custom = true)
        log.hold(captured)
        val queue = SetQueue(File(temporary.root, SetQueue.fileName))
        queue.hold(Session("live0001", 4_000), unclaimed = true)
        queue.store(row.sets.single().copy(id = "liveSet01", completedAtMs = 5_000), "live0001", needsPush = true)
        queue.sending(queue.pending.single())
        val batch = ClaimBatch("batch0001", log.claimItems() + queue.claimItems())
        legacyConsent(temporary.root, ClaimConsent.Discarding(batch))
        log.renameExercise(captured.id, "Changed after decision")
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            assertEquals(emptyList<LegacyMigrationRefusal>(), LegacyGymMigration.refusals(engine))
            assertEquals(emptyList<LegacyDeletedSet>(), LegacyGymMigration.deletedSets(engine))
            assertEquals(emptyList<LegacyOperation>(), LegacyGymMigration.operations(engine))
            assertEquals(emptyList<Json>(), LegacyGymMigration.cached(engine, "start"))
            assertEquals(listOf("exercise"), outbox(engine).flatMap { it.member("intent").member("d").arr().map { delta -> delta.member("t").str() } })
            assertEquals(Json.of("Changed after decision"), engine.read(scope) { it.drawn("exercise", RecordID(captured.id)) }!!.values["name"])
            assertEquals("discarded", sources(engine).first { it["kind"] == Json.of("finished") }.member("state").str())
            LegacyGymMigration(temporary.root, engine).run()
            assertEquals(1, outbox(engine).size)
        }
    }

    @Test fun corruptConsentAndUnreadableRowsStayArchivedWithAVisibleReason() {
        val text = "{damaged-consent"
        File(temporary.root, LocalClaimConsent.fileName).writeText(text)
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            val refusal = LegacyGymMigration.refusals(engine).single()
            assertEquals("source-unreadable", refusal.code)
            assertEquals(LocalClaimConsent.fileName, refusal.id)
            assertEquals(text, File(temporary.root, LocalClaimConsent.fileName).readText())
            assertEquals(Json.of(text), sources(engine).single().member("source"))
            assertTrue(refusal.reason.contains("Keep it on this phone"))
        }
    }

    @Test fun engineProjectionReplacesLegacyPresentationAndSurvivesReopenWithoutOwedWrites() {
        val file = File(temporary.root, SetQueue.fileName)
        val queue = SetQueue(file)
        val row = finished()
        queue.hold(row.session.copy(finishedAtMs = null), unclaimed = true)
        queue.store(row.sets.single(), row.session.id, needsPush = true)
        queue.sending(queue.pending.single())
        queue.bindEngine("rp_first")
        queue.project("rp_first", row.session.copy(finishedAtMs = null), row.sets)
        val reopened = SetQueue(file)
        assertEquals("rp_first", reopened.engineReplica)
        assertEquals(row.sets, reopened.sets)
        assertEquals(emptyList<SetQueue.Entry>(), reopened.pending)
        reopened.project("rp_next", null, emptyList())
        assertEquals(null, reopened.session)
        assertEquals(emptyList<TrainingSet>(), reopened.sets)
        assertEquals("rp_next", SetQueue(file).engineReplica)
    }

    @Test fun fullPullRetiresCachedRowsWithoutChangingTheArchivedSource() {
        DeviceCopy(File(temporary.root, DeviceCopy.fileName)).hold("A", TheSix.movements)
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine, "A").run()
            val cache = LegacyGymMigration.cached(engine, "cache").single()
            LegacyGymMigration.retireCaches(engine)
            assertEquals(emptyList<Json>(), LegacyGymMigration.cached(engine, "cache"))
            assertEquals(cache, sources(engine).single().member("source"))
            engine(engine.snapshot()).use { reopened ->
                assertEquals(emptyList<Json>(), LegacyGymMigration.cached(reopened, "cache"))
                assertEquals(cache, sources(reopened).single().member("source"))
            }
        }
    }

    @Test fun completedMigrationNeverRebindsSignedOutOwnerOrRestoresDiscardedAnonymousData() {
        shelf(finished(), "A")
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine, "A").run()
            engine.signOut("keep")
            val anonymous = engine.activeReplica()
            LegacyGymMigration(temporary.root, engine, "A").run()
            assertEquals(anonymous, engine.activeReplica())
            assertEquals(emptyList<LegacyMigrationRefusal>(), LegacyGymMigration.refusals(engine))
        }
        temporary.root.listFiles()!!.forEach { it.delete() }
        shelf(finished(start = 101_000, finish = 102_000))
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            engine.signIn("A", mapOf("gym" to true), mapOf("gym" to "discard"))
            LegacyGymMigration(temporary.root, engine).run()
            assertEquals(emptyList<LegacyMigrationRefusal>(), LegacyGymMigration.refusals(engine))
            assertEquals(emptyList<Json>(), outbox(engine))
        }
    }

    @Test fun anonymousAndDormantOwnerMigrationJournalsSurviveAddWithoutCollision() {
        shelf(finished(start = 101_000, finish = 103_000))
        shelf(finished("session02", 104_000, 105_000), "A")
        engine().use { engine ->
            LegacyGymMigration(temporary.root, engine).run()
            val question = engine.signIn("A", mapOf("gym" to true))
            assertFalse(question.member("complete").bool())
            assertEquals(1L, question.member("due").arr().single().member("count").member("session").long())
            engine.signIn("A", mapOf("gym" to true), mapOf("gym" to "add"))
            assertEquals(setOf("session01", "session02"), LegacyGymMigration.refusals(engine).map { it.id }.toSet())
            assertEquals(2, engine.read(scope) { it.devices(LegacyGymMigration.journalPrefix).size })
        }
    }
}
