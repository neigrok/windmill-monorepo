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
    private var testNow = 100_000L
    private val timing get() = RequestTiming(ClockReading(testNow, testNow, "boot"), ClockReading(testNow, testNow, "boot"))
    private fun engine(snapshot: Json? = null, pushMaxBytes: Int? = null) = if (pushMaxBytes == null) Engine.memory(SyncSchema.registry, snapshot,
        clock = object : EngineClock { override fun now() = testNow },
        intentResultWrites = EngineTraining.intentResultWrites,
        pendingDeviceWork = WorkoutImports.pendingDeviceWork, rewriteDeviceValue = WorkoutImports.rewriteDeviceValue)
        else Engine.memory(SyncSchema.registry, snapshot, clock = object : EngineClock { override fun now() = testNow }, pushMaxBytes = pushMaxBytes,
        intentResultWrites = EngineTraining.intentResultWrites,
        pendingDeviceWork = WorkoutImports.pendingDeviceWork, rewriteDeviceValue = WorkoutImports.rewriteDeviceValue)
    private fun finished(id: String = "session01", start: Long = 1_000, finish: Long = 3_000) =
        SavedWorkout(Session(id, start, finish), listOf(TrainingSet("set00001", "back-squat", weightKg = 60.0,
            reps = 5, completedAtMs = 2_000)), deleted = listOf("deleted01"))
    private fun outbox(engine: Engine): List<Json> = engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }
    private fun sources(engine: Engine) = engine.read(scope) { reader -> reader.devices(WorkoutImports.journalPrefix).values
        .flatMap { it.member("items").obj().values } }

    @Test fun aLateServerFinishRefusalKeepsTheAdoptedSetRecoverableAcrossRestart() = runBlocking {
        val server = EngineRoomFixture.server()
        lateinit var original: TrainingSet
        val snapshot = engine().use { local ->
            val gym = EngineTraining(local)
            gym.startSession(SessionStart("session01", 1_000))
            gym.appendSet("session01", SetWrite("set00001", "back-squat", 60.0, 5, SetKind.Warmup, 2_000))
            gym.fixSet("session01", "set00001", SetFix(note = "Original", rpe = 7.0, rpeNamed = true))
            gym.prepareAdoption()
            signIn(local, server); pull(local, server); push(local, server)
            original = gym.imports.operations().single().entry.set
            engine().use { other ->
                signIn(other, server); pull(other, server)
                EngineTraining(other).finishSession("session01", 3_000); push(other, server)
            }
            gym.finishSession("session01", 4_000)
            push(local, server)
            local.snapshot()
        }
        engine(snapshot).use { reopened ->
            val gym = EngineTraining(reopened)
            gym.imports.retry(original.id)
            repeat(12) { gym.reconcileImports(); push(reopened, server); pull(reopened, server) }
            engine().use { account ->
                signIn(account, server); pull(account, server)
                val accepted = EngineTraining(account).details().flatMap { it.sets }
                assertEquals("A server refusal must not strand an accepted adopted set", 1, accepted.size)
                assertEquals(original, accepted.single().copy(id = original.id, setNumber = original.setNumber))
            }
            assertTrue(gym.imports.refusals().isEmpty())
            assertFalse(gym.imports.hasOwedSets("session01"))
        }
    }

    @Test fun recoveryAgainstAnAdvertisedV5ServerUsesAnAcceptedFallback() = runBlocking {
        val server = EngineRoomFixture.oldServer()
        engine(stranded(server)).use { local ->
            val hello = server.hello(Credential.Account("A"), 100_000)
            local.onHello(SyncResponse(hello.status, hello.body), timing)
            val gym = EngineTraining(local)
            val original = gym.imports.refusals().single().sets.single()
            val standing = gym.session("session01")!!.sets.single()
            gym.imports.retry(original.id)
            repeat(12) { gym.reconcileImports(); push(local, server); pull(local, server) }
            engine().use { account ->
                signIn(account, server); pull(account, server)
                val accepted = EngineTraining(account).details().flatMap { it.sets }
                assertEquals("Old servers must receive an accepted recovery, not unsupported correction arguments", 2, accepted.size)
                assertEquals(standing, accepted.single { it.id == standing.id })
                assertEquals(original, accepted.single { it.id != standing.id }.copy(id = original.id, setNumber = original.setNumber))
            }
            assertTrue(gym.imports.refusals().isEmpty())
            assertFalse(gym.imports.hasOwedSets("session01"))
        }
    }

    @Test fun lateRefusalsOfSeveralSetsRecoverWithoutStartingCompetingWorkouts() = runBlocking {
        val server = EngineRoomFixture.server()
        engine().use { local ->
            val gym = EngineTraining(local)
            gym.startSession(SessionStart("session01", 1_000))
            for (n in 1..3) gym.appendSet("session01", SetWrite("set0000$n", "back-squat", 60.0 + n, n,
                SetKind.Warmup, 2_000L + n))
            val original = gym.session("session01")!!.sets
            gym.prepareAdoption()
            signIn(local, server); pull(local, server); push(local, server)
            engine().use { other ->
                signIn(other, server); pull(other, server)
                EngineTraining(other).finishSession("session01", 3_000); push(other, server)
            }
            gym.finishSession("session01", 4_000); push(local, server)
            repeat(20) { gym.reconcileImports(); push(local, server); pull(local, server) }
            assertTrue(gym.imports.refusals().map { it.code }.toString(), gym.imports.refusals().isEmpty())
            assertFalse(gym.imports.hasOwedSets("session01"))
            val sets = gym.details().flatMap { it.sets }.sortedBy { it.completedAtMs }
            assertEquals(original, sets.mapIndexed { i, set -> set.copy(id = original[i].id, setNumber = original[i].setNumber) })
            assertTrue(gym.details().all { !it.session.isOpen })
        }
    }

    @Test fun anAlreadyPulledFinishBeforeTheSavedSetUsesASeparateWorkoutWithoutChangingItsTime() = runBlocking {
        val server = EngineRoomFixture.server()
        engine().use { local ->
            val gym = EngineTraining(local)
            gym.startSession(SessionStart("session01", 1_000))
            gym.appendSet("session01", SetWrite("set00001", "back-squat", 60.0, 5, SetKind.Warmup, 2_000))
            gym.fixSet("session01", "set00001", SetFix(note = "Original", rpe = 7.0, rpeNamed = true))
            val original = gym.session("session01")!!.sets.single()
            gym.prepareAdoption()
            signIn(local, server); pull(local, server); push(local, server)
            engine().use { other ->
                signIn(other, server); pull(other, server)
                EngineTraining(other).finishSession("session01", 1_500); push(other, server)
            }
            pull(local, server)
            repeat(12) {
                gym.imports.refusals().forEach { gym.imports.retry(it.id) }
                gym.reconcileImports(); push(local, server); pull(local, server)
            }
            val accepted = gym.details().flatMap { it.sets }
            assertEquals("A confirmed remote finish must not trap a valid saved set in bad-instant retries", 1, accepted.size)
            assertEquals(original, accepted.single().copy(id = original.id, setNumber = original.setNumber))
            assertEquals(1_500L, gym.session("session01")!!.session.finishedAtMs)
            assertTrue(gym.details().all { !it.session.isOpen })
            assertFalse(gym.imports.hasOwedSets("session01"))
            assertTrue(gym.imports.refusals().isEmpty())
        }
    }

    @Test fun aCorrectionOverlapRefusalCanRetryThroughASeparateWorkout() = runBlocking {
        val server = EngineRoomFixture.server()
        engine(stranded(server)).use { local ->
            val gym = EngineTraining(local)
            val original = gym.imports.refusals().single().sets.single()
            val standing = gym.session("session01")!!.sets.single()
            engine().use { other ->
                signIn(other, server); pull(other, server)
                val remote = EngineTraining(other)
                remote.startSession(SessionStart("overlap01", 1_500)); push(other, server)
                remote.finishSession("overlap01", 2_900); push(other, server)
            }
            pull(local, server)
            gym.imports.retry(original.id)
            gym.reconcileImports(); push(local, server)
            assertEquals(1, gym.imports.refusals().size)
            repeat(12) {
                gym.imports.refusals().forEach { gym.imports.retry(it.id) }
                gym.reconcileImports(); push(local, server); pull(local, server)
            }
            val sets = gym.details().flatMap { it.sets }
            assertEquals("An overlapping workout must not strand the saved set", 2, sets.size)
            assertEquals(standing, sets.single { it.id == standing.id })
            assertEquals(original, sets.single { it.id != standing.id }.copy(id = original.id, setNumber = original.setNumber))
            assertTrue(gym.details().all { !it.session.isOpen })
            assertFalse(gym.imports.hasOwedSets("session01"))
            assertTrue(gym.imports.refusals().isEmpty())
        }
    }

    @Test fun anAutomaticCloseBeforeALaterAcceptedSetUsesASeparateWorkout() = runBlocking {
        testNow = 20_000_000
        val server = EngineRoomFixture.server()
        engine().use { local ->
            val gym = EngineTraining(local)
            gym.startSession(SessionStart("session01", 1_000))
            gym.appendSet("session01", SetWrite("set00001", "back-squat", 60.0, 5, SetKind.Warmup, testNow - 1_000))
            val original = gym.session("session01")!!.sets.single()
            gym.prepareAdoption()
            signIn(local, server); pull(local, server); push(local, server)
            assertEquals(Json.of("stale"), local.read(scope) { it.confirmed("session", RecordID("session01")) }!!.values["closedBy"])
            repeat(12) { gym.reconcileImports(); push(local, server); pull(local, server) }
            val accepted = gym.details().flatMap { it.sets }
            assertEquals(original, accepted.single().copy(id = original.id, setNumber = original.setNumber))
            assertEquals(1_000L, gym.session("session01")!!.session.finishedAtMs)
            assertTrue(gym.details().all { !it.session.isOpen })
            assertFalse(gym.imports.hasOwedSets("session01"))
            assertTrue(gym.imports.refusals().isEmpty())
        }
    }

    @Test fun anOlderAppsDismissedSetRefusalIsRecoveredOnceWithItsCompleteSavedSource() = runBlocking {
        val server = EngineRoomFixture.server()
        lateinit var original: TrainingSet
        val submitted = engine().use { local ->
            val gym = EngineTraining(local)
            gym.startSession(SessionStart("session01", 1_000))
            gym.appendSet("session01", SetWrite("set00001", "back-squat", 60.0, 5, SetKind.Warmup, 2_000))
            gym.fixSet("session01", "set00001", SetFix(note = "Original", rpe = 7.0, rpeNamed = true))
            gym.prepareAdoption()
            signIn(local, server); pull(local, server); push(local, server)
            original = gym.imports.operations().single().entry.set
            engine().use { other ->
                signIn(other, server); pull(other, server)
                EngineTraining(other).finishSession("session01", 3_000); push(other, server)
            }
            // Released adoption queued SetWrite without the source's note or RPE and resolved immediately.
            gym.appendSet("session01", SetWrite(original))
            local.commit(scope) { context ->
                val writes = context.devices(WorkoutImports.journalPrefix).map { (key, journal) ->
                    val items = journal.member("items").obj().mapValues { (_, item) ->
                        if (item["kind"] == Json.of("operation")) Json.Obj((item.obj() + ("state" to Json.of("resolved"))).toList()) else item
                    }
                    works.windmill.sync.api.DeviceWrite(key, Json.Obj((journal.obj() + ("items" to Json.Obj(items.toList()))).toList()))
                }
                works.windmill.sync.api.Gesture(emptyList(), local = writes) to Unit
            }
            gym.finishSession("session01", 4_000)
            local.snapshot()
        }
        val refused = Engine.memory(SyncSchema.registry, submitted, clock = object : EngineClock { override fun now() = 100_000L }).use { old ->
            push(old, server)
            assertTrue(EngineTraining(old).details().flatMap { it.sets }.isEmpty())
            assertTrue(old.notices("gym").notices.value.any { it.code.text == "session-finished" })
            old.notices("gym").notices.value.forEach { old.dismissNotice(it.id) }
            old.snapshot()
        }
        val recovered = engine(refused).use { upgraded ->
            repeat(12) { EngineTraining(upgraded).reconcileImports(); push(upgraded, server); pull(upgraded, server) }
            assertFalse(WorkoutImports(upgraded).hasOwedSets("session01"))
            upgraded.snapshot()
        }
        engine(recovered).use { reopened ->
            repeat(12) { EngineTraining(reopened).reconcileImports(); push(reopened, server); pull(reopened, server) }
            val sets = EngineTraining(reopened).details().flatMap { it.sets }
            assertEquals(original, sets.single().copy(id = original.id, setNumber = original.setNumber))
            assertEquals(2, EngineTraining(reopened).details().size)
            assertTrue(EngineTraining(reopened).details().all { !it.session.isOpen })
            assertTrue(outbox(reopened).isEmpty())
            assertTrue(WorkoutImports(reopened).refusals().isEmpty())
        }
    }

    @Test fun v5RecoverySurvivesLostReceiptsAndRestartAtEveryPhaseAndWaitsForTheStartPull() = runBlocking {
        val server = EngineRoomFixture.oldServer()
        var snapshot = stranded(server)
        lateinit var original: TrainingSet
        engine(snapshot).use { local ->
            original = WorkoutImports(local).refusals().single().sets.single()
            WorkoutImports(local).retry(original.id)
            snapshot = local.snapshot()
        }
        listOf("gym.start", null, "gym.finish").forEachIndexed { phase, command ->
            engine(snapshot).use { local ->
                pull(local, server)
                EngineTraining(local).reconcileImports()
                val request = local.nextPush()!!
                assertEquals(command, request.member("intents").arr().single()["cmd"]?.get("name")?.str())
                assertEquals(200, server.push(request, Credential.Account("A"), 100_000).status)
                snapshot = local.snapshot()
            }
            engine(snapshot).use { restarted ->
                val replay = restarted.nextPush()!!
                val reply = server.push(replay, Credential.Account("A"), 100_000)
                restarted.onPushResponse(replay, SyncResponse(reply.status, reply.body), timing)
                EngineTraining(restarted).reconcileImports()
                if (phase == 0) {
                    assertNull("Start acknowledgment alone cannot queue the set", restarted.nextPush())
                    assertEquals("set", sources(restarted).single { it["kind"] == Json.of("operation") }.member("recoveryPhase").str())
                }
                assertTrue(WorkoutImports(restarted).refusals().isEmpty())
                snapshot = restarted.snapshot()
            }
        }
        engine(snapshot).use { local ->
            pull(local, server)
            repeat(3) { EngineTraining(local).reconcileImports(); push(local, server) }
            val workouts = EngineTraining(local).details()
            assertEquals(2, workouts.size)
            assertTrue(workouts.all { !it.session.isOpen })
            assertEquals(original, workouts.flatMap { it.sets }.single { it.id != "standing1" }.copy(id = original.id, setNumber = original.setNumber))
            assertFalse(WorkoutImports(local).hasOwedSets("session01"))
            assertTrue(outbox(local).isEmpty())
        }
    }

    private fun signIn(engine: Engine, server: ModelServer) {
        val hello = server.hello(Credential.Account("A"), testNow)
        engine.onHello(SyncResponse(hello.status, hello.body), timing)
        assertTrue(engine.signIn("A", emptyMap(), serverSchema = hello.body!!.member("schema").long()).member("complete").bool())
    }

    private fun pull(engine: Engine, server: ModelServer) {
        val request = engine.pullRequest(listOf(scope))!!
        val reply = server.pull(request, Credential.Account("A"), testNow)
        assertEquals(200, reply.status)
        engine.onPullResponse(request, SyncResponse(reply.status, reply.body), timing)
    }

    private fun push(engine: Engine, server: ModelServer) {
        while (true) {
            val request = engine.nextPush() ?: break
            val reply = server.push(request, Credential.Account("A"), testNow)
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
        signIn(remote, server); pull(remote, server)
        EngineTraining(remote).startSession(SessionStart("existing1", 500)); push(remote, server)
    }

    private suspend fun stranded(server: ModelServer, write: Owed = Owed.Append, standingCount: Int = 1): Json = engine().use { local ->
        val gym = EngineTraining(local)
        gym.startSession(SessionStart("session01", 1_000))
        gym.appendSet("session01", SetWrite("set00001", "back-squat", 60.0, 5, SetKind.Warmup, 2_000))
        gym.fixSet("session01", "set00001", SetFix(note = "Original", rpe = 7.0, rpeNamed = true))
        gym.prepareAdoption()
        signIn(local, server); pull(local, server); push(local, server)
        gym.appendSet("session01", SetWrite("standing1", "back-squat", 80.0, 8, SetKind.Drop, 2_500))
        gym.fixSet("session01", "standing1", SetFix(note = "Standing", rpe = 8.0, rpeNamed = true))
        if (standingCount > 1) local.commit(scope, works.windmill.sync.api.Gesture((2..standingCount).map { number ->
            works.windmill.sync.api.Change.create("set", works.windmill.sync.api.NewID.Given(RecordID("standing$number")), mapOf(
                "sessionId" to Json.of("session01"), "exerciseId" to Json.of("back-squat"), "weightKg" to Json.of(80.0),
                "reps" to Json.of(8), "kind" to Json.of("working"), "completedAt" to Json.of(2_500)))
        }, atomic = true))
        push(local, server)
        local.commit(scope, works.windmill.sync.api.Gesture(emptyList(), command = works.windmill.sync.core.Command("gym.finish",
            Json.objectOf("sessionId" to Json.of("session01"), "finishedAt" to Json.of(3_000)))))
        push(local, server)
        if (standingCount <= 200) { correct(local, gym.session("session01")!!.sets, "Evening"); push(local, server) }
        repeat(10) { if (local.read(scope) { it.checkpoint().cleanSeq == null }) pull(local, server) }
        assertNotNull(local.read(scope) { it.checkpoint().cleanSeq })
        val imports = WorkoutImports(local)
        val operation = imports.operations().single()
        if (write != Owed.Append) local.commit(scope) { context ->
            val saved = context.devices(WorkoutImports.journalPrefix).entries.single { operation.token in it.value.member("items").obj() }
            val items = saved.value.member("items").obj().toMutableMap()
            val item = items.getValue(operation.token)
            val source = Json.Obj((item.member("source").obj() + ("write" to Json.of(write.name))).toList())
            items[operation.token] = Json.Obj((item.obj() + ("source" to source)).toList())
            works.windmill.sync.api.Gesture(emptyList(), local = listOf(works.windmill.sync.api.DeviceWrite(saved.key,
                Json.Obj((saved.value.obj() + ("items" to Json.Obj(items.toList()))).toList())))) to Unit
        }
        imports.refuseOperation(imports.operations().single(), "session-finished")
        local.snapshot()
    }

    private fun correct(local: Engine, sets: List<TrainingSet>, name: String) {
        local.commit(scope) { context -> works.windmill.sync.api.Gesture(emptyList(), command = works.windmill.sync.core.Command("gym.correctSession",
            Json.objectOf("sessionId" to Json.of("session01"), "requestId" to Json.of(context.opaqueID()),
                "startedAt" to Json.of(1_000), "finishedAt" to Json.of(3_000), "routineName" to Json.of(name),
                "sets" to Json.Arr(sets.map { set -> Json.objectOf("id" to Json.of(set.id), "exerciseId" to Json.of(set.exerciseId),
                    "setNumber" to Json.of(set.setNumber ?: 2), "weightKg" to Json.of(set.weightKg), "reps" to Json.of(set.reps),
                    "completedAt" to Json.of(set.completedAtMs), "note" to Json.of(set.note), "rpe" to (set.rpe?.let(Json::of) ?: Json.Null)) })))) to Unit }
    }

    @Test fun aFinishedSetRefusalSurvivesRestartAndRetryPreservesBothSetsAndNewerEdits() = runBlocking {
        val server = EngineRoomFixture.server()
        engine(stranded(server, Owed.Fix)).use { local ->
            val imports = WorkoutImports(local)
            val original = imports.refusals().single().sets.single()
            val standing = EngineTraining(local).session("session01")!!.sets.single()
            assertEquals(setOf(original.id), imports.retainedOperationSetIds())
            imports.retry(original.id)
            EngineTraining(local).reconcileImports()
            assertTrue(imports.hasOwedSets("session01"))
            assertTrue(imports.operations().isEmpty())
            assertEquals("recovering", sources(local).single { it["kind"] == Json.of("operation") }.member("state").str())
            assertEquals("gym.correctSession", outbox(local).single().member("intent").member("cmd").member("name").str())
            engine(local.snapshot()).use { reopened ->
                push(reopened, server)
                assertTrue(WorkoutImports(reopened).operations().isEmpty())
                assertEquals(original.copy(setNumber = 2), EngineTraining(reopened).session("session01")!!.sets.first())
                engine().use { other ->
                    signIn(other, server); pull(other, server)
                    EngineTraining(other).fixSet("session01", original.id, SetFix(weightKg = 62.5, kind = SetKind.Failure,
                        note = "Newer", rpe = 9.0, rpeNamed = true))
                    push(other, server)
                }
                pull(reopened, server)
                val restored = EngineTraining(reopened)
                restored.reconcileImports(); push(reopened, server)
                assertEquals(listOf(original.copy(weightKg = 62.5, kind = SetKind.Failure, note = "Newer", rpe = 9.0, setNumber = 2), standing), restored.session("session01")!!.sets)
                assertEquals(Json.of("Evening"), reopened.read(scope) { it.confirmed("session", RecordID("session01")) }!!.values["displayName"])
                assertEquals(3_000L, restored.session("session01")!!.session.finishedAtMs)
                assertFalse(WorkoutImports(reopened).hasOwedSets("session01"))
                assertEquals(emptySet<String>(), WorkoutImports(reopened).retainedOperationSetIds())
                assertTrue(WorkoutImports(reopened).refusals().isEmpty())
            }
        }
    }

    @Test fun recoveryCommitFailureRollsBackAndACrashAfterCommitRetainsTheQueuedCorrection() = runBlocking {
        val server = EngineRoomFixture.server()
        engine(stranded(server)).use { local ->
            val imports = WorkoutImports(local)
            imports.retry("set00001")
            val operation = imports.operations().single()
            val before = local.snapshot()
            local.failNextCommit()
            assertThrows(CommitFailure::class.java) { imports.recoverFinishedOperation(operation) }
            assertEquals(before, local.snapshot())
            local.crashAfterTransactions(1)
            assertThrows(EngineCrash::class.java) { imports.recoverFinishedOperation(operation) }
            engine(local.snapshot()).use { reopened ->
                assertEquals(setOf("set00001"), WorkoutImports(reopened).retainedOperationSetIds())
                assertEquals(1, outbox(reopened).size)
                push(reopened, server)
                EngineTraining(reopened).reconcileImports(); push(reopened, server)
                assertEquals(operation.entry.set.copy(setNumber = 2), EngineTraining(reopened).session("session01")!!.sets.first())
                assertTrue(outbox(reopened).isEmpty())
                assertFalse(WorkoutImports(reopened).hasOwedSets("session01"))
            }
        }
    }

    @Test fun recoveryPreservesConcurrentSetEditsAndRetriesConcurrentAdditionsFromTheLatestWorkout() = runBlocking {
        for (adding in listOf(false, true)) {
            val server = EngineRoomFixture.server()
            engine(stranded(server)).use { local ->
                val imports = WorkoutImports(local)
                imports.retry("set00001")
                EngineTraining(local).reconcileImports()
                val priorRequest = outbox(local).single().member("intent").member("cmd").member("args").member("requestId")
                engine().use { other ->
                    signIn(other, server); pull(other, server)
                    val remote = EngineTraining(other)
                    if (adding) correct(other, remote.session("session01")!!.sets + TrainingSet("another01", "bench-press", setNumber = 1,
                        weightKg = 45.0, reps = 10, completedAtMs = 2_600), "Changed")
                    else remote.fixSet("session01", "standing1", SetFix(weightKg = 82.5, note = "Changed"))
                    push(other, server)
                }
                push(local, server)
                if (adding) {
                    assertEquals("recovery-stale", imports.refusals().single().code)
                    assertEquals(setOf("set00001"), imports.retainedOperationSetIds())
                    assertFalse(EngineTraining(local).session("session01")!!.sets.any { it.id == "set00001" })
                    imports.retry("set00001")
                    EngineTraining(local).reconcileImports()
                    assertNotEquals(priorRequest, outbox(local).single().member("intent").member("cmd").member("args").member("requestId"))
                    push(local, server)
                }
                EngineTraining(local).reconcileImports(); push(local, server)
                val restored = EngineTraining(local).session("session01")!!.sets
                assertEquals(SetKind.Warmup, restored.single { it.id == "set00001" }.kind)
                if (adding) {
                    assertEquals(setOf("set00001", "standing1", "another01"), restored.map { it.id }.toSet())
                    assertEquals(Json.of("Changed"), local.read(scope) { it.confirmed("session", RecordID("session01")) }!!.values["displayName"])
                } else {
                    assertEquals(82.5, restored.single { it.id == "standing1" }.weightKg, 0.0)
                    assertEquals("Changed", restored.single { it.id == "standing1" }.note)
                }
                assertTrue(imports.refusals().isEmpty())
                assertFalse(imports.hasOwedSets("session01"))
            }
        }
    }

    @Test fun staleOperationSnapshotsCannotResolveAQueuedRepairOrRefuseAnAcknowledgedOne() = runBlocking {
        val server = EngineRoomFixture.server()
        engine(stranded(server)).use { local ->
            val imports = WorkoutImports(local)
            imports.retry("set00001")
            val operation = imports.operations().single()
            assertTrue(imports.recoverFinishedOperation(operation))
            val queued = local.snapshot()
            EngineTraining(local).reconcileOperation(operation)
            imports.refuseOperation(operation, "session-finished")
            assertEquals(queued, local.snapshot())
            push(local, server)
            EngineTraining(local).reconcileOperation(operation)
            imports.refuseOperation(operation, "session-finished")
            assertTrue(imports.operations().isEmpty())
            assertTrue(imports.refusals().isEmpty())
            EngineTraining(local).reconcileImports(); push(local, server)
            assertFalse(imports.hasOwedSets("session01"))
            assertEquals(SetKind.Warmup, EngineTraining(local).session("session01")!!.sets.first().kind)
        }
    }

    @Test fun recoveryAddsASetToAWorkoutAlreadyHoldingMoreThanTwoHundredSets() = runBlocking {
        val server = EngineRoomFixture.server()
        engine(stranded(server, standingCount = 201)).use { local ->
            val gym = EngineTraining(local)
            val standing = gym.session("session01")!!.sets
            assertEquals(201, standing.size)
            val imports = WorkoutImports(local)
            val original = imports.refusals().single().sets.single()
            imports.retry(original.id)
            gym.reconcileImports()
            val command = outbox(local).single().member("intent").member("cmd").member("args")
            assertEquals(Json.of(true), command.member("preserveOtherSets"))
            assertEquals(listOf(original.id), command.member("sets").arr().map { it.member("id").str() })
            push(local, server)
            assertEquals(listOf(original.copy(setNumber = 202)) + standing, gym.session("session01")!!.sets)
            assertTrue(imports.refusals().isEmpty())
            assertFalse(imports.hasOwedSets("session01"))
        }
    }

    @Test fun transportRefusalsWithoutACommandReceiptKeepRecoveryRetryableAfterRestart() = runBlocking {
        for (status in listOf(400, 413)) {
            val server = EngineRoomFixture.server()
            engine(stranded(server)).use { local ->
                val imports = WorkoutImports(local)
                imports.retry("set00001")
                EngineTraining(local).reconcileImports()
                val source = sources(local).single { it["kind"] == Json.of("operation") }.member("source")
                val request = local.nextPush()!!
                local.onPushResponse(request, SyncResponse(status), timing)
                assertTrue(outbox(local).isEmpty())
                imports.reconcileConfirmed()
                assertEquals("recovery-retry", imports.refusals().single().code)
                assertEquals(source, sources(local).single { it["kind"] == Json.of("operation") }.member("source"))
                engine(local.snapshot()).use { reopened ->
                    WorkoutImports(reopened).retry("set00001")
                    repeat(8) { EngineTraining(reopened).reconcileImports(); push(reopened, server); pull(reopened, server) }
                    val recovered = EngineTraining(reopened).details().flatMap { it.sets }.single { it.id != "standing1" }
                    assertEquals(diskJson.decodeFromString(OwedSet.serializer(), source.jcs).set,
                        recovered.copy(id = "set00001", setNumber = null))
                    assertFalse(WorkoutImports(reopened).hasOwedSets("session01"))
                    assertTrue(WorkoutImports(reopened).refusals().isEmpty())
                }
            }
        }
    }

    @Test fun aLostRecoveryReceiptReplaysWithoutChangingANewerSetKind() = runBlocking {
        val server = EngineRoomFixture.server()
        engine(stranded(server)).use { local ->
            WorkoutImports(local).retry("set00001")
            EngineTraining(local).reconcileImports()
            val request = local.nextPush()!!
            val reply = server.push(request, Credential.Account("A"), 100_000)
            assertEquals(200, reply.status)
            engine().use { other ->
                signIn(other, server); pull(other, server)
                EngineTraining(other).fixSet("session01", "set00001", SetFix(kind = SetKind.Failure, note = "Newer"))
                push(other, server)
            }
            engine(local.snapshot()).use { reopened ->
                push(reopened, server)
                EngineTraining(reopened).reconcileImports(); push(reopened, server)
                val recovered = EngineTraining(reopened).session("session01")!!.sets.single { it.id == "set00001" }
                assertEquals(SetKind.Failure, recovered.kind)
                assertEquals("Newer", recovered.note)
                assertFalse(WorkoutImports(reopened).hasOwedSets("session01"))
                assertTrue(WorkoutImports(reopened).refusals().isEmpty())
                assertEquals(2, EngineTraining(reopened).session("session01")!!.sets.size)
            }
        }
    }

    @Test fun aStaleFixCannotWriteAfterRecoveryAcknowledgmentAndNewerEdits() = runBlocking {
        val server = EngineRoomFixture.server()
        engine(stranded(server, Owed.Fix)).use { local ->
            val imports = WorkoutImports(local)
            val gym = EngineTraining(local)
            imports.retry("set00001")
            val stale = imports.operations().single()
            gym.reconcileImports(); push(local, server)
            engine().use { other ->
                signIn(other, server); pull(other, server)
                EngineTraining(other).fixSet("session01", "set00001", SetFix(weightKg = 92.5, reps = 12,
                    kind = SetKind.Failure, rpe = 9.0, rpeNamed = true, note = "Newer"))
                push(other, server)
            }
            pull(local, server)
            val before = local.snapshot()
            gym.reconcileOperation(stale)
            imports.refuseOperation(stale, "session-finished")
            assertTrue(imports.recoverFinishedOperation(stale))
            assertEquals(before, local.snapshot())
            assertEquals(stale.entry.set.copy(setNumber = 2, weightKg = 92.5, reps = 12, kind = SetKind.Failure,
                rpe = 9.0, note = "Newer"), gym.session("session01")!!.sets.first())
        }
    }

    @Test fun aStaleFixCannotResolveOrRefuseACorrectedRetrySource() = runBlocking {
        val server = EngineRoomFixture.server()
        engine(stranded(server, Owed.Fix)).use { local ->
            val imports = WorkoutImports(local)
            val gym = EngineTraining(local)
            imports.retry("set00001")
            val stale = imports.operations().single()
            imports.refuseOperation(stale, "source-kind")
            imports.replaceOperationKindAndRetry("set00001", SetKind.Drop)
            val before = local.snapshot()
            gym.reconcileOperation(stale)
            imports.refuseOperation(stale, "session-finished")
            assertTrue(imports.recoverFinishedOperation(stale))
            assertEquals(before, local.snapshot())
            assertEquals(SetKind.Drop, imports.operations().single().entry.set.kind)
            gym.reconcileImports(); push(local, server)
            assertEquals(stale.entry.set.copy(setNumber = 2, kind = SetKind.Drop), gym.session("session01")!!.sets.first())
            assertFalse(imports.hasOwedSets("session01"))
        }
    }

    @Test fun repackagingLinkedAnonymousHistoryRollsBackOnCrashAndResumesWithOneDurableImport() = runBlocking {
        engine().use { local ->
            val gym = EngineTraining(local)
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
            val gym = EngineTraining(local)
            gym.startSession(SessionStart("session01", 1_000))
            listOf("original1" to 2_000L, "zzzzzzzz" to 2_500L, "aaaaaaaa" to 2_500L, "fourth01" to 3_000L).forEach { (id, at) ->
                gym.appendSet("session01", SetWrite(id, "back-squat", 60.0, 5, SetKind.Working, at))
            }
            gym.prepareAdoption()
            assertEquals(4, WorkoutImports(local).retainedWorkouts().single().sets.size)
            signIn(local, server); pull(local, server); push(local, server)
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
                val actual = EngineTraining(reopened)
                assertTrue(actual.session("existing1")!!.session.isOpen)
                assertEquals(listOf(1, 2, 3, 4), actual.session("session01")!!.sets.map { it.setNumber })
            }
        }
    }

    @Test fun aFailedKeepRetainsTheFinishedSourceForRetryAfterRestart() = runBlocking {
        val server = EngineRoomFixture.server()
        accountWorkout(server)
        val (set, refused) = engine().use { local ->
            val gym = EngineTraining(local)
            gym.startSession(SessionStart("session01", 1_000))
            gym.appendSet("session01", SetWrite("set00001", "back-squat", 60.0, 5, SetKind.Working, 2_000))
            gym.fixSet("session01", "set00001", SetFix(note = "n".repeat(3_000)))
            val set = gym.session("session01")!!.sets.single()
            gym.prepareAdoption()
            signIn(local, server); pull(local, server); push(local, server)
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
            val gym = EngineTraining(local); gym.createExercise(ExerciseWrite("exercise1", "Custom", "isolation", "machine"))
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
            val routine = EngineTraining(engine).createRoutine(RoutineWrite("routine01", "Original", 0,
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
