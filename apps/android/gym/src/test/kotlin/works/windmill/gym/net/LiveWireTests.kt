package works.windmill.gym.net

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.AfterClass
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runners.MethodSorters
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.RoutineEntryWrite
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TopSet
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.TrainingUnanswered
import works.windmill.gym.store.TrainingRefused
import works.windmill.gym.store.EngineTraining
import works.windmill.gym.store.WorkoutImports
import works.windmill.gym.domain.Session
import works.windmill.sync.engine.*
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.schema.Gym
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RecordKey
import works.windmill.sync.core.Json
import works.windmill.sync.api.Command
import works.windmill.sync.api.Gesture
import works.windmill.platform.auth.AuthStatus
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.MagicLink
import works.windmill.platform.auth.MemorySessions
import works.windmill.platform.auth.UserResponse
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class LiveWireTests {
    companion object {
        private val bearer: String? = System.getenv("WM_WIRE_BEARER")
        private val base = (System.getenv("WM_WIRE_BASE") ?: "http://localhost:8088").toHttpUrl()
        private val api by lazy { WindmillApi(base, { bearer }) }
        private val transport by lazy { HTTPTransport(base.toString(), SyncSchema.registry.version.toInt()) }
        private val probeClock = object : EngineClock { override fun now() = System.currentTimeMillis() }
        private val engine by lazy { Engine.memory(SyncSchema.registry, clock = probeClock) }
        private val adapter by lazy { EngineTraining(engine) }
        private var connected = false
        private suspend fun response(reply: Reply<SyncResponse>): SyncResponse = when (reply) {
            is Reply.Answer -> reply.value
            is Reply.Failed -> reply.response
            Reply.Unreachable -> throw WindmillApiException.Offline
        }
        private fun pending(key: RecordKey) = engine.read(ScopeRef(Gym.scope)) {
            it.drawn(key.type, key.id)?.isPending == true
        }
        private suspend fun drain(key: RecordKey? = null) = drain(engine) { adapter.firstPullComplete && (key == null || !pending(key)) }
        private suspend fun drain(phone: Engine, settled: () -> Boolean) {
            val deadline = System.nanoTime() + 15_000_000_000L
            while (System.nanoTime() < deadline) {
                // This transport probe has no runtime to release the normal undo hold.
                phone.releaseHeld()
                val pushed = phone.nextPush()
                if (pushed != null) {
                    val send = probeClock.reading()
                    val reply = response(transport.push(pushed, checkNotNull(bearer)))
                    phone.onPushResponse(pushed, reply, RequestTiming(send, probeClock.reading()))
                }
                val pull = checkNotNull(phone.pullRequest(listOf(ScopeRef(Gym.scope))))
                val send = probeClock.reading()
                phone.onPullResponse(pull, response(transport.pull(pull, bearer)), RequestTiming(send, probeClock.reading()))
                if (settled()) return
                delay(100)
            }
            error("The probe failed to settle through /v1/sync.")
        }
        // As the application signs a phone in: hello, then the account's own decision, adding what
        // the phone holds when both sides hold training.
        private suspend fun signIn(phone: Engine) {
            val send = probeClock.reading()
            val hello = response(transport.hello(bearer))
            assertEquals(200, hello.status)
            phone.onHello(hello, RequestTiming(send, probeClock.reading()))
            val body = checkNotNull(hello.body)
            val account = body.member("as").str()
            val holds = body.member("holdsRecords").obj().mapValues { it.value.bool() }
            val question = phone.signIn(account, holds, serverSchema = body.member("schema").long())
            if (!question.member("complete").bool()) {
                val pins = question.member("due").arr().associate { due ->
                    due.member("product").str() to due.member("counted").arr().map { it.str() } }
                assertTrue(phone.signIn(account, holds, mapOf("gym" to "add"), pins, serverSchema = body.member("schema").long()).member("complete").bool())
            }
            phone.subscribe(ScopeRef(Gym.scope))
        }
        private val rest by lazy { GymHttp(api) }
        // Each write commits to the replica and is then carried through /v1/sync until the log holds it.
        private suspend fun createRoutine(write: RoutineWrite): works.windmill.gym.domain.Routine {
            adapter.createRoutine(write); drain(RecordKey(Gym.Types.routine, RecordID(write.id))); return checkNotNull(adapter.routine(write.id))
        }
        private suspend fun replaceRoutine(id: String, write: RoutineWrite): works.windmill.gym.domain.Routine {
            adapter.replaceRoutine(id, write); drain(RecordKey(Gym.Types.routine, RecordID(id))); return checkNotNull(adapter.routine(id))
        }
        private suspend fun startSession(start: SessionStart): works.windmill.gym.domain.Session {
            val session = adapter.startSession(start); drain(RecordKey(Gym.Types.session, RecordID(session.id))); return checkNotNull(adapter.session(session.id)).session
        }
        private suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet {
            adapter.appendSet(sessionId, write)
            val key = RecordKey(Gym.Types.set, RecordID(write.id))
            if (pending(key)) drain(key)
            return checkNotNull(adapter.session(sessionId)).sets.first { it.id == write.id }
        }
        private suspend fun finishSession(sessionId: String, finishedAtMs: Long): works.windmill.gym.domain.Session {
            adapter.finishSession(sessionId, finishedAtMs); drain(RecordKey(Gym.Types.session, RecordID(sessionId))); return checkNotNull(adapter.session(sessionId)).session
        }
        private suspend fun discardSession(sessionId: String) { adapter.discardSession(sessionId); drain(RecordKey(Gym.Types.session, RecordID(sessionId))) }
        private suspend fun deleteRoutine(id: String) { adapter.deleteRoutine(id); drain(RecordKey(Gym.Types.routine, RecordID(id))) }
        @JvmStatic @AfterClass fun closeProbe() { if (connected) { transport.close(); engine.close() } }

        private val tag = "%08x".format(java.security.SecureRandom().nextInt())
        private val routineId = "rt_probe_a$tag"
        private val sessionAId = "ses_probe_a${tag}1"
        private val sessionBId = "ses_probe_a${tag}2"
        private val warmupId = "set_probe_a${tag}w"
        private val workingId = "set_probe_a${tag}g"
        private val squatId = "set_probe_a${tag}q"

        private val startA = System.currentTimeMillis() - 3_600_000
        private val finishA = startA + 180_000
        private val startB = startA + 1_800_000
        private val finishB = startB + 120_000

        private var openedA: works.windmill.gym.domain.Session? = null
        private var storedWorking: TrainingSet? = null

        private val importedId = "ses_probe_a${tag}3"
        private val importedSetId = "set_probe_a${tag}i"
        private val startC = startA - 1_800_000
        private val finishC = startC + 120_000
    }

    @Before
    fun gate() {
        assumeTrue(
            "WM_ANDROID_WIRE_TEST not set — live wire suite skipped (the WM_PG_TEST pattern)",
            System.getenv("WM_ANDROID_WIRE_TEST") != null,
        )
        assumeTrue("WM_WIRE_BEARER not set — no probe session to speak as", bearer != null)
        if (!connected) runBlocking {
            signIn(engine)
            connected = true
            drain()
        }
    }

    @Test
    fun t01_theCatalogDecodesAllSixtyFourSeeds() = runBlocking {
        val catalog = adapter.catalogue()
        assertEquals(64, catalog.count { !it.custom })
        assertEquals(
            Exercise("farmers-carry", "Farmers Carry", "carry", "dumbbell", 2.0, false),
            catalog.first { it.id == "farmers-carry" },
        )
        assertEquals("every seed decodes to a distinct id", 64, catalog.filter { !it.custom }.map { it.id }.distinct().size)
        assertTrue(catalog.all { it.name.isNotEmpty() && it.pattern.isNotEmpty() && it.equipment.isNotEmpty() })
    }

    @Test
    fun t02_aRoutineRoundTripsAndAnAbsentRepOrLoadStaysAbsent() = runBlocking {
        val write = RoutineWrite(routineId, "Probe Day A", 0, listOf(
            RoutineEntryWrite("bench-press", listOf(SetTarget(), SetTarget(), SetTarget())),
            RoutineEntryWrite("back-squat", listOf(SetTarget(5, 100.0), SetTarget(5, 100.0))),
        ))
        val created = createRoutine(write)
        assertEquals(routineId, created.id)
        assertEquals("Probe Day A", created.name)
        assertEquals(
            listOf(
                RoutineEntry(1, "bench-press", listOf(SetTarget(), SetTarget(), SetTarget())),
                RoutineEntry(2, "back-squat", listOf(SetTarget(5, 100.0), SetTarget(5, 100.0))),
            ),
            created.entries,
        )

        assertEquals(created, adapter.routine(routineId))

        val replaced = replaceRoutine(routineId, RoutineWrite(created))
        assertEquals(created, replaced)
        assertEquals(created, adapter.routine(routineId))

        assertTrue(adapter.program().any { it.id == routineId })
        assertNull("an absent routine folds to null, never throws", adapter.routine("rt_probe_a_gone404"))
    }

    @Test
    fun t03_aStartFreezesThePlanAndSetsComeBackNumbered() = runBlocking {
        val opened = startSession(SessionStart(sessionAId, startA, routineId))
        openedA = opened
        assertEquals(sessionAId, opened.id)
        assertEquals(startA, opened.startedAtMs)
        assertTrue(opened.isOpen)
        assertEquals(routineId, opened.routineId)
        val plan = opened.plan
        assertNotNull("a routine start answers with the frozen plan", plan)
        assertEquals("Probe Day A", plan!!.routine)
        assertEquals(PlanEntry("bench-press", listOf(SetTarget(), SetTarget(), SetTarget())), plan.entry("bench-press"))
        assertEquals(PlanEntry("back-squat", listOf(SetTarget(5, 100.0), SetTarget(5, 100.0))), plan.entry("back-squat"))

        val warmup = appendSet(sessionAId,
            SetWrite(warmupId, "bench-press", 40.0, 8, SetKind.Warmup, startA + 60_000))
        assertEquals(
            TrainingSet(warmupId, "bench-press", 1, 40.0, 8, SetKind.Warmup, null, "", startA + 60_000),
            warmup,
        )
        val working = appendSet(sessionAId,
            SetWrite(workingId, "bench-press", 82.5, 5, SetKind.Working, startA + 120_000))
        assertEquals(
            TrainingSet(workingId, "bench-press", 2, 82.5, 5, SetKind.Working, null, "", startA + 120_000),
            working,
        )
        storedWorking = working
    }

    @Test
    fun t04_aReplayOfTheSameSetIdAnswersTheStoredRowByteForSame() = runBlocking {
        val write = SetWrite(workingId, "bench-press", 82.5, 5, SetKind.Working, startA + 120_000)
        val replayed = appendSet(sessionAId, write)
        assertEquals(storedWorking, replayed)
        val rawOnce = engine.snapshot()
        val twice = appendSet(sessionAId, write)
        assertEquals(replayed, twice)
        assertEquals(rawOnce, engine.snapshot())
    }

    @Test
    fun t05_finishClosesReviewReadsAndAFreshSetIsDropped() = runBlocking {
        val closed = finishSession(sessionAId, finishA)
        assertEquals(sessionAId, closed.id)
        assertEquals(finishA, closed.finishedAtMs)
        assertTrue(!closed.isOpen)

        val replayed = appendSet(sessionAId,
            SetWrite(workingId, "bench-press", 82.5, 5, SetKind.Working, startA + 120_000))
        assertEquals(storedWorking, replayed)

        try {
            appendSet(sessionAId,
                SetWrite("set_probe_a${tag}x", "bench-press", 85.0, 3, SetKind.Working, finishA + 1_000))
            fail("a fresh set into a finished session must refuse")
        } catch (refused: TrainingRefused) {
            assertEquals("session-finished", refused.code)
            assertEquals("That workout has finished.", refused.line)
        }

        val review = adapter.review(sessionAId)
        assertEquals(finishA - startA, review.stats.durationMs)
        assertEquals(1, review.stats.workingSets)
        assertNotNull(review.stats.topE1rm)
        if (review.slight) {
            assertNull("slight means record is omitted", review.record)
            assertNull("slight means against is omitted", review.against)
        }
    }

    @Test
    fun t06_lastTimeAnswersHistoryOrTheBareMovement() = runBlocking {
        val trained = adapter.lastTime("bench-press")
        assertEquals("bench-press", trained.exerciseId)
        assertTrue(!trained.isFirstTime)
        assertEquals(sessionAId, trained.session!!.id)
        assertEquals("Probe Day A", trained.routine)
        assertEquals(listOf(storedWorking), trained.sets)

        val untouched = adapter.lastTime("suitcase-carry")
        assertEquals("suitcase-carry", untouched.exerciseId)
        assertTrue("no history means session and sets are omitted TOGETHER", untouched.isFirstTime)
        assertNull(untouched.session)
        assertNull(untouched.routine)
        assertEquals(emptyList<TrainingSet>(), untouched.sets)

        try {
            adapter.lastTime("probe-not-a-movement")
            fail("an unknown movement is refused, never folded to null")
        } catch (refused: TrainingRefused) {
            assertEquals("unknown-exercise", refused.code)
        }
    }

    @Test
    fun t07_theLadderSpeaksOverTheRealWire() = runBlocking {
        val opened = startSession(SessionStart(sessionBId, startB))
        assertEquals(sessionBId, opened.id)
        assertNull("an ad-hoc start carries no routine", opened.routineId)
        assertNull(opened.plan)

        try {
            appendSet(sessionBId,
                SetWrite(workingId, "back-squat", 100.0, 5, SetKind.Working, startB + 30_000))
            fail("an id spent in another session must refuse")
        } catch (refused: TrainingRefused) {
            assertEquals("set-id-taken", refused.code)
            assertEquals("that set id is already used", refused.line)
        }

        try {
            appendSet(sessionBId,
                SetWrite("set_probe_a${tag}z", "probe-not-a-movement", 60.0, 5, SetKind.Working, startB + 40_000))
            fail("a movement outside the catalog must refuse")
        } catch (refused: TrainingRefused) {
            assertEquals(Gym.Codes.unknownExercise, refused.code)
        }

        val unauthorized = response(transport.push(works.windmill.sync.core.Json.objectOf(
            "replica" to works.windmill.sync.core.Json.of("unauthorized-probe"),
            "intents" to works.windmill.sync.core.Json.array()), ""))
        assertEquals(401, unauthorized.status)
        HTTPTransport("http://127.0.0.1:9", SyncSchema.registry.version.toInt()).use { offline ->
            assertEquals(Reply.Unreachable, offline.hello(bearer))
        }

        appendSet(sessionBId, SetWrite(squatId, "back-squat", 100.0, 5, SetKind.Working, startB + 60_000))
        finishSession(sessionBId, finishB)
        Unit
    }

    @Test
    fun t08_theLogPagesOnBothHalvesOfTheCursor() = runBlocking {
        val pageOne = adapter.sessions(limit = 1, before = null, beforeId = null)
        assertEquals(1, pageOne.size)
        val newest = pageOne[0]
        assertEquals(sessionBId, newest.id)
        assertEquals(startB, newest.startedAtMs)
        assertEquals(finishB, newest.finishedAtMs)
        assertNull(newest.routineId)
        assertNull(newest.plan)
        assertEquals(1, newest.setCount)
        assertEquals(listOf("Back Squat"), newest.exercises)
        assertEquals(TopSet(100.0, 5), newest.topSet)
        assertEquals(false, newest.closedItself)

        val pageTwo = adapter.sessions(limit = 1, before = newest.startedAtMs, beforeId = newest.id)
        assertEquals(1, pageTwo.size)
        val older = pageTwo[0]
        assertEquals(sessionAId, older.id)
        assertEquals(2, older.setCount)
        assertEquals(listOf("Bench Press"), older.exercises)
        assertEquals(TopSet(82.5, 5), older.topSet)
        assertEquals("Probe Day A", older.plan!!.routine)

        val detail = adapter.session(sessionAId)
        assertNotNull(detail)
        assertEquals(sessionAId, detail!!.session.id)
        assertEquals(finishA, detail.session.finishedAtMs)
        assertEquals(listOf(warmupId, workingId), detail.sets.map { it.id })
        assertNull("an absent session folds to null", adapter.session("ses_probe_a_gone404"))
    }

    @Test
    fun t09_theRecordReadsOneMovementWholeAndFoldsAnAbsentOneToNull() = runBlocking {
        val bench = adapter.record("bench-press")
        assertNotNull(bench)
        assertEquals("bench-press", bench!!.exercise.id)
        assertEquals("Bench Press", bench.exercise.name)
        assertEquals("barbell", bench.exercise.equipment)

        val day = bench.recentDays.first { it.sessionId == sessionAId }
        assertEquals("a day is stamped with its SESSION's start, never the set's clock", startA, day.startedAtMs)
        assertEquals(listOf(workingId), day.sets.map { it.id })

        assertNull("an absent movement folds to null, exactly as an absent session does",
            adapter.record("probe-not-a-movement"))
    }

    @Test
    fun t10_aShareIsMintedOnceAndRevokedIsGone() = runBlocking {
        val minted = rest.share(sessionBId)
        assertTrue(minted.token.isNotEmpty())
        assertTrue(minted.expiresAtMs > System.currentTimeMillis())
        assertNotNull("the server composes the url; the client only renders it", minted.url)
        assertTrue(minted.url!!.endsWith("/#/gym/shared/${minted.token}"))

        assertEquals("share is idempotent on the session", minted, rest.share(sessionBId))

        rest.revokeShare(sessionBId)
        try {
            rest.revokeShare(sessionBId)
            fail("nothing to revoke answers 404, and the client does not fold it")
        } catch (refused: WindmillApiException.Refused) {
            assertEquals(404, refused.status)
        }
    }

    @Test
    fun t11_theProbeRowsAreCleanedUp() = runBlocking {
        discardSession(sessionAId)
        discardSession(sessionBId)
        deleteRoutine(routineId)
        assertNull(adapter.session(sessionAId))
        assertNull(adapter.session(sessionBId))
        assertNull(adapter.routine(routineId))
        assertTrue(adapter.sessions(50, null, null).none { it.id == sessionAId || it.id == sessionBId })
    }

    // Signed-out training is prepared as an import before the sign-in and lands on the account whole,
    // with the phone's own ids.
    @Test
    fun t12_aSignedOutWorkoutLandsOnTheAccountAsAnImportAtSignIn() = runBlocking {
        Engine.memory(SyncSchema.registry, clock = probeClock, intentResultWrites = WorkoutImports.intentResultWrites,
            pendingDeviceWork = WorkoutImports.pendingDeviceWork, rewriteDeviceValue = WorkoutImports.rewriteDeviceValue).use { phone ->
            val signedOut = EngineTraining(phone)
            signedOut.startSession(SessionStart(importedId, startC))
            signedOut.appendSet(importedId, SetWrite(importedSetId, "back-squat", 60.0, 5, SetKind.Working, startC + 60_000))
            signedOut.finishSession(importedId, finishC)
            signedOut.prepareAdoption()
            assertEquals(listOf(importedId), signedOut.imports.retainedWorkouts().map { it.session.id })

            signIn(phone)
            drain(phone) { signedOut.firstPullComplete && signedOut.imports.retainedWorkouts().isEmpty() }
            assertEquals(emptyList<String>(), signedOut.imports.refusals().map { it.id })
        }

        drain(RecordKey(Gym.Types.session, RecordID(importedId)))
        val landed = checkNotNull(adapter.session(importedId))
        assertEquals(Session(importedId, startC, finishC), landed.session)
        assertEquals(listOf(TrainingSet(importedSetId, "back-squat", 1, 60.0, 5, SetKind.Working, null, "", startC + 60_000)),
            landed.sets)

        discardSession(importedId)
        assertNull(adapter.session(importedId))
    }

    @Test
    fun t13_finishWaitsForAdoptedSetsBeforeAndAfterTheFirstPull() = runBlocking {
        for (pullFirst in listOf(false, true)) {
            val id = "ses_adopted_${tag}_$pullFirst"
            val setId = "set_adopted_${tag}_$pullFirst"
            val at = System.currentTimeMillis() - 60_000
            Engine.memory(SyncSchema.registry, clock = probeClock, intentResultWrites = WorkoutImports.intentResultWrites,
                pendingDeviceWork = WorkoutImports.pendingDeviceWork, rewriteDeviceValue = WorkoutImports.rewriteDeviceValue).use { phone ->
                val training = EngineTraining(phone)
                training.startSession(SessionStart(id, at))
                val accepted = training.appendSet(id, SetWrite(setId, "bench-press", 80.0, 5, SetKind.Working, at + 10_000))
                training.prepareAdoption()
                signIn(phone)
                if (pullFirst) {
                    val pull = checkNotNull(phone.pullRequest(listOf(ScopeRef(Gym.scope))))
                    val send = probeClock.reading()
                    phone.onPullResponse(pull, response(transport.pull(pull, bearer)), RequestTiming(send, probeClock.reading()))
                }
                try {
                    training.finishSession(id, at + 30_000)
                    fail("Finish must wait for the adopted start and its sets")
                } catch (_: TrainingUnanswered) { }
                assertTrue(training.session(id)!!.session.isOpen)
                assertEquals(listOf(accepted), training.imports.operations().map { it.entry.set })
                drain(phone) { training.firstPullComplete && phone.read(ScopeRef(Gym.scope)) {
                    it.drawn(Gym.Types.session, RecordID(id))?.isPending == false
                } }
                training.finishSession(id, at + 30_000)
                drain(phone) { phone.read(ScopeRef(Gym.scope)) {
                    it.drawn(Gym.Types.session, RecordID(id))?.isPending == false &&
                        it.drawn(Gym.Types.set, RecordID(setId))?.isPending == false
                } }
                assertEquals(emptyList<String>(), training.imports.refusals().map { it.code })
            }
            drain()
            assertEquals(works.windmill.gym.domain.SessionDetail(Session(id, at, at + 30_000), listOf(
                TrainingSet(setId, "bench-press", 1, 80.0, 5, SetKind.Working, null, "", at + 10_000))), adapter.session(id))
            discardSession(id)
        }
    }

    @Test
    fun t14_retryRecoversAStrandedAdoptedSetAfterRestart() = runBlocking {
        val id = "ses_recovered_$tag"
        val setId = "set_recovered_$tag"
        val at = System.currentTimeMillis() - 60_000
        val snapshot = Engine.memory(SyncSchema.registry, clock = probeClock, intentResultWrites = WorkoutImports.intentResultWrites,
            pendingDeviceWork = WorkoutImports.pendingDeviceWork, rewriteDeviceValue = WorkoutImports.rewriteDeviceValue).use { phone ->
            val training = EngineTraining(phone)
            training.startSession(SessionStart(id, at))
            training.appendSet(id, SetWrite(setId, "bench-press", 80.0, 5, SetKind.Warmup, at + 10_000))
            training.prepareAdoption()
            signIn(phone)
            // The durable order written by affected versions: start, finish, then the owed set.
            phone.commit(ScopeRef(Gym.scope)) { Gesture(emptyList(), command = Command(Gym.Commands.finish,
                Json.objectOf("sessionId" to Json.of(id), "finishedAt" to Json.of(at + 30_000)))) to Unit }
            drain(phone) { training.firstPullComplete && training.session(id)?.session?.finishedAtMs == at + 30_000 }
            training.imports.refuseOperation(training.imports.operations().single(), Gym.Codes.sessionFinished)
            phone.snapshot()
        }
        Engine.memory(SyncSchema.registry, snapshot, clock = probeClock, intentResultWrites = WorkoutImports.intentResultWrites,
            pendingDeviceWork = WorkoutImports.pendingDeviceWork, rewriteDeviceValue = WorkoutImports.rewriteDeviceValue).use { phone ->
            val training = EngineTraining(phone)
            training.imports.retry(setId)
            repeat(3) {
                training.reconcileImports()
                drain(phone) { phone.read(ScopeRef(Gym.scope)) { reader ->
                    reader.drawn(Gym.Types.session, RecordID(id))?.isPending == false &&
                        reader.drawn(Gym.Types.set, RecordID(setId))?.isPending == false
                } }
            }
            assertEquals(emptyList<String>(), training.imports.refusals().map { it.code })
            assertTrue(training.imports.operations().isEmpty())
        }
        drain()
        assertEquals(works.windmill.gym.domain.SessionDetail(Session(id, at, at + 30_000), listOf(
            TrainingSet(setId, "bench-press", 1, 80.0, 5, SetKind.Warmup, null, "", at + 10_000))), adapter.session(id))
        discardSession(id)
    }

    @Test
    fun t15_aLateServerFinishRefusalRecoversTheAdoptedSetExactlyOnceAfterRestart() = runBlocking {
        val id = "ses_late_finish_$tag"
        val setId = "set_late_finish_$tag"
        val at = System.currentTimeMillis() - 90_000
        val completedAt = at + 10_000
        val note = "Late finish $tag"
        lateinit var accepted: TrainingSet
        try {
            val snapshot = Engine.memory(SyncSchema.registry, clock = probeClock, intentResultWrites = WorkoutImports.intentResultWrites,
                pendingDeviceWork = WorkoutImports.pendingDeviceWork, rewriteDeviceValue = WorkoutImports.rewriteDeviceValue).use { phone ->
                val training = EngineTraining(phone)
                training.startSession(SessionStart(id, at))
                training.appendSet(id, SetWrite(setId, "back-squat", 62.5, 6, SetKind.Warmup, completedAt))
                training.fixSet(id, setId, SetFix(note = note, rpe = 7.5, rpeNamed = true))
                accepted = training.session(id)!!.sets.single()
                training.prepareAdoption()
                signIn(phone)
                drain(phone) { training.firstPullComplete && phone.read(ScopeRef(Gym.scope)) {
                    it.confirmed(Gym.Types.session, RecordID(id))?.isVisible == true &&
                        it.drawn(Gym.Types.session, RecordID(id))?.isPending == false
                } }
                assertEquals(listOf(accepted), training.imports.operations().map { it.entry.set })
                Engine.memory(SyncSchema.registry, clock = probeClock).use { other ->
                    val remote = EngineTraining(other)
                    signIn(other)
                    drain(other) { remote.firstPullComplete }
                    remote.finishSession(id, at + 30_000)
                    drain(other) { other.read(ScopeRef(Gym.scope)) {
                        it.drawn(Gym.Types.session, RecordID(id))?.isPending == false
                    } }
                }
                training.finishSession(id, at + 40_000)
                assertTrue(training.imports.hasOwedSets(id))
                val request = checkNotNull(phone.nextPush())
                val send = probeClock.reading()
                val reply = response(transport.push(request, checkNotNull(bearer)))
                assertEquals(200, reply.status)
                assertEquals(listOf("session-finished", "ok"), reply.body!!.member("results").arr().map {
                    it["code"]?.str() ?: it.member("s").str()
                })
                phone.onPushResponse(request, reply, RequestTiming(send, probeClock.reading()))
                drain(phone) { training.session(id)?.session?.finishedAtMs == at + 30_000 }
                assertTrue(training.session(id)!!.sets.isEmpty())
                assertTrue(training.imports.hasOwedSets(id))
                phone.snapshot()
            }
            Engine.memory(SyncSchema.registry, snapshot, clock = probeClock, intentResultWrites = WorkoutImports.intentResultWrites,
                pendingDeviceWork = WorkoutImports.pendingDeviceWork, rewriteDeviceValue = WorkoutImports.rewriteDeviceValue).use { phone ->
                val training = EngineTraining(phone)
                assertEquals(snapshot.member("active").str(), phone.activeReplica())
                assertTrue(!training.anonymous)
                assertTrue(training.imports.hasOwedSets(id))
                training.imports.retry(setId)
                repeat(12) {
                    training.reconcileImports()
                    drain(phone) { phone.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }
                        .none { it.member("state").str() in setOf("ready", "sent", "held") } }
                }
                assertTrue(training.imports.refusals().isEmpty())
                assertTrue(!training.imports.hasOwedSets(id))
            }
            drain(engine) { engine.read(ScopeRef(Gym.scope)) { it.checkpoint().cleanSeq != null } }
            assertEquals(Session(id, at, at + 30_000), adapter.session(id)!!.session)
            assertTrue(adapter.session(id)!!.sets.isEmpty())
            val recovered = adapter.details().single { it.sets.any { set -> set.note == note } }
            assertEquals(Session(recovered.session.id, completedAt, completedAt), recovered.session)
            assertEquals(listOf(accepted.copy(id = recovered.sets.single().id, setNumber = 1)), recovered.sets)
            assertEquals(1, adapter.details().flatMap { it.sets }.count { it.note == note })
        } finally {
            drain(engine) { engine.read(ScopeRef(Gym.scope)) { it.checkpoint().cleanSeq != null } }
            for (detail in adapter.details().filter { it.session.id == id || it.session.startedAtMs == completedAt }) {
                if (detail.session.isOpen) finishSession(detail.session.id,
                    detail.sets.maxOfOrNull { it.completedAtMs } ?: detail.session.startedAtMs)
                discardSession(detail.session.id)
            }
        }
    }

    @Test
    fun t16_aWeighInCorrectionAndANoteDragRoundTripToAnotherPhone() = runBlocking {
        val day = java.time.LocalDate.now().minusDays(4).toString()
        val weighin = RecordKey(Gym.Types.weighin, RecordID(day))
        val noteIds = (0..2).map { "note_probe_a$tag$it" }
        try {
            adapter.putBodyweight(day, 182.0)
            drain(weighin)
            val corrected = adapter.putBodyweight(day, 82.45)
            assertEquals(82.45, corrected.weightKg, 0.0)
            drain(weighin)
            for ((index, id) in noteIds.withIndex()) {
                adapter.writeNote(id, NoteWrite("Probe $index", ""))
                drain(RecordKey(Gym.Types.note, RecordID(id)))
            }
            val expected = listOf(noteIds[1], noteIds[0], noteIds[2])
            assertTrue(adapter.moveNote(noteIds[0], expected, emptySet()))
            assertEquals(expected, adapter.notes().map { it.id })
            drain(RecordKey(Gym.Types.note, RecordID(noteIds[0])))
            Engine.memory(SyncSchema.registry, clock = probeClock).use { phone ->
                val reader = EngineTraining(phone)
                signIn(phone)
                drain(phone) { reader.firstPullComplete }
                assertEquals(listOf(corrected), reader.weighins(day, day))
                assertEquals(expected, reader.notes().map { it.id })
            }
        } finally {
            adapter.deleteBodyweight(day)
            for (id in noteIds) adapter.deleteNote(id)
            engine.releaseHeld(true)
            drain(engine) { !pending(weighin) && noteIds.none { pending(RecordKey(Gym.Types.note, RecordID(it))) } }
        }
    }

    @Test
    fun t99_aMagicLinkUrlSignsInAndTheCookieBecomesTheBearer() = runBlocking {
        val token = System.getenv("WM_WIRE_LINK_TOKEN")
        assumeTrue("WM_WIRE_LINK_TOKEN not set — verify leg skipped", token != null)

        val url = "https://windmill.works/#/auth?token=$token"
        assertEquals(token, MagicLink.token(url))

        val sessions = MemorySessions()
        val auth = AuthStore(base, sessions)
        try {
            auth.completeLink(url)
        } catch (refused: WindmillApiException.Refused) {
            assumeTrue(
                "LINK_TOKEN already spent (410 ${refused.refusal.code}) — single-use; mint a fresh one to run this leg",
                !(refused.status == 410 && refused.refusal.code == "expired"),
            )
            throw refused
        }

        val user = (auth.status as AuthStatus.SignedIn).user
        val captured = sessions.read()
        assertNotNull("the secret arrives ONLY as Set-Cookie wm_session and must be captured", captured)
        assertNull("a completed link clears the waiting state", auth.linkSentTo)

        val me = WindmillApi(base, { captured }).get<UserResponse>("/v1/me").user
        assertEquals(user, me)
    }
}
