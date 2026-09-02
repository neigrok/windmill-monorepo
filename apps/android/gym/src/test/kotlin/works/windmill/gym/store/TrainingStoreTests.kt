package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.AskTurn
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.ThreadOutcome
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Prefill
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalIntent
import works.windmill.gym.domain.ProposalSource
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.ReadTally
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.RoutineEvent
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TheSix
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.Units
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson

private fun refusal(status: Int, code: String? = null, message: String) =
    WindmillApiException.Refused(status, Refusal(message = message, code = code))

private val storageFailure = refusal(500, message = "internal error")

private class LosingStartReplies(private val inner: FakeTraining) : TrainingSyncing by inner {
    var losing = true

    override suspend fun startSession(start: SessionStart): Session {
        val opened = inner.startSession(start)
        if (losing) throw IOException("the reply was lost")
        return opened
    }
}

class TrainingStoreTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private var clockMs = 1_000L
    private lateinit var queueFile: File
    private lateinit var catalogFile: File
    private lateinit var localFile: File
    private lateinit var preferencesFile: File
    private lateinit var bodyweightFile: File

    @Before
    fun setUp() {
        clockMs = 1_000
        queueFile = File(tmp.root, "gym-${System.nanoTime()}.json")
        catalogFile = File(tmp.root, "gym-catalog-${System.nanoTime()}.json")
        localFile = File(tmp.root, "gym-local-${System.nanoTime()}.json")
        preferencesFile = File(tmp.root, "gym-prefs-${System.nanoTime()}.json")
        bodyweightFile = File(tmp.root, "gym-bodyweight-${System.nanoTime()}.json")
    }

    private fun TestScope.makeStore(
        sync: TrainingSyncing?,
        mintSet: () -> String = Ids::set,
        mintSession: () -> String = { "ses_minted" },
        retryAfterMs: Long = 4_000,
        undoWindowMs: Long = 0,
        deviceOwner: String? = null,
    ) = TrainingStore(
        queue = SetQueue(queueFile, deviceOwner) { clockMs },
        deviceCopy = DeviceCopy(catalogFile),
        localLog = LocalLog(localFile, deviceOwner),
        localPreferences = LocalPreferences(preferencesFile),
        localBodyweight = LocalBodyweight(bodyweightFile),
        scope = backgroundScope,
        now = { clockMs += 1; clockMs },
        mintSession = mintSession,
        mintSet = mintSet,
        undoWindowMs = undoWindowMs,
        retryAfterMs = retryAfterMs,
        sync = { if (it.isSignedIn) sync else null },
    )

    private fun TestScope.makeStore(
        logs: Map<String, TrainingSyncing>,
        deviceOwner: String? = null,
    ) = TrainingStore(
        queue = SetQueue(queueFile, deviceOwner) { clockMs },
        deviceCopy = DeviceCopy(catalogFile),
        localLog = LocalLog(localFile, deviceOwner),
        localPreferences = LocalPreferences(preferencesFile),
        localBodyweight = LocalBodyweight(bodyweightFile),
        scope = backgroundScope,
        now = { clockMs += 1; clockMs },
        mintSession = { "ses_minted" },
        undoWindowMs = 0,
        sync = { seat -> seat.user?.id?.let { logs[it] } },
    )

    private val legacyShelf =
        """{"finished":[{"session":{"id":"ses_before","startedAt":1000,"finishedAt":2000},""" +
            """"sets":[{"id":"set_before","exerciseId":"bench-press","weightKg":90.0,""" +
            """"reps":5,"completedAt":1100}]}]}"""

    private fun queueOnDisk(owner: String? = "u1") = SetQueue(queueFile, owner)

    private fun shelfOnDisk(owner: String? = "u1") = LocalLog(localFile, owner)

    private fun account(signedIn: Boolean, id: String = "u1") = Account(
        api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
        user = if (signedIn) User(id = id, email = "sam@example.com", name = "Sam") else null,
    )

    private suspend fun TestScope.liveStore(
        server: FakeTraining,
        movement: String = "bench-press",
        plan: PlanSnapshot? = null,
        mintSet: () -> String = Ids::set,
        retryAfterMs: Long = 4_000,
        undoWindowMs: Long = 0,
    ): TrainingStore {
        server.open(Session(id = "ses_1", startedAtMs = 1_000, plan = plan))
        val store = makeStore(sync = server, mintSet = mintSet, retryAfterMs = retryAfterMs,
            undoWindowMs = undoWindowMs)
        store.connect(account(signedIn = true))
        store.choose(movement)
        return store
    }

    @Test
    fun testASetLoggedOfflineSurvivesARelaunchAndFlushesOnReconnect() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.online = false
        store.logSet(weightKg = 82.5, reps = 5)

        assertEquals(SaveState.Blocked(Blocker.Offline), store.saveState)
        assertEquals("offline · saved here", store.saveState.line)
        assertEquals("the row is on screen — the device is holding it",
            listOf(82.5), store.sets.map { it.weightKg })
        assertEquals(1, queueOnDisk().pending.size)

        server.online = true
        val relaunched = makeStore(sync = server)
        relaunched.connect(account(signedIn = true))

        assertEquals(listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals("the log numbered it, so it is the log's now",
            listOf(1), relaunched.sets.map { it.setNumber })
        assertTrue(queueOnDisk().pending.isEmpty())
    }

    @Test
    fun testASetIdAlreadySpentIsMintedAgainAndLands() = runTest {
        val server = FakeTraining()
        val ids = mutableListOf("set_first", "set_second")
        val store = liveStore(server, mintSet = { ids.removeAt(0) })

        var spent = false
        server.refuse = {
            if (spent) null else {
                spent = true
                refusal(409, code = "set-id-taken", message = "a sentence nobody has ever shipped")
            }
        }
        store.logSet(weightKg = 100.0, reps = 3)

        assertEquals(listOf("set_first", "set_second"), server.appended.map { it.id })
        assertEquals(listOf("set_second"), server.sets.getValue("ses_1").map { it.id })
        assertEquals(listOf("set_second"), store.sets.map { it.id })
        assertEquals(SaveState.OnTheLog, store.saveState)
        assertTrue("a repaired collision is not a loss and must not be said",
            store.refusals.isEmpty())
    }

    @Test
    fun testASetRefusedByAClosedSessionIsDroppedAndSaidOutLoud() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.refuse = { refusal(409, code = "session-finished", message = "reworded on a Tuesday") }
        store.logSet(weightKg = 60.0, reps = 10)

        assertTrue("a set that never landed is not drawn as though it had", store.sets.isEmpty())
        assertEquals(listOf("the session closed before this set reached it"),
            store.refusals.map { it.reason })
        assertEquals(listOf("bench-press"), store.refusals.map { (it as RefusedSet).exerciseId })
        assertEquals(listOf(60.0), store.refusals.map { (it as RefusedSet).weightKg })
        assertEquals("the session closed before this set reached it", store.saveState.line)
        assertTrue(queueOnDisk().pending.isEmpty())
    }

    @Test
    fun testAReplyThatNeverArrivedIsReplayedAndTheLogStillHoldsOneRow() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.swallowReplies = 1
        store.logSet(weightKg = 82.5, reps = 5)
        assertEquals(SaveState.Blocked(Blocker.Offline), store.saveState)
        assertEquals(1, queueOnDisk().pending.size)

        store.flushPendingSets()

        assertEquals("the same set went out twice", 2, server.appended.size)
        assertEquals("and the log converged on one row", 1, server.sets.getValue("ses_1").size)
        assertEquals(listOf(1), store.sets.map { it.setNumber })
        assertEquals(SaveState.OnTheLog, store.saveState)
    }

    @Test
    fun testFinishingSendsWhatIsOwedBeforeItClosesTheSession() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.online = false
        store.logSet(weightKg = 100.0, reps = 5)
        store.logSet(weightKg = 100.0, reps = 5)
        server.online = true

        val outcome = store.finish()

        assertEquals(2, server.sets.getValue("ses_1").size)
        val closed = (outcome as? FinishOutcome.Closed)?.session
        assertNotNull("the session did not close: $outcome", closed)
        assertFalse(closed!!.isOpen)
        assertNull("the room has nothing running once the log has answered", store.session)

        val landed = server.calls.lastIndexOf("append")
        val finished = server.calls.indexOf("finish")
        assertTrue(landed >= 0)
        assertTrue(finished >= 0)
        assertTrue("every set of this session is on the log before it closes", landed < finished)
    }

    @Test
    fun testFinishingIsRefusedWhileASetOfThisSessionIsStillOwed() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.online = false
        store.logSet(weightKg = 100.0, reps = 5)
        val outcome = store.finish()

        assertEquals(FinishOutcome.Stranded(1), outcome)
        assertFalse(server.calls.contains("finish"))
        assertNotNull("the session stays open — a closed one could not take that set", store.session)
    }

    @Test
    fun testASetTappedWhileTheSessionIsClosingIsNotFiledIntoIt() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.onFinish = { store.logSet(weightKg = 60.0, reps = 10) }
        val outcome = store.finish()

        assertTrue("the session did not close: $outcome", outcome is FinishOutcome.Closed)
        assertNull("nothing was filed into a session that was closing", server.sets["ses_1"])
        assertTrue("and nothing was left owed against it", queueOnDisk().pending.isEmpty())
    }

    @Test
    fun testAStorageFailureKeepsTheSetQueuedRatherThanRefusingIt() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.refuse = { storageFailure }
        store.logSet(weightKg = 90.0, reps = 5)

        assertEquals(1, queueOnDisk().pending.size)
        assertTrue("the server failing is not the set being refused", store.refusals.isEmpty())
        assertEquals("and a log that answered 500 is not a missing signal — the note names the log",
            SaveState.Blocked(Blocker.LogFailed), store.saveState)
        assertEquals("the log didn’t answer · saved here", store.saveState.line)
        assertEquals(Blocker.LogFailed, store.strandedBy)
        assertEquals("the row stays on screen — the device is holding it", 1, store.sets.size)
    }

    @Test
    fun testASetThatCannotLandHoldsUpItsOwnMovementAndNoOther() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.refuse = { if (it.exerciseId == "bench-press") storageFailure else null }
        store.logSet(weightKg = 82.5, reps = 5)
        store.choose("back-squat")
        store.logSet(weightKg = 100.0, reps = 5)

        assertEquals(listOf("back-squat"), server.sets.getValue("ses_1").map { it.exerciseId })
        assertEquals(listOf("bench-press"), queueOnDisk().pending.map { it.set.exerciseId })
        assertEquals("both are on screen — one is on the log and one is on the device",
            listOf("bench-press", "back-squat"), store.sets.map { it.exerciseId })
    }

    @Test
    fun testStartingWhileASessionIsOpenRefusesAndSurfacesTheOpenWorkout() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        server.open(Session(id = "ses_live", startedAtMs = 500,
            plan = PlanSnapshot(routine = "Push A",
                entries = listOf(PlanEntry(exerciseId = "bench-press", sets = 5,
                    reps = 5, weightKg = 82.5)))))
        server.sets["ses_live"] = mutableListOf(TrainingSet(id = "set_old",
            exerciseId = "bench-press", setNumber = 1, weightKg = 82.5, reps = 5,
            completedAtMs = 600))

        val refused = store.start(routineId = "rt_other")

        assertTrue("a start while a workout is open is a refusal, never a silent join: $refused",
            refused is GymResult.Failed)
        assertEquals("the refusal is the log's own sentence",
            "a session is already open",
            ((refused as GymResult.Failed).why as WriteFailure.Refused).said)
        assertEquals("every user-tapped start states the flag as an explicit false",
            listOf(false), server.started.map { it.joinOpenSession })
        assertEquals("the refresh adopted the open workout, with its own snapshot",
            "ses_live", store.session?.id)
        assertEquals("Push A", store.session?.plan?.routine)
        assertEquals("and the sets already logged into it",
            listOf("set_old"), store.sets.map { it.id })
        assertEquals("and stands where the last set went, not in the picker over a session of sets",
            "bench-press", store.exerciseId)
    }

    @Test
    fun testThePrefillTakesThePlanUntilTheLifterHasLiftedSomething() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000,
            plan = PlanSnapshot(routine = "Push A",
                entries = listOf(PlanEntry(exerciseId = "bench-press", sets = 5,
                    reps = 5, weightKg = 82.5)))))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        store.choose("bench-press")

        assertEquals(Prefill(weightKg = 82.5, reps = 5), store.prefill)

        store.logSet(weightKg = 85.0, reps = 4)
        assertEquals("the sticky carry-forward follows the thumb",
            Prefill(weightKg = 85.0, reps = 4), store.prefill)
    }

    @Test
    fun testSignedOutASessionRunsFinishesAndSurvivesARelaunch() = runTest {
        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))
        assertEquals(SaveState.Idle, store.saveState)

        val opened = (store.start() as GymResult.Ok).value
        assertEquals("ses_minted", opened.id)
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)

        assertEquals(listOf(82.5), store.sets.map { it.weightKg })
        assertEquals("saved on this device", store.saveState.line)

        clockMs += 60_000
        val ended = (store.finish() as FinishOutcome.Closed).session
        assertFalse(ended.isOpen)
        assertNull(store.session)
        assertEquals(listOf("ses_minted"), store.recent.map { it.id })
        assertEquals(listOf(1), store.recent.map { it.setCount })

        val relaunched = makeStore(sync = null)
        relaunched.connect(account(signedIn = false))
        assertEquals(listOf("ses_minted"), relaunched.recent.map { it.id })
        assertEquals("the queue let go — the shelf is the one owner of a finished local session",
            0, queueOnDisk(null).pending.size)
        assertEquals(listOf(82.5), shelfOnDisk(null).details().single().sets.map { it.weightKg })
    }

    @Test
    fun testSignedOutARoutineIsKeptStartedFromAndRetargeted() = runTest {
        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))

        val performed = listOf(
            TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 100.0, reps = 5, completedAtMs = 1_100),
            TrainingSet(id = "set_b", exerciseId = "bench-press", weightKg = 100.0, reps = 5, completedAtMs = 1_200),
        )
        val kept = (store.keep(performed, asRoutineNamed = "Push Day") as GymResult.Ok).value
        assertTrue(kept.id.startsWith("rt_"))
        assertEquals(listOf("Push Day"), store.routines.map { it.name })

        val opened = (store.start(routineId = kept.id) as GymResult.Ok).value
        assertEquals("Push Day", opened.plan?.routine)
        store.choose("bench-press")
        assertEquals("the prefill dials the local plan", Prefill(100.0, 5), store.prefill)

        assertNull(store.save(105.0, toRoutine = kept.id, atPosition = 1, forExercise = "bench-press"))
        assertEquals(105.0,
            store.routines.first { it.id == kept.id }.entries.first().targetWeightKg)
        assertEquals("and the shelf holds the retargeted document for the claim",
            105.0, shelfOnDisk(null).routine(kept.id)?.entries?.first()?.targetWeightKg)
    }

    @Test
    fun testSignedOutLastTimeAndPrefillComeFromTheDeviceHistory() = runTest {
        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))

        store.start()
        store.choose("bench-press")
        assertEquals("no history is a first time, not a failure", false, store.lastTimeFailed)
        assertEquals(true, store.lastTime?.isFirstTime)

        store.logSet(weightKg = 60.0, reps = 10, kind = SetKind.Warmup)
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()

        store.start()
        store.choose("bench-press")
        assertEquals("the working set carries, the warmup does not",
            listOf(82.5), store.lastTime?.sets?.map { it.weightKg })
        assertEquals(Prefill(82.5, 5), store.prefill)
    }

    @Test
    fun testSignedOutTheRecordAndTheReviewAreComputedFromTheShelf() = runTest {
        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))
        val movement = (store.create("Bench Press", "barbell") as GymResult.Ok).value

        store.start()
        store.choose(movement.id)
        store.logSet(weightKg = 60.0, reps = 10, kind = SetKind.Warmup)
        repeat(4) { store.logSet(weightKg = 82.5, reps = 5) }
        clockMs += 60_000
        val ended = (store.finish() as FinishOutcome.Closed).session

        val record = (store.record(movement.id) as GymResult.Ok).value
        assertEquals("Bench Press", record.exercise.name)
        assertEquals(1, record.sessionCount)
        assertEquals(0, record.routineCount)
        assertEquals(82.5, record.heaviest?.weightKg)
        assertEquals(ended.startedAtMs, record.heaviest?.atMs)
        assertNull("no estimate is computed on this phone", record.heaviest?.e1rm)
        assertNull("and no best e1RM either, so the page draws no chart", record.bestE1rm)
        assertEquals(emptyList<Any>(), record.e1rmSeries)
        assertEquals(emptyList<Any>(), record.records)
        assertEquals(listOf(ended.id), record.recentDays.map { it.sessionId })
        assertEquals("a warmup counts toward nothing, here as everywhere",
            listOf(82.5, 82.5, 82.5, 82.5), record.recentDays.single().sets.map { it.weightKg })

        val review = store.review(ended.id)
        assertEquals(4, review?.stats?.workingSets)
        assertEquals(false, review?.slight)
        assertNull("no estimate is computed on this phone", review?.stats?.topE1rm)

        val detail = (store.sessionDetail(ended.id) as GymResult.Ok).value
        assertEquals(5, detail.sets.size)
    }

    @Test
    fun testARenameMovesTheNameAndNeverTheIdAndTheShelfKeepsIt() = runTest {
        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))
        val movement = (store.create("Bench Pres", "barbell") as GymResult.Ok).value

        store.start()
        store.choose(movement.id)
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()

        assertEquals("the page draws the movement the write confirmed, not the string typed at it",
            Exercise(id = movement.id, name = "Bench Press", custom = true),
            (store.rename(movement.id, " Bench Press ") as GymResult.Ok).value)
        assertEquals("Bench Press", store.catalog.single { it.id == movement.id }.name)

        val record = (store.record(movement.id) as GymResult.Ok).value
        assertEquals("Bench Press", record.exercise.name)
        assertEquals("the history is whole — the id never moved", 1, record.sessionCount)

        assertEquals("a movement needs a name",
            ((store.rename(movement.id, "   ") as GymResult.Failed).why as WriteFailure.Refused).said)
        assertEquals("renaming a catalog movement needs your account — sign in first",
            ((store.rename("back-squat", "Squat") as GymResult.Failed).why as WriteFailure.Refused).said)

        val relaunched = makeStore(sync = null)
        relaunched.connect(account(signedIn = false))
        assertEquals("Bench Press", relaunched.catalog.single { it.id == movement.id }.name)
    }

    @Test
    fun testSignedInARenameGoesToTheLogAndTheCatalogFollowsIt() = runTest {
        val server = FakeTraining()
        server.catalog = listOf(Exercise(id = "back-squat", name = "Back Squat"))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        assertEquals("Low-bar Squat", (store.rename("back-squat", "Low-bar Squat") as GymResult.Ok).value.name)

        assertEquals(listOf("renameExercise"), server.calls.filter { it == "renameExercise" })
        assertEquals("Low-bar Squat", server.catalog.single().name)
        assertEquals("Low-bar Squat", store.catalog.single { it.id == "back-squat" }.name)
        assertEquals("the id is what every set points at, and it did not move",
            "back-squat", store.catalog.single { it.id == "back-squat" }.id)
    }

    @Test
    fun testARenameIsTheAccountsAndNeverCrossesToTheNextSeatOnThisPhone() = runTest {
        val hers = FakeTraining()
        hers.catalog = listOf(Exercise(id = "back-squat", name = "Back Squat"))
        val alice = makeStore(sync = hers)
        alice.connect(account(signedIn = true, id = "alice"))
        alice.rename("back-squat", "Alice’s Secret Squat")

        val herRelaunch = makeStore(sync = null)
        herRelaunch.connect(account(signedIn = true, id = "alice"))
        assertEquals("Alice’s Secret Squat", herRelaunch.catalog.single { it.id == "back-squat" }.name)

        val bob = makeStore(sync = null)
        bob.connect(account(signedIn = true, id = "bob"))
        assertEquals("this phone does not know Bob's names and does not borrow Alice's",
            TheSix.movements, bob.catalog)

        val anon = makeStore(sync = null)
        anon.connect(account(signedIn = false))
        assertEquals("and signing out is not a way back into her catalog either",
            TheSix.movements, anon.catalog)
    }

    @Test
    fun testTheShelfsOwnMovementsSurviveARelaunchAndTheSeatTheySignInto() = runTest {
        val anon = makeStore(sync = null)
        anon.connect(account(signedIn = false))
        val made = (anon.create("Sled Push", "machine") as GymResult.Ok).value

        val relaunched = makeStore(sync = null)
        relaunched.connect(account(signedIn = false))
        assertEquals(TheSix.movements + made, relaunched.catalog)

        val newSeat = makeStore(sync = null)
        newSeat.connect(account(signedIn = true, id = "alice"))
        assertEquals(listOf(made) + TheSix.movements, newSeat.catalog)
    }

    @Test
    fun testARecordTheLogRefusesSaysWhyRatherThanDrawingNothing() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        assertEquals("that movement is no longer on the log",
            ((store.record("back-squat") as GymResult.Failed).why as WriteFailure.Refused).said)

        server.refuseRecord = refusal(500, message = "internal error")
        assertEquals("internal error",
            ((store.record("back-squat") as GymResult.Failed).why as WriteFailure.Refused).said)

        server.refuseRecord = null
        server.online = false
        assertEquals(WriteFailure.NoAnswer, (store.record("back-squat") as GymResult.Failed).why)
    }

    @Test
    fun testSigningInClaimsTheShelfInOrderAndTheServerBecomesTheTruth() = runTest {
        val server = FakeTraining()
        val minted = mutableListOf("ses_a", "ses_b")
        val store = makeStore(sync = server, mintSession = { minted.removeAt(0) })
        store.connect(account(signedIn = false))

        val kept = (store.keep(listOf(
            TrainingSet(id = "set_seed", exerciseId = "bench-press", weightKg = 100.0, reps = 5,
                completedAtMs = 900)), asRoutineNamed = "Push Day") as GymResult.Ok).value
        val startedA = (store.start(routineId = kept.id) as GymResult.Ok).value.startedAtMs
        store.choose("bench-press")
        store.logSet(weightKg = 100.0, reps = 5)
        store.logSet(weightKg = 102.5, reps = 3)
        clockMs += 60_000
        store.finish()
        store.start()
        store.choose("back-squat")
        store.logSet(weightKg = 140.0, reps = 5)

        store.connect(account(signedIn = true))

        val walk = server.calls.filter { it in setOf("createRoutine", "start", "append", "finish", "sessions") }
        assertEquals("the contract's order, and the boot read only after the claim",
            listOf("createRoutine", "start", "append", "append", "finish", "start", "append", "sessions"),
            walk)
        assertEquals("every claimed start declines to join",
            listOf(false, false), server.started.map { it.joinOpenSession })
        assertEquals("the true instants ride, not the sign-in's",
            startedA, server.started.first().startedAt)
        assertEquals(listOf("rt_"), server.started.map { it.routineId?.take(3) }.filterNotNull().distinct())
        assertEquals(listOf(100.0, 102.5), server.sets.getValue("ses_a").map { it.weightKg })
        assertFalse(server.stored.getValue("ses_a").isOpen)
        assertEquals("Push Day", server.written.values.single().name)

        assertTrue(server.stored.getValue("ses_b").isOpen)
        assertEquals(listOf(140.0), server.sets.getValue("ses_b").map { it.weightKg })
        assertEquals("the room stands in the claimed live workout", "ses_b", store.session?.id)

        assertTrue("the shelf let go of everything the server confirmed",
            shelfOnDisk().finished.isEmpty() && shelfOnDisk().routines.isEmpty())
        assertEquals("and the log lists what the shelf held",
            setOf("ses_a", "ses_b"), store.recent.map { it.id }.toSet())
    }

    @Test
    fun testAClaimedSessionIdAlreadySpentIsMintedAgainAndTheWorkoutLandsWhole() = runTest {
        val server = FakeTraining()
        val minted = mutableListOf("ses_spent", "ses_fresh")
        val store = makeStore(sync = server, mintSession = { minted.removeAt(0) })
        store.connect(account(signedIn = false))

        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()

        server.refuseStart = { start ->
            if (start.id == "ses_spent")
                refusal(409, code = "session-id-taken", message = "that id names a row elsewhere")
            else null
        }
        store.connect(account(signedIn = true))

        assertNull("nothing landed under the spent id", server.stored["ses_spent"])
        assertEquals(listOf(82.5), server.sets.getValue("ses_fresh").map { it.weightKg })
        assertFalse(server.stored.getValue("ses_fresh").isOpen)
        assertTrue(shelfOnDisk().finished.isEmpty())
    }

    @Test
    fun testAClaimWaitsWholeWhileTheAccountsOtherWorkoutIsOpen() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_phone2", startedAtMs = 500))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))

        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()

        store.connect(account(signedIn = true))

        assertNull("nothing was filed into the other device's workout", server.sets["ses_phone2"])
        assertEquals(1, shelfOnDisk().finished.size)
        assertTrue("the boot read still ran", server.calls.contains("sessions"))
        assertEquals("the reader sees the log and the shelf together",
            setOf("ses_phone2", "ses_minted"), store.recent.map { it.id }.toSet())
    }

    @Test
    fun testAnOfflineClaimKeepsTheShelfWholeAndTheNextConnectLandsIt() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))

        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()

        server.online = false
        store.connect(account(signedIn = true))
        assertEquals(1, shelfOnDisk().finished.size)
        assertTrue(store.refusals.isEmpty())

        server.online = true
        store.connect(account(signedIn = true))
        assertEquals(listOf(82.5), server.sets.getValue("ses_minted").map { it.weightKg })
        assertTrue(shelfOnDisk().finished.isEmpty())
    }

    @Test
    fun testAnOfflineClaimRetriesOnTheDeliverCadenceAndLandsWithoutARemount() = runTest {
        val server = FakeTraining()
        val minted = mutableListOf("ses_a", "ses_b")
        val store = makeStore(sync = server, mintSession = { minted.removeAt(0) })
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()

        server.online = false
        store.connect(account(signedIn = true))
        assertEquals("the boot claim stopped offline — nothing lost, nothing said",
            1, shelfOnDisk().finished.size)
        assertTrue(store.refusals.isEmpty())
        val attempted = server.started.size

        advanceTimeBy(4_100)
        runCurrent()
        assertTrue("the cadence retried the claim on its own, with nobody tapping anything",
            server.started.size > attempted)
        assertEquals("still offline — the shelf keeps everything", 1, shelfOnDisk().finished.size)

        server.online = true
        val gate = CompletableDeferred<Unit>()
        server.onFinish = { gate.await() }
        advanceTimeBy(4_100)
        runCurrent()
        val opened = (store.start() as GymResult.Ok).value
        assertEquals("a start during the scheduled re-claim composes on the device", "ses_b", opened.id)
        store.choose("back-squat")
        store.logSet(weightKg = 999.0, reps = 1)
        assertTrue("and its sets are parked, never filed into the replay",
            server.appended.none { it.weightKg == 999.0 })

        server.onFinish = {}
        gate.complete(Unit)
        runCurrent()

        assertEquals(listOf(82.5), server.sets.getValue("ses_a").map { it.weightKg })
        assertFalse(server.stored.getValue("ses_a").isOpen)
        assertTrue("the shelf let go once the log confirmed", shelfOnDisk().finished.isEmpty())
        assertEquals("the re-claim landed the device-composed workout too, without any remount",
            listOf(999.0), server.sets.getValue("ses_b").map { it.weightKg })
        assertTrue(server.stored.getValue("ses_b").isOpen)
        assertEquals("the room stands in its claimed workout", "ses_b", store.session?.id)
    }

    @Test
    fun testAFinishDuringTheCadenceReclaimNeverAdoptsTheMidReplaySession() = runTest {
        val server = FakeTraining()
        val minted = mutableListOf("ses_a", "ses_b")
        val store = makeStore(sync = server, mintSession = { minted.removeAt(0) })
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()
        store.start()
        store.choose("back-squat")
        store.logSet(weightKg = 999.0, reps = 1)

        server.online = false
        store.connect(account(signedIn = true))

        server.online = true
        val gateA = CompletableDeferred<Unit>()
        val gateB = CompletableDeferred<Unit>()
        val parked = mutableSetOf<String>()
        server.onFinish = {
            val id = server.finished.last().first
            if (parked.add(id)) when (id) {
                "ses_a" -> gateA.await()
                "ses_b" -> gateB.await()
            }
        }
        advanceTimeBy(4_100)
        runCurrent()
        assertTrue("the cadence's re-claim stands parked inside the replayed session's finish",
            server.stored.getValue("ses_a").isOpen)

        var closed: FinishOutcome? = null
        val finishing = launch { closed = store.finish() }
        runCurrent()
        assertTrue("the local finish completed without waiting on the running claim: $closed",
            closed is FinishOutcome.Closed)
        assertNull("and it started no second replay while one was mid-flight",
            server.stored["ses_b"])
        assertNull(store.session)

        gateA.complete(Unit)
        runCurrent()
        assertTrue("the deferred re-run reopened the finished workout on the log to replay it",
            server.stored.getValue("ses_b").isOpen)
        assertNull("and the store never adopts the mid-replay session as the phone's live workout",
            store.session)

        gateB.complete(Unit)
        runCurrent()
        finishing.join()

        assertEquals("ses_b", (closed as FinishOutcome.Closed).session.id)
        assertNull("nothing stands running once the replay is over", store.session)
        assertFalse(server.stored.getValue("ses_a").isOpen)
        assertFalse(server.stored.getValue("ses_b").isOpen)
        assertEquals(listOf(82.5), server.sets.getValue("ses_a").map { it.weightKg })
        assertEquals(listOf(999.0), server.sets.getValue("ses_b").map { it.weightKg })
        assertTrue("the shelf let go of both", shelfOnDisk().finished.isEmpty())
        assertEquals("and the eventual log read lands clean — both workouts listed, neither open",
            setOf("ses_a", "ses_b"), store.recent.map { it.id }.toSet())
        assertTrue(store.recent.none { it.session.isOpen })
        assertTrue(store.refusals.isEmpty())
    }

    @Test
    fun testAClaimRequestedMidReplayRunsOnceMoreAfterItRatherThanOverlapping() = runTest {
        val server = FakeTraining()
        val minted = mutableListOf("ses_a", "ses_b")
        val store = makeStore(sync = server, mintSession = { minted.removeAt(0) })
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()
        store.start()
        store.choose("back-squat")
        store.logSet(weightKg = 999.0, reps = 1)

        val gate = CompletableDeferred<Unit>()
        server.onFinish = { if (server.finished.last().first == "ses_a") gate.await() }
        val connecting = launch { store.connect(account(signedIn = true)) }
        runCurrent()
        assertEquals("the boot claim stands parked inside the shelved session's finish",
            listOf("ses_a"), server.started.map { it.id })

        var closed: FinishOutcome? = null
        val finishing = launch { closed = store.finish() }
        runCurrent()
        assertTrue("the local finish completed without waiting on the running claim: $closed",
            closed is FinishOutcome.Closed)
        assertEquals("no second replay went to the wire while one was mid-flight",
            listOf("ses_a"), server.started.map { it.id })

        gate.complete(Unit)
        connecting.join()
        finishing.join()
        runCurrent()

        assertEquals("the claim went once more when its pass ended — each session claimed exactly once",
            listOf("ses_a", "ses_b"), server.started.map { it.id })
        assertFalse(server.stored.getValue("ses_a").isOpen)
        assertFalse(server.stored.getValue("ses_b").isOpen)
        assertEquals(listOf(999.0), server.sets.getValue("ses_b").map { it.weightKg })
        assertTrue(shelfOnDisk().finished.isEmpty())
        assertNull(store.session)
        assertTrue(store.refusals.isEmpty())
    }

    @Test
    fun testABootClaimLossWithNoLiveSessionSurfacesOnTodayAndDismissClears() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        val kept = (store.keep(listOf(TrainingSet(id = "set_seed", exerciseId = "bench-press", weightKg = 100.0,
            reps = 5, completedAtMs = 900)), asRoutineNamed = "Push Day") as GymResult.Ok).value

        server.refuseRoutine = { refusal(400, code = "bad-routine", message = "that document is unclaimable") }
        store.connect(account(signedIn = true))

        assertEquals("the loss is said by name, through the store fact Today draws the banner from",
            listOf(RefusedClaim(id = kept.id, name = "Push Day", reason = "that document is unclaimable")),
            store.refusals)
        assertNull("no logger is mounted — Today is the standing screen", store.session)
        assertTrue("said once and let go, not re-said on the next connect",
            shelfOnDisk().routines.isEmpty())

        store.clearRefusals()
        assertEquals("dismissing clears what was shown", emptyList<RefusedWrite>(), store.refusals)
    }

    @Test
    fun testAClaimedSetRefusedForeverIsDroppedAndSaidAndTheRestSettles() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))

        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()

        server.stored["ses_minted"] = Session(id = "ses_minted", startedAtMs = 1_000, finishedAtMs = 2_000)
        server.refuse = { refusal(409, code = "session-finished", message = "reworded on a Tuesday") }
        store.connect(account(signedIn = true))

        assertEquals(listOf("the session closed before this set reached it"),
            store.refusals.map { it.reason })
        assertEquals(listOf(82.5), store.refusals.map { (it as RefusedSet).weightKg })
        assertTrue("the shelf let go — a loss said once is not re-said every connect",
            shelfOnDisk().finished.isEmpty())
    }

    @Test
    fun testAWarmupIsWrittenAsAWarmupAndCarriesNothingForward() = runTest {
        val server = FakeTraining()
        val plan = PlanSnapshot(routine = "Legs", entries = listOf(
            PlanEntry(exerciseId = "back-squat", sets = 5, reps = 5, weightKg = 100.0)))
        val store = liveStore(server, movement = "back-squat", plan = plan)
        assertEquals(Prefill(weightKg = 100.0, reps = 5), store.prefill)

        store.logSet(weightKg = 60.0, reps = 10, kind = SetKind.Warmup)

        assertEquals("the kind travels on the wire",
            listOf(SetKind.Warmup), server.appended.map { it.kind })
        assertEquals(listOf(SetKind.Warmup), server.sets.getValue("ses_1").map { it.kind })
        assertEquals(listOf(SetKind.Warmup), store.sets.map { it.kind })
        assertEquals("a ramp-up is not the weight the next set starts from — the dial stays on the plan",
            Prefill(weightKg = 100.0, reps = 5), store.prefill)

        store.logSet(weightKg = 100.0, reps = 5)
        assertEquals(listOf(SetKind.Warmup, SetKind.Working), store.sets.map { it.kind })
        assertEquals(Prefill(weightKg = 100.0, reps = 5), store.prefill)

        store.logSet(weightKg = 105.0, reps = 3)
        assertEquals("and a working set does carry, past the warmup that came before it",
            Prefill(weightKg = 105.0, reps = 3), store.prefill)
    }

    @Test
    fun testARefusalInOneLaneStillLeavesTheOtherLaneCarriedAndCounted() = runTest {
        val server = FakeTraining()
        val store = liveStore(server, retryAfterMs = 100)

        server.refuse = { write ->
            if (write.exerciseId == "bench-press") storageFailure
            else refusal(400, code = "unknown-exercise", message = "no such exercise")
        }
        store.logSet(weightKg = 82.5, reps = 5)
        store.choose("zercher-squat")
        store.logSet(weightKg = 100.0, reps = 5)

        assertEquals(listOf("zercher-squat"), store.refusals.map { (it as RefusedSet).exerciseId })
        assertEquals(SaveState.Refused("that movement is not in the catalog"), store.saveState)
        assertEquals(listOf("bench-press"), queueOnDisk().pending.map { it.set.exerciseId })
        assertEquals("the strip says the bench set is on this device, whatever the other lane answered",
            1, store.strandedCount)

        val sent = server.appended.count { it.exerciseId == "bench-press" }
        advanceTimeBy(400)
        runCurrent()
        assertTrue("and the retry fired on its own, with nobody tapping anything",
            server.appended.count { it.exerciseId == "bench-press" } > sent)
    }

    @Test
    fun testAStartRefusedForANamedReasonSaysTheReason() = runTest {
        val server = FakeTraining()
        server.refuseStart = { refusal(404, message = "no such routine") }
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        val why = (store.start(routineId = "rt_deleted_elsewhere") as? GymResult.Failed)?.why
        assertEquals("a 404 is not a session", WriteFailure.Refused("no such routine"), why)
        assertEquals("no such routine", why?.line("nothing started"))
        assertNull(store.session)
    }

    @Test
    fun testSignedInWithNoSignalAStartComposesOnTheDeviceAndTheClaimLandsIt() = runTest {
        for (quiet in listOf<(FakeTraining) -> Unit>(
            { it.online = false },
            { it.refuseStart = { storageFailure } },
            { it.refuseStart = { refusal(400, code = "clock-ahead", message = "that start is in the future") } },
        )) {
            setUp()
            val server = FakeTraining()
            server.written["rt_push"] = Routine(id = "rt_push", name = "Push Day", entries = listOf(
                RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 3, targetReps = 5,
                    targetWeightKg = 100.0)))
            val store = makeStore(sync = server)
            store.connect(account(signedIn = true))
            quiet(server)

            val opened = (store.start(routineId = "rt_push") as GymResult.Ok).value
            assertEquals("the plan froze off the routine this store holds",
                PlanSnapshot(routine = "Push Day", entries = listOf(
                    PlanEntry(exerciseId = "bench-press", sets = 3, reps = 5, weightKg = 100.0))),
                opened.plan)
            assertEquals("ses_minted", store.session?.id)
            assertTrue("held on the device, not the log's yet", queueOnDisk().sessionIsUnclaimed)
            store.choose("bench-press")
            store.logSet(weightKg = 100.0, reps = 5)
            assertEquals("its set is parked with it, never counted stranded", 0, store.strandedCount)
            assertNull("nothing landed while the log was quiet", server.sets["ses_minted"])

            server.online = true
            server.refuseStart = { null }
            advanceTimeBy(4_100)
            runCurrent()

            val claimed = server.started.last()
            assertEquals("the cadence claimed the device-composed workout, naming its routine, and never joining",
                listOf("ses_minted", "rt_push", false),
                listOf(claimed.id, claimed.routineId, claimed.joinOpenSession))
            assertEquals(listOf(100.0), server.sets.getValue("ses_minted").map { it.weightKg })
            assertFalse("and it is the log's now", queueOnDisk().sessionIsUnclaimed)
            assertEquals("ses_minted", store.session?.id)
            assertTrue(store.refusals.isEmpty())
        }
    }

    @Test
    fun testAStartWhoseReplyWasLostComposesUnderTheSameIdAndTheClaimReplaysIt() = runTest {
        val server = FakeTraining()
        server.written["rt_push"] = Routine(id = "rt_push", name = "Push Day", entries = listOf(
            RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 3, targetReps = 5,
                targetWeightKg = 100.0)))
        val losing = LosingStartReplies(server)
        val minted = mutableListOf("ses_a", "ses_b")
        val store = makeStore(sync = losing, mintSession = { minted.removeAt(0) })
        store.connect(account(signedIn = true))

        val opened = (store.start(routineId = "rt_push") as GymResult.Ok).value
        assertEquals("the log holds the start whose reply was lost", listOf("ses_a"), server.stored.keys.toList())
        assertEquals("and the device composed under that same id", "ses_a", opened.id)
        assertEquals("ses_a", store.session?.id)
        assertTrue("held unclaimed until the log answers for it", queueOnDisk().sessionIsUnclaimed)
        store.choose("bench-press")
        store.logSet(weightKg = 100.0, reps = 5)
        assertNull("parked with its session", server.sets["ses_a"])

        losing.losing = false
        advanceTimeBy(4_100)
        runCurrent()

        assertEquals("the claim replayed the attempted id, and the log answered its own row",
            listOf("ses_a", "ses_a"), server.started.map { it.id })
        assertEquals("one session on the log, never a second one waiting on it",
            listOf("ses_a"), server.stored.keys.toList())
        assertEquals(listOf(100.0), server.sets.getValue("ses_a").map { it.weightKg })
        assertFalse(queueOnDisk().sessionIsUnclaimed)
        assertTrue(queueOnDisk().pending.isEmpty())
        assertEquals(SaveState.OnTheLog, store.saveState)
        assertEquals("ses_a", store.session?.id)
        assertTrue(store.refusals.isEmpty())
    }

    @Test
    fun testAnOlderQueueFileBehindAShelfSessionIsAdoptedByTheReadAndItsSetsWalk() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        server.online = false
        store.logSet(weightKg = 82.5, reps = 5)
        assertEquals("owed, against a session the log holds", 1, queueOnDisk().pending.size)
        shelfOnDisk().hold(LocalLog.FinishedSession(
            Session(id = "ses_early", startedAtMs = 500, finishedAtMs = 900),
            listOf(TrainingSet(id = "set_early", exerciseId = "bench-press", weightKg = 60.0,
                reps = 5, completedAtMs = 600))))
        val written = queueFile.readText()
        assertTrue(written.contains(""","unclaimed":false"""))
        queueFile.writeText(written.replace(""","unclaimed":false""", ""))
        assertTrue("the older file reads as unclaimed", queueOnDisk().sessionIsUnclaimed)

        server.online = true
        val relaunched = makeStore(sync = server)
        relaunched.connect(account(signedIn = true))

        assertEquals("the shelf start waited on the phone's own open workout — no live start went out",
            listOf("ses_early"), server.started.map { it.id })
        assertEquals("ses_1", relaunched.session?.id)
        assertFalse("the read adopted it: the log has answered for it", queueOnDisk().sessionIsUnclaimed)
        assertEquals("and its parked set walked on that read, not on the next tap",
            listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertTrue(queueOnDisk().pending.isEmpty())
        assertEquals(SaveState.OnTheLog, relaunched.saveState)
        assertEquals("the shelf session still waits — the finish's claim walks it",
            listOf("ses_early"), shelfOnDisk().finished.map { it.session.id })
    }

    @Test
    fun testARefusedLiveStartIsSaidOnceAcrossPasses() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        server.online = false
        store.start()
        assertEquals("ses_minted", store.session?.id)

        server.online = true
        server.refuseStart = { refusal(400, code = "bad-start", message = "that start cannot be taken") }
        store.connect(account(signedIn = true))
        val said = RefusedClaim("ses_minted", "workout · ${Readout.date(store.session!!.startedAtMs)}",
            "that start cannot be taken")
        assertEquals(listOf(said), store.refusals)

        store.connect(account(signedIn = true))
        assertEquals("said again, held once", listOf(said), store.refusals)
        assertEquals("the workout is still the lifter's, still held here", "ses_minted", store.session?.id)
    }

    @Test
    fun testAWriteBackThatDidNotLandSaysWhyAndMovesNothing() = runTest {
        val server = FakeTraining()
        server.written["rt_push_a"] = Routine(id = "rt_push_a", name = "Push A", position = 0,
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5,
                targetReps = 5, targetWeightKg = 82.5)))
        val store = liveStore(server)

        server.online = false
        assertEquals(WriteFailure.NoAnswer,
            store.save(87.5, toRoutine = "rt_push_a", atPosition = 1, forExercise = "bench-press"))
        assertEquals("and nothing moved",
            82.5, server.written.getValue("rt_push_a").entries.first().targetWeightKg)

        server.online = true
        assertEquals("a routine gone from the log is not a write",
            WriteFailure.Refused("that routine is no longer on the log"),
            store.save(87.5, toRoutine = "rt_gone", atPosition = 1, forExercise = "bench-press"))

        assertNull(store.save(87.5, toRoutine = "rt_push_a", atPosition = 1, forExercise = "bench-press"))
        assertEquals(87.5, server.written.getValue("rt_push_a").entries.first().targetWeightKg)
        assertEquals("the copy in hand moved with the log's",
            87.5, store.routines.first { it.id == "rt_push_a" }.entries.first().targetWeightKg)
    }

    @Test
    fun testARetargetWithNothingToMoveIsRefusedAndNeverPut() = runTest {
        val server = FakeTraining()
        server.written["rt_push_a"] = Routine(id = "rt_push_a", name = "Push A", position = 0,
            revision = 1, entries = listOf(
                RoutineEntry(position = 1, exerciseId = "overhead-press", targetSets = 3,
                    targetReps = 8, targetWeightKg = 45.0),
                RoutineEntry(position = 2, exerciseId = "bench-press", targetSets = 5,
                    targetReps = 5, targetWeightKg = 82.5)))
        val store = liveStore(server)

        assertEquals(WriteFailure.Refused("Push A has changed since this session started"),
            store.save(87.5, toRoutine = "rt_push_a", atPosition = 1, forExercise = "bench-press"))
        assertFalse("nothing to write is no PUT", server.calls.contains("replaceRoutine"))
        assertEquals("and the revision did not move", 1, server.written.getValue("rt_push_a").revision)
        assertEquals(listOf(45.0, 82.5),
            server.written.getValue("rt_push_a").entries.map { it.targetWeightKg })

        val signedOut = makeStore(sync = null)
        signedOut.connect(account(signedIn = false))
        val kept = (signedOut.keep(listOf(
            TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 100.0, reps = 5,
                completedAtMs = 1_100)), asRoutineNamed = "Push Day") as GymResult.Ok).value
        assertEquals(WriteFailure.Refused("Push Day has changed since this session started"),
            signedOut.save(105.0, toRoutine = kept.id, atPosition = 2, forExercise = "bench-press"))
        assertEquals("the shelf's document stood still",
            100.0, shelfOnDisk(null).routine(kept.id)?.entries?.first()?.targetWeightKg)
    }

    @Test
    fun testAMovementThatWasNotCreatedSaysSoInTheLogsOwnWords() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.refuseCreate = refusal(409, code = "exercise-id-taken",
            message = "that movement id is taken")
        val why = (store.create("Zercher Squat", "barbell") as? GymResult.Failed)?.why
        assertEquals("a refused create is not a movement",
            WriteFailure.Refused("that movement id is taken"), why)
        assertFalse(store.catalog.any { it.name == "Zercher Squat" })

        server.refuseCreate = null
        val made = (store.create("Zercher Squat", "barbell") as? GymResult.Ok)?.value
        assertEquals("the second attempt lands", "Zercher Squat", made?.name)
        assertEquals(TheSix.movements.map { it.name } + "Zercher Squat", store.catalog.map { it.name })
    }

    @Test
    fun testTheMovementNamesAreHeldOnTheDeviceForTheSeatThatReadThem() = runTest {
        val server = FakeTraining()
        server.catalog = listOf(Exercise(id = "bench-press", name = "Bench Press"),
            Exercise(id = "back-squat", name = "Back Squat"))
        val store = liveStore(server)
        assertEquals("what the log served, then the six it did not",
            listOf("Bench Press", "Back Squat", "Deadlift", "Overhead Press", "Barbell Row", "Chin Up"),
            store.catalog.map { it.name })

        val relaunched = makeStore(sync = null)
        relaunched.connect(account(signedIn = true))
        assertEquals(listOf("bench-press", "back-squat", "deadlift", "overhead-press", "barbell-row",
                            "chin-up"),
            relaunched.catalog.map { it.id })
        assertEquals("Bench Press", Readout.movement("bench-press", relaunched.catalog))

        val signedOut = makeStore(sync = null)
        signedOut.connect(account(signedIn = false))
        assertEquals("the names read for an account are that account's, and signing out is not a way to keep reading them — what is left is the constant every install carries",
            TheSix.movements, signedOut.catalog)
    }

    @Test
    fun testAStartDuringTheClaimComposesOnTheDeviceAndNeverJoinsTheReplay() = runTest {
        val server = FakeTraining()
        val minted = mutableListOf("ses_a", "ses_b")
        val store = makeStore(sync = server, mintSession = { minted.removeAt(0) })
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()

        val gate = CompletableDeferred<Unit>()
        server.onFinish = { gate.await() }
        val connecting = launch { store.connect(account(signedIn = true)) }
        runCurrent()
        assertEquals("the claim stands parked inside the replayed session's finish",
            listOf("ses_a"), server.started.map { it.id })

        val opened = (store.start() as GymResult.Ok).value
        assertEquals("the start composed on the device, not on the log", "ses_b", opened.id)
        store.choose("back-squat")
        store.logSet(weightKg = 999.0, reps = 1)
        assertEquals("nothing was filed into the replayed workout",
            listOf(82.5), server.sets.getValue("ses_a").map { it.weightKg })
        assertTrue("and nothing went out for the new one while it is unclaimed",
            server.appended.none { it.weightKg == 999.0 })
        assertEquals("saved on this device", store.saveState.line)

        gate.complete(Unit)
        connecting.join()

        assertEquals("the claim landed the device-composed session once the replay was over",
            listOf(999.0), server.sets.getValue("ses_b").map { it.weightKg })
        assertEquals(listOf(82.5), server.sets.getValue("ses_a").map { it.weightKg })
        assertFalse("yesterday's workout closed as the shelf recorded it",
            server.stored.getValue("ses_a").isOpen)
        assertEquals("the room stands in its own workout", "ses_b", store.session?.id)
    }

    @Test
    fun testAnUnclaimedSessionsSetsAreParkedRatherThanRetriedForever() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_phone2", startedAtMs = 500))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")

        store.connect(account(signedIn = true))
        store.logSet(weightKg = 82.5, reps = 5)

        assertTrue("no send went out against a session the log has never heard of",
            server.appended.isEmpty())
        assertEquals("held with its session on purpose, not stranded", 0, store.strandedCount)
        assertEquals("saved on this device", store.saveState.line)

        advanceTimeBy(60_000)
        runCurrent()
        assertTrue("and no retry loop re-armed — the claim is the road, not the walk",
            server.appended.isEmpty())
        assertEquals("the phone keeps its own workout", "ses_minted", store.session?.id)
    }

    @Test
    fun testSigningInReAsksLastTimeForTheMovementInHand() = runTest {
        val server = FakeTraining()
        server.lastTimes["bench-press"] = LastTime(
            exerciseId = "bench-press",
            session = Session(id = "ses_old", startedAtMs = 100, finishedAtMs = 200),
            sets = listOf(TrainingSet(id = "set_h", exerciseId = "bench-press", weightKg = 82.5,
                reps = 5, completedAtMs = 150)),
        )
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        assertEquals("the shelf's honest answer for the nobody pass", true, store.lastTime?.isFirstTime)

        store.connect(account(signedIn = true))

        assertTrue("the log was asked", server.calls.contains("lastTime"))
        assertEquals("the log's answer replaced the shelf's", false, store.lastTime?.isFirstTime)
        assertEquals(listOf(82.5), store.lastTime?.sets?.map { it.weightKg })
        assertEquals("and the dial follows the history", Prefill(82.5, 5), store.prefill)
    }

    @Test
    fun testACrashBetweenShelfHoldAndQueueForgetConvergesOnRelaunch() = runTest {
        val crashed = SetQueue(queueFile) { clockMs }
        val live = Session(id = "ses_1", startedAtMs = 1_000)
        crashed.hold(live)
        crashed.store(TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 100.0,
            reps = 5, completedAtMs = 1_100), "ses_1", needsPush = true)
        crashed.flush()
        shelfOnDisk(null).hold(LocalLog.FinishedSession(
            live.copy(finishedAtMs = 2_000),
            listOf(TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 100.0,
                reps = 5, completedAtMs = 1_100))))

        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))

        assertNull("the finish already happened — the workout is not resumed", store.session)
        assertEquals("listed once, not twice", listOf("ses_1"), store.recent.map { it.id })
        assertTrue("the queue let go", queueOnDisk(null).pending.isEmpty())
        assertEquals("and the shelf holds every set exactly once",
            listOf("set_a"), shelfOnDisk(null).details().single().sets.map { it.id })
        assertEquals("under the finish that actually happened",
            2_000L, shelfOnDisk(null).details().single().session.finishedAtMs)
    }

    @Test
    fun testTheLogPagesOlderOnAskAndKnowsWhenItHasReachedTheBottom() = runTest {
        val server = FakeTraining()
        repeat(60) { index ->
            server.open(Session(id = "ses_$index", startedAtMs = 1_000L + index,
                finishedAtMs = 2_000L + index))
        }
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        assertEquals("a full page, so there may be more", Older.More, store.older)
        assertEquals(50, store.logged.size)
        assertEquals("newest first", "ses_59", store.logged.first().id)

        store.loadOlder()

        assertEquals("sixty sessions, no row twice", 60, store.logged.size)
        assertEquals(60, store.logged.map { it.id }.toSet().size)
        assertEquals("a short page is the bottom", Older.End, store.older)
        assertEquals("ses_0", store.logged.last().id)

        val asked = server.calls.count { it == "sessions" }
        store.loadOlder()
        assertEquals("the bottom does not ask again", asked, server.calls.count { it == "sessions" })
    }

    @Test
    fun testTheCadencesReReadKeepsThePagesTheLifterWalked() = runTest {
        val server = FakeTraining()
        repeat(60) { index ->
            server.open(Session(id = "ses_$index", startedAtMs = 1_000L + index,
                finishedAtMs = 2_000L + index))
        }
        shelfOnDisk().hold(LocalLog.FinishedSession(
            Session(id = "ses_shelf", startedAtMs = 9_000, finishedAtMs = 9_500),
            listOf(TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 100.0,
                reps = 5, completedAtMs = 9_100))))
        server.refuseStart = { IOException("offline") }

        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        store.loadOlder()

        assertEquals(60, store.logged.size)
        assertEquals(Older.End, store.older)
        assertEquals(listOf("ses_shelf"), store.shelved.map { it.id })

        server.refuseStart = { null }
        advanceTimeBy(4_100)
        runCurrent()

        assertEquals("the shelf emptied — that is what the timer was armed for",
            emptyList<String>(), store.shelved.map { it.id })
        assertEquals("and the pages the lifter walked are still under their thumb",
            61, store.logged.size)
        assertEquals("no row twice", 61, store.logged.map { it.id }.toSet().size)
        assertEquals("newest first, with the claimed session at the head",
            "ses_shelf", store.logged.first().id)
        assertEquals("the deepest row is where the walk left it", "ses_0", store.logged.last().id)
        assertEquals("and the foot is still the bottom they arrived at", Older.End, store.older)
    }

    @Test
    fun testSignedOutTheShelfIsTheWholeLogAndThereIsNothingOlder() = runTest {
        shelfOnDisk(null).hold(LocalLog.FinishedSession(
            Session(id = "ses_shelf", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 100.0,
                reps = 5, completedAtMs = 1_100))))

        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))

        assertEquals(Older.End, store.older)
        assertEquals(listOf("ses_shelf"), store.shelved.map { it.id })
        assertEquals("saved on this device is the only thing it is", emptyList<String>(),
            store.logged.map { it.id })
        assertEquals("and the row carries what the log's own row would",
            listOf(1), store.recent.map { it.workingSetCount })
        assertEquals(listOf(500.0), store.recent.map { it.tonnageKg })
    }

    @Test
    fun testFixingASetOnAnUnclaimedSessionRewritesTheDeviceRowAndTouchesNoWire() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        val ended = (store.finish() as FinishOutcome.Closed).session

        val setId = (store.sessionDetail(ended.id) as GymResult.Ok).value.sets.single().id
        val fixed = store.fixSet(ended.id, setId, SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))

        assertEquals(listOf(90.0), listOf((fixed as FixOutcome.Corrected).set.weightKg))
        assertEquals("one row per set — a correction is never a second set",
            listOf(setId), (store.sessionDetail(ended.id) as GymResult.Ok).value.sets.map { it.id })
        assertEquals(listOf(90.0),
            (store.sessionDetail(ended.id) as GymResult.Ok).value.sets.map { it.weightKg })
        assertEquals("the row the log screen draws moved with it",
            listOf(270.0), store.recent.map { it.tonnageKg })
        assertEquals("the SESSION decides the road, not the set: a row this workout does not hold " +
            "is not one the log can hold either, and no PATCH goes out for an id it has never seen",
            FixOutcome.Gone("that set is no longer on this device"),
            store.fixSet(ended.id, "set_gone", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working)))
        assertNull(store.deleteSet(ended.id, "set_gone"))
        assertTrue("nothing on the wire — the log has never heard of this set",
            server.fixes.isEmpty() && server.removed.isEmpty())
    }

    @Test
    fun testACorrectionAndADeleteMadeSignedOutBothSurviveSigningIn() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        store.logSet(weightKg = 60.0, reps = 12)
        clockMs += 60_000
        val ended = (store.finish() as FinishOutcome.Closed).session
        val sets = (store.sessionDetail(ended.id) as GymResult.Ok).value.sets

        store.fixSet(ended.id, sets.first().id, SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))
        store.deleteSet(ended.id, sets.last().id)

        store.connect(account(signedIn = true))

        assertEquals("one row, and it is the one the lifter fixed it to",
            listOf(sets.first().id), server.sets.getValue(ended.id).map { it.id })
        assertEquals(listOf(90.0), server.sets.getValue(ended.id).map { it.weightKg })
        assertEquals(listOf(3), server.sets.getValue(ended.id).map { it.reps })
        assertEquals("the original numbers never went out at all",
            listOf(90.0), server.appended.map { it.weightKg })
        assertTrue("and neither did the deleted set", server.appended.none { it.id == sets.last().id })
        assertTrue("the shelf is empty — the account holds the workout as the lifter left it",
            shelfOnDisk().finished.isEmpty())
    }

    @Test
    fun testACorrectionMadeWhileTheClaimIsWalkingStillReachesTheAccount() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        store.logSet(weightKg = 60.0, reps = 12)
        clockMs += 60_000
        val ended = (store.finish() as FinishOutcome.Closed).session
        val sets = (store.sessionDetail(ended.id) as GymResult.Ok).value.sets

        var answered: FixOutcome? = null
        server.onAppend = { write ->
            if (write.id == sets.last().id) {
                answered = store.fixSet(ended.id, sets.first().id,
                    SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))
            }
        }
        store.connect(account(signedIn = true))

        assertEquals("the store told the lifter it landed",
            FixOutcome.Corrected(sets.first().copy(weightKg = 90.0, reps = 3, kind = SetKind.Working)),
            answered)
        assertEquals("and the account holds it — not the numbers they fixed away from",
            listOf(90.0, 60.0), server.sets.getValue(ended.id).map { it.weightKg })
        assertTrue("the shelf is empty, and it emptied only once it agreed with the account",
            shelfOnDisk().finished.isEmpty())
    }

    @Test
    fun testFixingASetOnTheAccountGoesOverTheWireAndMovesNoPlanAndNoRoutine() = runTest {
        val server = FakeTraining()
        val plan = PlanSnapshot(routine = "Push A",
            entries = listOf(PlanEntry(exerciseId = "bench-press", sets = 5, reps = 5, weightKg = 82.5)))
        server.written["rt_1"] = Routine(id = "rt_1", name = "Push A",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5,
                targetReps = 5, targetWeightKg = 82.5)))
        val store = liveStore(server, plan = plan)
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()
        val setId = server.sets.getValue("ses_1").single().id

        val fixed = store.fixSet("ses_1", setId, SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Drop))

        assertEquals(TrainingSet(id = setId, exerciseId = "bench-press", setNumber = 1,
            weightKg = 90.0, reps = 3, kind = SetKind.Drop,
            completedAtMs = server.sets.getValue("ses_1").single().completedAtMs),
            (fixed as FixOutcome.Corrected).set)
        assertEquals(listOf(Triple("ses_1", setId, SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Drop))),
            server.fixes)
        assertEquals("the frozen plan is what makes last Tuesday still readable — it may not move",
            plan, server.stored.getValue("ses_1").plan)
        assertEquals("and next week's target is nobody's business here",
            listOf(82.5), server.written.getValue("rt_1").entries.map { it.targetWeightKg })
        assertEquals("the head re-read, and it followed the correction all the way to the KIND — a " +
            "drop set counts toward no tonnage, so the row that read 412.5 now reads nothing",
            listOf(0.0), store.logged.map { it.tonnageKg })
        assertEquals(listOf(0), store.logged.map { it.workingSetCount })
    }

    // The live session's rows are the queue's. A set the log has not taken is rewritten IN the
    // queue, still owed: nothing goes over the wire, the strip draws the correction at once, and
    // the corrected body is what lands when the signal is back.
    @Test
    fun testFixingASetStillOwedRewritesItInTheQueueAndTheCorrectionIsWhatLands() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        server.online = false
        store.logSet(weightKg = 82.5, reps = 5)
        val setId = store.sets.single().id
        assertEquals(setOf(setId), store.stalled)

        val fixed = store.fixSet("ses_1", setId, SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))

        assertEquals(90.0, (fixed as FixOutcome.Corrected).set.weightKg, 0.0)
        assertEquals("the strip draws the correction from the store", listOf(90.0 to 3),
            store.sets.map { it.weightKg to it.reps })
        assertEquals("still owed — nothing was PATCHed at a log that has never seen the id",
            setOf(setId), store.stalled)
        assertTrue(server.fixes.isEmpty())
        assertEquals(listOf(90.0), queueOnDisk().pending.map { it.set.weightKg })

        server.online = true
        store.flushPendingSets(force = true)
        assertEquals("the corrected body is the one that landed", listOf(90.0 to 3),
            server.sets.getValue("ses_1").map { it.weightKg to it.reps })
        assertTrue(store.stalled.isEmpty())
    }

    @Test
    fun testFixingADeliveredSetOfTheLiveSessionRedrawsTheStripFromTheStore() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        store.logSet(weightKg = 82.5, reps = 5)
        val setId = store.sets.single().id
        assertTrue(store.stalled.isEmpty())

        val fixed = store.fixSet("ses_1", setId, SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Drop))

        assertEquals(listOf(Triple("ses_1", setId, SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Drop))),
            server.fixes)
        assertEquals((fixed as FixOutcome.Corrected).set, store.sets.single())
        assertEquals("the queue's row followed the log's answer", listOf(Triple(90.0, 3, SetKind.Drop)),
            store.sets.map { Triple(it.weightKg, it.reps, it.kind) })
        assertTrue("a fix the log took owes nothing", store.stalled.isEmpty())
    }

    @Test
    fun testDeletingASetStillOwedLeavesTheQueueAndSendsNothing() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        server.online = false
        store.logSet(weightKg = 82.5, reps = 5)
        val setId = store.sets.single().id

        assertNull(store.deleteSet("ses_1", setId))

        assertEquals(emptyList<TrainingSet>(), store.sets)
        assertTrue("nothing to tell — the log never had it", server.removed.isEmpty())
        assertTrue(queueOnDisk().pending.isEmpty())
        server.online = true
        store.flushPendingSets(force = true)
        assertEquals("and it never lands", emptyList<TrainingSet>(), server.sets["ses_1"] ?: emptyList<TrainingSet>())
    }

    @Test
    fun testDeletingADeliveredSetOfTheLiveSessionTakesItOffTheStrip() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        store.logSet(weightKg = 82.5, reps = 5)
        val setId = store.sets.single().id

        assertNull(store.deleteSet("ses_1", setId))

        assertEquals(listOf("ses_1" to setId), server.removed)
        assertEquals("the queue let it go once the log did", emptyList<TrainingSet>(), store.sets)
        assertEquals(setOf(setId), store.deletedSets)

        server.refuseDelete = storageFailure
        store.logSet(weightKg = 90.0, reps = 3)
        val second = store.sets.single().id
        assertNotNull("a delete the log refused takes nothing off the queue", store.deleteSet("ses_1", second))
        assertEquals(listOf(second), store.sets.map { it.id })
    }

    @Test
    fun testARowWalkedDownToWithLoadOlderFollowsItsOwnCorrection() = runTest {
        val server = FakeTraining()
        repeat(60) { index ->
            val id = "ses_$index"
            server.open(Session(id = id, startedAtMs = 1_000L + index, finishedAtMs = 2_000L + index))
            server.sets[id] = mutableListOf(TrainingSet(id = "set_$index", exerciseId = "bench-press",
                setNumber = 1, weightKg = 100.0, reps = 5, kind = SetKind.Working,
                completedAtMs = 1_500L + index))
        }
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        store.loadOlder()
        assertEquals("the deepest row is a page and a half down", "ses_0", store.logged.last().id)
        assertEquals(listOf(500.0, 1), listOf(store.logged.last().tonnageKg, store.logged.last().workingSetCount))

        store.fixSet("ses_0", "set_0", SetFix(weightKg = 60.0, reps = 3, kind = SetKind.Warmup))

        assertEquals("the walk is not undone by a fix at the bottom of it", 60, store.logged.size)
        assertEquals("and the row followed the correction — a warmup counts toward nothing",
            listOf(0.0, 0), listOf(store.logged.last().tonnageKg, store.logged.last().workingSetCount))
    }

    @Test
    fun testAFixRefusalIsToldApartByItsCodeAndNeverByItsSentence() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()
        val setId = server.sets.getValue("ses_1").single().id
        val fix = SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working)

        server.refuseFix = { refusal(404, code = "set-not-found", message = "reworded on a Tuesday") }
        assertEquals(FixOutcome.Gone("that set is no longer on the log"),
            store.fixSet("ses_1", setId, fix))

        server.refuseFix = { refusal(400, code = "fix-unreadable", message = "could not read that fix") }
        assertEquals(FixOutcome.Failed(WriteFailure.Refused("could not read that fix")),
            store.fixSet("ses_1", setId, fix))

        server.refuseFix = { storageFailure }
        assertEquals("a storage failure is the log answering, and it is worth another tap",
            FixOutcome.Failed(WriteFailure.Refused("internal error")), store.fixSet("ses_1", setId, fix))

        server.refuseFix = { null }
        server.online = false
        assertEquals("no reply at all is a different fact from a refusal, and says so",
            FixOutcome.Failed(WriteFailure.NoAnswer), store.fixSet("ses_1", setId, fix))
        assertEquals("nothing was corrected by any of them",
            listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
    }

    @Test
    fun testSignedOutASetOnTheAccountIsNamedRatherThanBlamedOnTheSignal() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))

        assertEquals(FixOutcome.Failed(
            WriteFailure.Refused("that set is on your account — sign in to fix it")),
            store.fixSet("ses_1", "set_a", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working)))
        assertEquals(WriteFailure.Refused("that set is on your account — sign in to delete it"),
            store.deleteSet("ses_1", "set_a"))
        assertTrue(server.fixes.isEmpty() && server.removed.isEmpty())
    }

    @Test
    fun testADeleteIsWithheldUntilTheWindowClosesAndUndoTakesItBackUnsent() = runTest {
        val server = FakeTraining()
        val store = liveStore(server, undoWindowMs = SetQueue.undoWindowMs)
        store.logSet(weightKg = 82.5, reps = 5)
        store.logSet(weightKg = 90.0, reps = 3)
        clockMs += 60_000
        store.flushPendingSets(force = true)
        store.finish()
        val taken = server.sets.getValue("ses_1").first()

        store.withhold(Deletion.Set("ses_1", taken))
        assertEquals(
            listOf(WithheldDelete(Deletion.Set("ses_1", taken), untilMs = clockMs + SetQueue.undoWindowMs)),
            store.withheld)
        assertTrue("nothing has been told yet", server.removed.isEmpty())

        assertNotNull(store.keepWithheld())
        assertEquals(emptyList<WithheldDelete>(), store.withheld)
        assertNull("undo sends nothing at all — it is this device changing its mind",
            store.settleWithheld(taken.id))
        assertTrue(server.removed.isEmpty())
        assertEquals(2, server.sets.getValue("ses_1").size)

        store.withhold(Deletion.Set("ses_1", taken))
        assertNull(store.settleWithheld(taken.id))
        assertEquals(listOf("ses_1" to taken.id), server.removed)
        assertEquals("the set does not stand", listOf(90.0),
            server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals("and the screen that read the session before it went knows not to draw it",
            setOf(taken.id), store.deletedSets)
        assertEquals("the head re-read — the row lost a set, its tonnage and its top set",
            listOf(270.0), store.logged.map { it.tonnageKg })
    }

    // The old rule REVERSED, and this is the one the gesture wave turns on: behind a swipe two rows
    // can be gone in a second, and a second delete that settled the first would send it while its
    // Undo was still on screen.
    @Test
    fun testASecondDeleteOpensAWindowOfItsOwnAndSettlesNothing() = runTest {
        val server = FakeTraining()
        val store = liveStore(server, undoWindowMs = SetQueue.undoWindowMs)
        store.logSet(weightKg = 82.5, reps = 5)
        store.logSet(weightKg = 60.0, reps = 12)
        clockMs += 60_000
        store.flushPendingSets(force = true)
        store.finish()
        val first = server.sets.getValue("ses_1").first()
        val second = server.sets.getValue("ses_1").last()

        store.withhold(Deletion.Set("ses_1", first))
        store.withhold(Deletion.Set("ses_1", second))

        assertEquals("nothing went out — a second delete settles nothing",
            emptyList<Pair<String, String>>(), server.removed)
        assertEquals(setOf(first.id, second.id), store.withheldIds)
        assertEquals("both rows are off every list that reads them",
            emptySet<String>(), store.deletedSets)

        assertEquals("Undo takes the NEWEST back first",
            Deletion.Set("ses_1", second), store.keepWithheld()?.deletion)
        assertEquals("and the transient re-reads for the one still held",
            Deletion.Set("ses_1", first), store.holding?.deletion)
        assertNotNull(store.keepWithheld())

        assertEquals("so both sets are still on the log", listOf(first.id, second.id),
            server.sets.getValue("ses_1").map { it.id })
        assertEquals(emptyList<Pair<String, String>>(), server.removed)
    }

    @Test
    fun testADeleteTheLogCouldNotTakeIsSaidAndTheRowStands() = runTest {
        val server = FakeTraining()
        val store = liveStore(server, undoWindowMs = SetQueue.undoWindowMs)
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()
        val taken = server.sets.getValue("ses_1").single()

        server.refuseDelete = storageFailure
        store.withhold(Deletion.Set("ses_1", taken))

        assertEquals(WriteFailure.Refused("internal error"), store.settleWithheld(taken.id))
        assertEquals(emptySet<String>(), store.deletedSets)
        assertEquals(listOf(taken.id), server.sets.getValue("ses_1").map { it.id })
    }

    @Test
    fun testAWithheldDeleteIsDroppedRatherThanSentAtSomebodyElsesLog() = runTest {
        val server = FakeTraining()
        val store = liveStore(server, undoWindowMs = SetQueue.undoWindowMs)
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()
        val taken = server.sets.getValue("ses_1").single()
        store.withhold(Deletion.Set("ses_1", taken))

        store.connect(account(signedIn = true, id = "u2"))

        assertEquals(emptyList<WithheldDelete>(), store.withheld)
        assertNull("and there is nothing left for a settle over it to find",
            store.settleWithheld(taken.id))
        assertTrue("the set survives, which is the direction this one may fail in",
            server.removed.isEmpty())
    }

    @Test
    fun testAFailedLogReadIsSaidAtTheFootAndRetriedFromWhereItStopped() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000))
        server.online = false

        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        assertEquals(Older.Failed, store.older)
        assertTrue(store.logged.isEmpty())

        server.online = true
        store.loadOlder()

        assertEquals(listOf("ses_1"), store.logged.map { it.id })
        assertEquals(Older.End, store.older)
    }

    @Test
    fun testUnitsAreADisplayTransformAndReachNoWrite() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        assertNull(store.savePreferences(GymPreferences(units = Units.Pounds)))
        store.logSet(weightKg = 82.5, reps = 5)

        assertEquals(Units.Pounds, store.preferences.units)
        assertEquals(listOf(82.5), server.appended.map { it.weightKg })
        assertEquals(listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals(listOf(82.5), store.sets.map { it.weightKg })
        val written = WindmillJson.encodeToString(SetWrite.serializer(), server.appended.single())
        assertFalse("no unit reached the set that was written: $written", written.contains("lb"))
        assertFalse(written.contains("units"))

        assertNull(store.savePreferences(GymPreferences(units = Units.Kilograms)))
        assertEquals(listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
    }

    @Test
    fun testARoomSetUpSignedOutIsClaimedOntoTheAccount() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))

        assertNull(store.savePreferences(GymPreferences(units = Units.Pounds, restSeconds = 90)))
        assertEquals(Units.Pounds, store.preferences.units)
        assertTrue("nobody to tell yet", server.settingsWritten.isEmpty())

        val relaunched = makeStore(sync = server)
        relaunched.connect(account(signedIn = true))

        assertEquals(listOf(Units.Pounds), server.settingsWritten.map { it.units })
        assertEquals(90, server.settings?.restSeconds)
        assertEquals(Units.Pounds, relaunched.preferences.units)
    }

    @Test
    fun testAnAccountsOwnSettingsArriveOnConnectAndAreNotOverwrittenByAFreshPhone() = runTest {
        val server = FakeTraining()
        server.settings = GymPreferences(units = Units.Pounds, restSeconds = 180)

        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        assertEquals(Units.Pounds, store.preferences.units)
        assertEquals(180, store.preferences.restSeconds)
        assertTrue("a phone with nothing to say says nothing", server.settingsWritten.isEmpty())
    }

    @Test
    fun testASettingTheLogCannotTakeIsHeldHereAndSaidOutLoud() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        server.online = false
        val failed = store.savePreferences(GymPreferences(restSeconds = 90))

        assertEquals(WriteFailure.NoAnswer, failed)
        assertEquals("the row on screen is the one the lifter chose", 90, store.preferences.restSeconds)

        server.online = true
        val relaunched = makeStore(sync = server)
        relaunched.connect(account(signedIn = true))
        assertEquals(90, server.settings?.restSeconds)
    }

    @Test
    fun testAnOwedSettingRetriesAloneRatherThanReWalkingTheClaim() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_other", startedAtMs = 500))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.connect(account(signedIn = true))
        server.calls.clear()
        server.started.clear()

        server.refusePreferences = refusal(404, message = "no such route")
        assertEquals(WriteFailure.Refused("no such route"), store.savePreferences(GymPreferences(restSeconds = 90)))

        advanceTimeBy(20_100)
        runCurrent()

        assertEquals("every pass is one PUT and nothing else — the send, then five cadence passes",
            List(6) { "savePreferences" }, server.calls)
        assertTrue("the waiting start was never re-sent behind it", server.started.isEmpty())
        assertEquals("the phone keeps its own workout", "ses_minted", store.session?.id)
        assertEquals("and the row on screen is still the lifter's", 90, store.preferences.restSeconds)

        server.refusePreferences = null
        advanceTimeBy(4_100)
        runCurrent()
        assertEquals(90, server.settings?.restSeconds)
        server.calls.clear()
        advanceTimeBy(60_000)
        runCurrent()
        assertTrue("the cadence is not a heartbeat", server.calls.isEmpty())
    }

    @Test
    fun testAFreshArrivalLogsFourSetsAndARelaunchLosesNoneOfThem() = runTest {
        val arriving = makeStore(sync = null)
        arriving.connect(account(signedIn = false))

        assertTrue("nothing has ever happened in this room", arriving.firstSession)
        arriving.start()
        assertNotNull("the tap opened it", arriving.session)
        assertTrue("the picker stands over it, with the six — the session in hand is not counted",
            arriving.firstSession)
        assertNull("nothing is chosen yet — that is what the picker is for", arriving.exerciseId)

        arriving.choose("back-squat")
        arriving.logSet(weightKg = 100.0, reps = 5)
        arriving.logSet(weightKg = 100.0, reps = 5)
        arriving.logSet(weightKg = 102.5, reps = 5)
        arriving.choose("bench-press")
        arriving.logSet(weightKg = 80.0, reps = 8)

        assertEquals("the whole workout is on this device's disk and nowhere else",
            4, queueOnDisk(null).sets(arriving.session!!.id).size)

        val reopened = makeStore(sync = null)
        reopened.connect(account(signedIn = false))

        assertEquals(arriving.session?.id, reopened.session?.id)
        assertEquals(listOf(100.0, 100.0, 102.5, 80.0), reopened.sets.map { it.weightKg })
        assertEquals(listOf(5, 5, 5, 8), reopened.sets.map { it.reps })
        assertEquals(listOf("back-squat", "bench-press"), reopened.order)
        assertEquals("it stands where the last set went, not in the picker over a session of sets",
            "bench-press", reopened.exerciseId)
    }

    @Test
    fun testAFirstSessionIsALogThatAnsweredAndAnsweredEmpty() = runTest {
        val fresh = makeStore(sync = null)
        fresh.connect(account(signedIn = false))
        assertTrue("signed out the shelf IS the log, and it is already in hand", fresh.firstSession)

        val opened = makeStore(sync = FakeTraining())
        opened.connect(account(signedIn = true))
        assertTrue("nothing on the log, and the log said so", opened.firstSession)

        val offline = FakeTraining()
        offline.online = false
        val unreachable = makeStore(sync = offline)
        unreachable.connect(account(signedIn = true))
        assertFalse("the log page never answered", unreachable.firstSession)

        val halfRead = FakeTraining()
        halfRead.refuseRoutinesRead = IOException("offline")
        val partly = makeStore(sync = halfRead)
        partly.connect(account(signedIn = true))
        assertFalse(partly.firstSession)

        val returning = makeStore(sync = null)
        returning.connect(account(signedIn = false))
        returning.start()
        returning.choose("back-squat")
        returning.logSet(weightKg = 100.0, reps = 5)
        clockMs += 60_000
        returning.finish()
        assertFalse("the shelf holds a session now", returning.firstSession)

        val relaunched = makeStore(sync = null)
        relaunched.connect(account(signedIn = false))
        assertFalse("and it still does on the next launch", relaunched.firstSession)
    }

    @Test
    fun testAReorderMovesTheWalkAndASwipeRefusesAMovementWithASetInIt() = runTest {
        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))
        store.start()
        store.choose("back-squat")
        store.logSet(weightKg = 100.0, reps = 5)
        store.choose("bench-press")
        store.logSet(weightKg = 80.0, reps = 8)
        store.choose("romanian-deadlift")
        assertEquals(listOf("back-squat", "bench-press", "romanian-deadlift"), store.order)

        store.reorder(from = 2, to = 0)
        assertEquals(listOf("romanian-deadlift", "back-squat", "bench-press"), store.order)
        assertEquals("every set is exactly where it was — sets are keyed by movement, never position",
            listOf(100.0, 80.0), store.sets.map { it.weightKg })
        assertEquals("and the walk is on disk before the finger has left the screen",
            listOf("romanian-deadlift", "back-squat", "bench-press"), queueOnDisk(null).order)

        assertFalse("a movement holding a set does not leave on a swipe", store.drop("back-squat"))
        assertEquals(listOf("romanian-deadlift", "back-squat", "bench-press"), store.order)

        assertTrue(store.drop("romanian-deadlift"))
        assertEquals(listOf("back-squat", "bench-press"), store.order)
        assertNull("the movement in hand left the session, so the picker comes back up",
            store.exerciseId)
        assertEquals("and nothing logged went with it",
            listOf(100.0, 80.0), store.sets.map { it.weightKg })
        assertEquals(listOf("back-squat", "bench-press"), queueOnDisk(null).order)
    }

    @Test
    fun testThePickerMetaIsSparseAndTakesTheLaterOfTheLogAndTheShelf() = runTest {
        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))
        store.start()
        store.choose("back-squat")
        store.logSet(weightKg = 100.0, reps = 5)
        store.logSet(weightKg = 102.5, reps = 3)
        clockMs += 60_000
        store.finish()

        assertNull("nobody has asked yet, and the picker draws no line at all until somebody has",
            store.lastSets)
        store.loadLastSets()
        assertEquals("the shelf answers when it is the whole log there is",
            LastSet("back-squat", 102.5, 3, atMs = store.recent.single().startedAtMs),
            store.lastSets?.get("back-squat"))
        assertNull("and a movement nobody has trained is answered by saying nothing",
            store.lastSets?.get("chin-up"))

        val server = FakeTraining()
        server.refuseStart = { storageFailure }
        server.served.add(LastSet("back-squat", 90.0, 5, atMs = 500))
        server.served.add(LastSet("bench-press", 80.0, 8, atMs = 600))
        val signedIn = makeStore(sync = server)
        signedIn.connect(account(signedIn = true))
        signedIn.loadLastSets()

        assertEquals(setOf("back-squat", "bench-press"), signedIn.lastSets?.keys)
        assertEquals("the later of the two, which is the one this phone is still holding",
            102.5, signedIn.lastSets?.getValue("back-squat")?.weightKg)
        assertEquals(80.0, signedIn.lastSets?.getValue("bench-press")?.weightKg)

        server.online = false
        signedIn.loadLastSets()
        assertEquals(setOf("back-squat", "bench-press"), signedIn.lastSets?.keys)
    }

    @Test
    fun testAFailedMetaReadSaysNothingRatherThanNeverLogged() = runTest {
        val server = FakeTraining()
        server.refuseStart = { storageFailure }
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 80.0, reps = 8)
        clockMs += 60_000
        store.finish()
        store.connect(account(signedIn = true))
        assertEquals(1, store.recent.size)

        server.online = false
        store.loadLastSets()
        assertNull("the log never answered, so the picker asserts nothing about any movement",
            store.lastSets)

        server.online = true
        store.loadLastSets()
        assertEquals(80.0, store.lastSets!!.getValue("bench-press").weightKg, 0.0)
    }

    @Test
    fun testSigningInUnderTheOpenPickerRefillsTheMetaItJustDropped() = runTest {
        val server = FakeTraining()
        server.refuseStart = { storageFailure }
        server.served.add(LastSet("bench-press", 100.0, 3, atMs = 900))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        store.start()
        store.choose("back-squat")
        store.logSet(weightKg = 140.0, reps = 5)
        clockMs += 60_000
        store.finish()
        store.loadLastSets()
        assertEquals(140.0, store.lastSets!!.getValue("back-squat").weightKg, 0.0)

        store.connect(account(signedIn = true))

        assertEquals("the seat's own answer arrives without the lifter leaving the screen",
            setOf("back-squat", "bench-press"), store.lastSets?.keys)
    }

    @Test
    fun testAMissedCatalogReadIsSaidOnlyWhenTheSixAreAllThatIsLeft() = runTest {
        val server = FakeTraining()
        server.online = false
        val bare = makeStore(sync = server)
        bare.connect(account(signedIn = true))
        assertEquals("the six and nothing else", TheSix.movements.map { it.id },
            bare.catalog.map { it.id })
        assertTrue(bare.catalogUnread)

        server.online = true
        server.catalog = listOf(Exercise(id = "back-squat", name = "Back Squat"),
                                Exercise(id = "hip-thrust", name = "Hip Thrust"))
        val holding = makeStore(sync = server)
        holding.connect(account(signedIn = true))
        assertFalse(holding.catalogUnread)

        server.online = false
        val offline = makeStore(sync = server)
        offline.connect(account(signedIn = true))
        assertEquals(listOf("back-squat", "hip-thrust", "bench-press", "deadlift", "overhead-press",
                            "barbell-row", "chin-up"),
            offline.catalog.map { it.id })
        assertFalse("a held copy is the catalog, not a gap in it", offline.catalogUnread)
    }

    private fun aRoutine(id: String = "rt_1", revision: Int = 1) = Routine(
        id = id, name = "Push A", position = 0, revision = revision,
        entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5,
            targetReps = 5, targetWeightKg = 82.5)))

    private fun aProposal(
        id: String = "prop_1",
        routineId: String = "rt_1",
        baseRevision: Int = 1,
        intent: ProposalIntent = ProposalIntent.Revise,
        name: String = "Push A",
    ) = Proposal(
        id = id, routineId = routineId, intent = intent, state = ProposalState.Pending,
        summary = "Heavier triples.", changeCount = 1, createdAtMs = 7_000,
        source = ProposalSource(agent = "Claude"), baseRevision = baseRevision,
        baseName = "Push A", name = name,
        changes = listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted,
            exerciseId = "bench-press", before = ProposalTargets(5, 5, 82.5),
            after = ProposalTargets(5, 3, 87.5))))

    @Test
    fun testTheCardArrivesOnTheRoutineTheBootReadAlreadyMakes() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal())
        val store = makeStore(sync = server)

        store.connect(account(signedIn = true))

        assertEquals(listOf("prop_1"), store.pendingProposals.map { it.id })
        assertEquals("Claude", store.pendingProposals.single().source.name)
        assertEquals("prop_1", store.routine("rt_1")?.pendingProposal?.id)
        assertFalse("no second read went out for it", server.calls.contains("routine"))
    }

    @Test
    fun testASignedOutRoomHasNoProposalsAndAsksForNone() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal())
        val store = makeStore(sync = server)

        store.connect(account(signedIn = false))
        store.keep(listOf(TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 82.5,
            reps = 5, completedAtMs = 1_100)), asRoutineNamed = "Push A")

        assertTrue("the shelf's own routine wears no card",
            store.routines.isNotEmpty() && store.routines.all { it.pendingProposal == null })
        assertTrue(store.pendingProposals.isEmpty())
        assertTrue("nothing on the wire at all", server.calls.isEmpty())

        assertEquals(GymResult.Ok(emptyList<RoutineEvent>()), store.routineHistory(store.routines.single().id))
        assertEquals(ProposalOutcome.Failed(WriteFailure.Refused("a proposal needs your account — sign in first")),
            store.applyProposal("prop_1"))
        assertTrue("still nothing on the wire", server.calls.isEmpty())
    }

    @Test
    fun testNothingMovesUntilTheTapAndThenTheLogsOwnRoutineLands() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal(name = "Push A — heavy"))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        assertEquals("Push A", store.routine("rt_1")?.name)
        assertEquals(1, store.routine("rt_1")?.revision)

        val decided = store.applyProposal("prop_1")

        assertTrue(decided is ProposalOutcome.Decided)
        assertEquals(ProposalState.Applied, (decided as ProposalOutcome.Decided).proposal.state)
        assertEquals("Push A — heavy", store.routine("rt_1")?.name)
        assertEquals(2, store.routine("rt_1")?.revision)
        assertEquals("and the diff itself landed, not only the name",
            listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5,
                targetReps = 3, targetWeightKg = 87.5)),
            store.routine("rt_1")?.entries)
        assertTrue("the card goes because the decision was taken", store.pendingProposals.isEmpty())
    }

    @Test
    fun testADecisionTakenOnAnotherSurfaceRedrawsTheProgramHere() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal(name = "Push A — heavy"))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        assertEquals(listOf("prop_1"), store.pendingProposals.map { it.id })

        server.applyProposal("prop_1")

        val refused = store.dismissProposal("prop_1")

        assertEquals(ProposalOutcome.Settled("that proposal was already decided"), refused)
        assertTrue("the card goes with the decision it was waiting for", store.pendingProposals.isEmpty())
        assertEquals("and the routine is the one the log now holds", "Push A — heavy",
            store.routine("rt_1")?.name)
        assertEquals(2, store.routine("rt_1")?.revision)
        assertEquals(
            listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5,
                targetReps = 3, targetWeightKg = 87.5)),
            store.routine("rt_1")?.entries)
    }

    @Test
    fun testAMidSessionSaveSupersedesTheDiffAndTheTapIsRefused() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal(baseRevision = 1))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        assertNull(store.save(87.5, toRoutine = "rt_1", atPosition = 1, forExercise = "bench-press"))
        assertEquals("the log moved the revision under the diff", 2,
            server.written.getValue("rt_1").revision)
        assertEquals("and this room is holding the log's own answer, not its send", 2,
            store.routine("rt_1")?.revision)

        val refused = store.applyProposal("prop_1")

        assertEquals("the log's own sentence, as sent (B13)",
            ProposalOutcome.Moved("that routine changed after this proposal was written, so it was not applied"),
            refused)
        assertEquals("the routine was re-read, not argued with", 2, store.routine("rt_1")?.revision)
        assertTrue(store.pendingProposals.isEmpty())
        assertEquals("the lifter's own 87.5 stands", 87.5,
            store.routine("rt_1")?.entries?.first()?.targetWeightKg)
        assertEquals("and the triples the diff wanted never landed", 5,
            store.routine("rt_1")?.entries?.first()?.targetReps)
        assertEquals("set aside by the PUT rather than applied", ProposalState.Superseded,
            server.ledger.getValue("prop_1").state)
    }

    @Test
    fun testASupersededDiffIsReadableOffTheRoutineTheRoomHolds() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine(revision = 3)
        server.propose(aProposal(baseRevision = 2))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        val waiting = store.pendingProposals.single()
        assertTrue(waiting.supersededBy(store.routine("rt_1")))
        assertFalse(waiting.supersededBy(aRoutine(revision = 2)))
        assertFalse(waiting.supersededBy(aRoutine(revision = 1)))
    }

    @Test
    fun testDismissTakesTheCardAndTouchesNothingElse() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal())
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        val decided = store.dismissProposal("prop_1")

        assertEquals(ProposalState.Dismissed, (decided as ProposalOutcome.Decided).proposal.state)
        assertTrue(store.pendingProposals.isEmpty())
        assertEquals("the routine did not move", 1, store.routine("rt_1")?.revision)
        assertEquals("Push A", store.routine("rt_1")?.name)
        assertEquals(listOf("prop_1"),
            (store.routineHistory("rt_1") as GymResult.Ok).value.mapNotNull { it.proposal?.id })
    }

    @Test
    fun testDecidingWhatWasAlreadyDecidedTheOtherWayIsTerminal() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal())
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        store.dismissProposal("prop_1")

        assertEquals(ProposalOutcome.Settled("that proposal was already decided"),
            store.applyProposal("prop_1"))
        assertTrue(store.dismissProposal("prop_1") is ProposalOutcome.Decided)
    }

    @Test
    fun testAnAppliedRemovalTakesTheRoutineOffTheProgramAndLeavesTheLog() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal(intent = ProposalIntent.Remove))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        assertEquals(1, store.routines.size)

        val decided = store.applyProposal("prop_1")

        assertTrue(decided is ProposalOutcome.Decided)
        assertNull(store.routine("rt_1"))
        assertTrue(store.routines.isEmpty())
        assertTrue(store.pendingProposals.isEmpty())
    }

    @Test
    fun testARemovalTappedTwiceLeavesTheProgramTellingTheTruth() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal(intent = ProposalIntent.Remove))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        server.applyProposal("prop_1")
        assertEquals("rt_1", store.routine("rt_1")?.id)

        val again = store.applyProposal("prop_1")

        assertEquals(ProposalOutcome.Gone("that proposal is no longer on the log"), again)
        assertNull("the program was re-read rather than guessed at", store.routine("rt_1"))
    }

    @Test
    fun testAnUnreachableLogLeavesTheCardExactlyWhereItWas() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal())
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        server.refuseApply = IOException("offline")

        assertEquals(ProposalOutcome.Failed(WriteFailure.NoAnswer), store.applyProposal("prop_1"))
        assertEquals("prop_1", store.routine("rt_1")?.pendingProposal?.id)
        assertEquals(ProposalState.Pending, server.ledger.getValue("prop_1").state)
    }

    @Test
    fun testAProposalThatIsNotThereIsOneFactAndNotAnError() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        assertEquals(ProposalOutcome.Gone("that proposal is no longer on the log"),
            store.applyProposal("prop_gone"))
        assertEquals(GymResult.Failed(WriteFailure.Refused("that proposal is no longer on the log")),
            store.proposal("prop_gone"))
    }

    @Test
    fun testDecidingAnOldProposalDoesNotHideTheOneThatReplacedIt() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal(id = "prop_old"))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        server.ledger["prop_old"] = server.ledger.getValue("prop_old").copy(state = ProposalState.Superseded)
        server.propose(aProposal(id = "prop_new"))
        val fresh = server.written.getValue("rt_1")
        store.connect(account(signedIn = true))
        assertEquals("prop_new", store.routine("rt_1")?.pendingProposal?.id)
        assertEquals("prop_new", fresh.pendingProposal?.id)

        server.ledger["prop_old"] = server.ledger.getValue("prop_old").copy(state = ProposalState.Pending)
        store.dismissProposal("prop_old")

        assertEquals("prop_new", store.routine("rt_1")?.pendingProposal?.id)
    }

    @Test
    fun testAskSignedOutNeverReachesTheLogAndSaysWhy() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))

        assertEquals(AskOutcome.Refused("Coach reads your log — sign in first"),
            store.ask("thr_1", "what's stalled?"))
        assertFalse(server.calls.contains("ask"))
    }

    @Test
    fun testAProposalMintedInAConversationLandsOnTodayWithoutLeavingTheRoom() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        assertEquals(emptyList<Proposal>(), store.pendingProposals)

        server.propose(aProposal(id = "prop_1"))
        server.answers.add(AskAnswer(answer = "Done — as a proposal on Push A.",
            read = ReadTally(sets = 214, sessions = 34, weeks = 12), proposals = listOf("prop_1")))

        val outcome = store.ask("thr_1", "write the triples block")

        assertEquals(AskOutcome.Answered(AskAnswer(answer = "Done — as a proposal on Push A.",
            read = ReadTally(sets = 214, sessions = 34, weeks = 12), proposals = listOf("prop_1"))),
            outcome)
        assertEquals(listOf("prop_1"), store.pendingProposals.map { it.id })
    }

    @Test
    fun testTheReceiptIsTheServersNumberCarriedThrough() = runTest {
        val server = FakeTraining()
        server.answers.add(AskAnswer(answer = "three sessions at the same top set.",
            read = ReadTally(sets = 214, sessions = 34, weeks = 12)))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        val outcome = store.ask("thr_1", "what's stalled?")

        assertEquals(ReadTally(sets = 214, sessions = 34, weeks = 12),
            (outcome as AskOutcome.Answered).answer.read)
    }

    @Test
    fun testBothCeilingsTakeTheComposerDownAQuietLogIsARetryAndAnAbsentRouteTakesTheDoorDown() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        server.refuseAsk = refusal(429, code = "ask-daily-limit", message = "the next question frees up in a couple of hours")
        assertEquals("the daily cap takes the composer down",
            AskOutcome.Capped("the next question frees up in a couple of hours", AskCap.Daily),
            store.ask("thr_1", "what's stalled?"))
        server.refuseAsk = refusal(429, code = "ask-out-of-budget", message = "this account has reached its AI ceiling")
        assertEquals("and so does the account's 30-day ceiling, carrying its OWN sentence",
            AskOutcome.Capped("this account has reached its AI ceiling", AskCap.Ceiling),
            store.ask("thr_1", "what's stalled?"))

        server.refuseAsk = storageFailure
        assertEquals(AskOutcome.Failed("internal error"), store.ask("thr_1", "what's stalled?"))

        server.refuseAsk = refusal(404, message = "not found")
        assertEquals(AskOutcome.Absent, store.ask("thr_1", "what's stalled?"))

        server.refuseAsk = refusal(409, code = "ask-thread-full", message = "that conversation is full")
        assertEquals(AskOutcome.Fresh("that conversation is full"), store.ask("thr_1", "what's stalled?"))
    }

    @Test
    fun testTheThreadsListIsReadEveryTimeAndCarriesNoTurns() = runTest {
        val server = FakeTraining()
        server.conversations["thr_1"] = AskThread(
            id = "thr_1", title = "Bench has been stuck at 82.5. What do you see?",
            askedAtMs = 2_000, outcome = ThreadOutcome("applied", changes = 4, routine = "Push A"),
            turns = listOf(AskTurn("lifter", "Bench has been stuck at 82.5. What do you see?", 2_000)))
        server.conversations["thr_2"] = AskThread(
            id = "thr_2", title = "Is my squat volume too low?", askedAtMs = 5_000,
            outcome = ThreadOutcome("read-only"))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        val listed = store.readThreads()

        assertEquals(listOf("thr_2", "thr_1"), (listed as GymResult.Ok).value.map { it.id })
        assertEquals("no turns on the list read", listOf(0, 0), listed.value.map { it.turns.size })
        assertEquals("4 changes → Push A", listed.value[1].outcome.detail)

        store.readThreads()
        assertEquals(2, server.calls.count { it == "threads" })
    }

    @Test
    fun testAConversationIsReadWholeAndAMissingOneAnswersInWords() = runTest {
        val server = FakeTraining()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "what's stalled?",
            turns = listOf(AskTurn("lifter", "what's stalled?", 1_000),
                AskTurn("ask", "bench, three weeks.", 1_200)))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        val opened = store.thread("thr_1")

        assertEquals(listOf("what's stalled?", "bench, three weeks."),
            (opened as GymResult.Ok).value.turns.map { it.text })
        assertEquals(GymResult.Failed(WriteFailure.Refused("that conversation is no longer on the log")),
            store.thread("thr_missing"))
    }

    @Test
    fun testDeletingAThreadLeavesTheChangeItAppliedInTheRoutinesHistory() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal().copy(source = ProposalSource(door = "ask", thread = "thr_1")))
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "write the triples block")
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        store.applyProposal("prop_1")

        assertEquals(GymResult.Ok(Unit), store.deleteThread("thr_1"))

        val history = (store.routineHistory("rt_1") as GymResult.Ok).value
        val row = history.mapNotNull { it.proposal }.single { it.id == "prop_1" }
        assertEquals(ProposalState.Applied, row.state)
        assertEquals("the row still says the change came from Ask", "ask", row.source.door)
        assertEquals("the door onto the conversation is gone with it", null, row.source.conversation)
        assertEquals("and the conversation it opened is gone",
            GymResult.Failed(WriteFailure.Refused("that conversation is no longer on the log")),
            store.thread("thr_1"))
        assertEquals("the program did not move on the delete", 2, store.routine("rt_1")?.revision)
    }

    @Test
    fun testDeletingAConversationThatIsAlreadyGoneSucceedsAndAnythingElseIsSaid() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        assertEquals(GymResult.Ok(Unit), store.deleteThread("thr_gone"))

        server.refuseThreads = storageFailure
        assertEquals(GymResult.Failed(WriteFailure(storageFailure)), store.deleteThread("thr_1"))
    }

    @Test
    fun testNotesAreTheAccountsAndNeverReachTheLogSignedOut() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        val signIn = WriteFailure.Refused("Notes live with your account — sign in first")

        assertEquals(GymResult.Failed(signIn), store.readNotes())
        assertEquals(GymResult.Failed(signIn), store.saveNote("note_1", NoteWrite("Tone", "blunt")))
        assertEquals(signIn, store.deleteNote("note_1"))
        assertEquals(GymResult.Failed(signIn), store.reorderNotes(listOf("note_1")))
        assertTrue(server.calls.none { it in listOf("notes", "writeNote", "deleteNote", "reorderNotes") })
    }

    @Test
    fun testANoteIsSavedEditedReorderedAndDeletedInTheLogsOwnOrder() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        val first = store.saveNote("note_a", NoteWrite("How I want to be talked to", "Blunt."))
        val second = store.saveNote("note_b", NoteWrite("What I am training for", "A 140 squat."))
        assertEquals(GymResult.Ok(Note("note_a", 0, "How I want to be talked to", "Blunt.", 7_000)), first)
        assertEquals(GymResult.Ok(Note("note_b", 1, "What I am training for", "A 140 squat.", 7_000)), second)

        assertEquals("a spent id edits in place and keeps its position",
            GymResult.Ok(Note("note_a", 0, "How I want to be talked to", "Blunt, no cheering.", 7_000)),
            store.saveNote("note_a", NoteWrite("How I want to be talked to", "Blunt, no cheering.")))

        val reordered = store.reorderNotes(listOf("note_b", "note_a"))
        assertEquals(GymResult.Ok(listOf(
            Note("note_b", 0, "What I am training for", "A 140 squat.", 7_000),
            Note("note_a", 1, "How I want to be talked to", "Blunt, no cheering.", 7_000),
        )), reordered)

        assertNull(store.deleteNote("note_b"))
        assertNull("a note already gone is gone", store.deleteNote("note_b"))
        assertEquals(GymResult.Ok(listOf(
            Note("note_a", 0, "How I want to be talked to", "Blunt, no cheering.", 7_000),
        )), store.readNotes())
    }

    @Test
    fun testTheLogsRefusalsReachTheScreenInTheLogsOwnWords() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        repeat(10) { store.saveNote("note_$it", NoteWrite("note $it", "")) }

        assertEquals(GymResult.Failed(WriteFailure.Refused("10 of 10 notes. Delete one to add another.")),
            store.saveNote("note_more", NoteWrite("eleven", "")))
        assertEquals(GymResult.Failed(WriteFailure.Refused("a note runs to 500 bytes")),
            store.saveNote("note_0", NoteWrite("note 0", "x".repeat(501))))
        assertEquals(GymResult.Failed(WriteFailure.Refused("a title runs to 60 characters")),
            store.saveNote("note_0", NoteWrite("t".repeat(61), "")))
        // A short order is the ordinary case — the drawn rows, with a note inside its undo window
        // left out — and the store names the rest back in. What the log still refuses is an order
        // naming a note it does not hold.
        assertEquals(GymResult.Failed(WriteFailure.Refused("that order does not name every note")),
            store.reorderNotes(listOf("note_gone")))

        server.refuseNotes = storageFailure
        assertEquals("a quiet log is not an empty notebook",
            GymResult.Failed(WriteFailure.Refused("internal error")), store.readNotes())
        assertEquals(WriteFailure.Refused("internal error"), store.deleteNote("note_0"))
    }

    @Test
    fun testTheThreadDoorsNeverReachTheLogSignedOut() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        val signIn = WriteFailure.Refused("Coach reads your log — sign in first")

        assertEquals(GymResult.Failed(signIn), store.readThreads())
        assertEquals(GymResult.Failed(signIn), store.thread("thr_1"))
        assertEquals(GymResult.Failed(signIn), store.deleteThread("thr_1"))
        assertTrue(server.calls.none { it in listOf("threads", "thread", "deleteThread") })
    }

    @Test
    fun testADayBuiltAtHomeSavesWithAnOpenRowIntact() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server, )
        store.connect(account(signedIn = true))

        val draft = RoutineDraft(name = "  Heavy Thursday  ", position = 3)
            .adding("back-squat")
            .adding("barbell-row")
            .targeting("back-squat", sets = 5, reps = 3, weightKg = 110.0)

        val saved = (store.saveRoutine(draft) as GymResult.Ok).value

        assertEquals("the name is trimmed and never blank", "Heavy Thursday", saved.name)
        assertEquals(listOf(5, null), saved.entries.sortedBy { it.position }.map { it.targetSets })
        assertNull("an open row carries no reps either",
            saved.entries.single { it.exerciseId == "barbell-row" }.targetReps)
        assertTrue("it is on the list the moment it lands", store.routines.any { it.id == saved.id })
        assertTrue("and it has never been trained", saved.untested)
        assertEquals(listOf(null, 5), server.written.getValue(saved.id).entries
            .sortedBy { it.position }.map { it.targetSets }.reversed())
    }

    @Test
    fun testAnEmptyDayIsRefusedInWordsAndNothingGoesOut() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        server.calls.clear()

        assertEquals(GymResult.Failed(WriteFailure.Refused("a routine needs a name")),
            store.saveRoutine(RoutineDraft(name = "   ").adding("back-squat")))
        assertEquals(GymResult.Failed(WriteFailure.Refused("a routine needs at least one movement")),
            store.saveRoutine(RoutineDraft(name = "Heavy Thursday")))
        assertTrue("nothing on the wire", server.calls.isEmpty())
    }

    @Test
    fun testSignedOutTheDayLandsOnTheShelfAndSurvivesARelaunch() = runTest {
        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))

        val saved = (store.saveRoutine(RoutineDraft(name = "Heavy Thursday")
            .adding("deadlift")) as GymResult.Ok).value

        assertEquals(listOf("Heavy Thursday"), store.routines.map { it.name })

        val relaunched = makeStore(sync = null)
        relaunched.connect(account(signedIn = false))
        assertEquals(listOf(saved.id), relaunched.routines.map { it.id })
        assertNull(relaunched.routines.single().entries.single().targetSets)
    }

    @Test
    fun testRenamingARoutineIsTheWholeDocumentAndSupersedesAPendingProposal() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal())
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        val renamed = (store.saveRoutine(
            RoutineDraft.of(store.routine("rt_1")!!).named("Heavy Thursday")) as GymResult.Ok).value

        assertEquals("Heavy Thursday", renamed.name)
        assertEquals("the same routine, not a fork", "rt_1", renamed.id)
        assertEquals(2, renamed.revision)
        assertEquals("Heavy Thursday", store.routine("rt_1")?.name)
        assertEquals("its lines came through untouched",
            listOf("bench-press"), store.routine("rt_1")?.entries?.map { it.exerciseId })
        assertEquals(ProposalState.Superseded, server.ledger.getValue("prop_1").state)
    }

    @Test
    fun testTheRoutinesHistoryCarriesItsCreationAndItsProposalsInOneRead() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal())
        server.creations["rt_1"] = RoutineEvent(kind = "created", atMs = 3_000, movements = 4)
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        val history = (store.routineHistory("rt_1") as GymResult.Ok).value

        assertEquals(listOf("proposal", "created"), history.map { it.kind })
        assertEquals("the created row is last and carries the count it was built with",
            4, history.last().movements)
        assertNull("nobody's hand but the lifter's", history.last().by)
        assertEquals("prop_1", history.first().proposal?.id)
    }

    @Test
    fun testAHistoryThatCouldNotBeReadIsNotAnEmptyOne() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        server.refuseRoutineRead = storageFailure
        assertEquals(GymResult.Failed(WriteFailure.Refused("internal error")),
            store.routineHistory("rt_1"))

        server.refuseRoutineRead = null
        server.online = false
        assertEquals(GymResult.Failed(WriteFailure.NoAnswer), store.routineHistory("rt_1"))
    }

    @Test
    fun testADroppedShelfRoutineLeavesAndItsSessionsKeepTheirSets() = runTest {
        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))
        val kept = (store.saveRoutine(RoutineDraft(name = "Push Day")
            .adding("bench-press")
            .targeting("bench-press", sets = 5, reps = 5, weightKg = 100.0)) as GymResult.Ok).value
        store.start(routineId = kept.id)
        store.choose("bench-press")
        store.logSet(weightKg = 100.0, reps = 5)
        clockMs += 60_000
        store.finish()

        assertNull("the drop is a success, and nothing needed the wire", store.dropRoutine(kept.id))

        assertEquals(emptyList<Routine>(), store.routines)
        assertEquals("the shelf let go of the document", emptyList<Routine>(), shelfOnDisk(null).routines)
        val past = shelfOnDisk(null).finished.single()
        assertEquals("the session run under it keeps every set", listOf(100.0), past.sets.map { it.weightKg })
        assertNull("only the dead id goes — the claim replays this session ad-hoc", past.session.routineId)
        assertEquals("the frozen plan is a copy, not a reference, and it stays",
            "Push Day", past.session.plan?.routine)

        assertEquals("a routine the shelf never held is the account's, and the sentence says so",
            WriteFailure.Refused("that routine is on your account — sign in to change it"),
            store.dropRoutine("rt_account"))
    }

    @Test
    fun testADroppedAccountRoutineLeavesOnlyWhenTheLogSaysSo() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        server.refuseRoutineDelete = storageFailure
        assertEquals("the log's own sentence, and the routine stands",
            WriteFailure.Refused("internal error"), store.dropRoutine("rt_1"))
        assertEquals(listOf("rt_1"), store.routines.map { it.id })
        assertEquals(setOf("rt_1"), server.written.keys)

        server.refuseRoutineDelete = null
        server.online = false
        assertEquals(WriteFailure.NoAnswer, store.dropRoutine("rt_1"))
        assertEquals("an unreachable log moves nothing either", listOf("rt_1"), store.routines.map { it.id })

        server.online = true
        assertNull(store.dropRoutine("rt_1"))
        assertEquals(listOf("deleteRoutine", "deleteRoutine", "deleteRoutine"),
            server.calls.filter { it == "deleteRoutine" })
        assertEquals(emptyList<Routine>(), store.routines)
        assertEquals(emptySet<String>(), server.written.keys)
    }

    @Test
    fun testADeleteOfARoutineAlreadyGoneAnswersAsSuccess() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        assertEquals(listOf("rt_1"), store.routines.map { it.id })

        server.written.remove("rt_1")
        server.refuseRoutineDelete = refusal(404, message = "no such routine")

        assertNull("asked for it not to be there, and it is not there", store.dropRoutine("rt_1"))
        assertEquals("the list lets go without a second read", emptyList<Routine>(), store.routines)
        assertTrue("nothing to say out loud about a wish already granted", store.refusals.isEmpty())
    }

    @Test
    fun testACreatedMovementCarriesTheLoadingTheLifterPicked() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        val made = (store.create("Hammer row", "machine") as GymResult.Ok).value

        assertEquals("machine", made.equipment)
        assertEquals("Hammer row", made.name)
        assertTrue("a movement the lifter minted is tagged as theirs", made.custom)
        assertEquals("machine", server.catalog.single { it.id == made.id }.equipment)

        val onTheShelf = makeStore(sync = null)
        onTheShelf.connect(account(signedIn = false))
        val local = (onTheShelf.create("Sled push", "bodyweight") as GymResult.Ok).value
        assertEquals("bodyweight", local.equipment)
    }

    @Test
    fun testTheAliasIsOnlyPromisedWhereTheRenameReachesTheAccount() = runTest {
        val anon = makeStore(sync = null)
        anon.connect(account(signedIn = false))
        val mine = (anon.create("Hammer row", "machine") as GymResult.Ok).value
        assertFalse("signed out there is no alias table to keep anything in",
            anon.renameKeepsAnAlias(mine.id))

        val server = FakeTraining()
        server.catalog = listOf(Exercise(id = "bench-press", name = "Bench Press"))
        server.refuseCreate = storageFailure
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        assertTrue("a catalog movement renames on the log", store.renameKeepsAnAlias("bench-press"))
        assertFalse("one the claim has not carried yet does not", store.renameKeepsAnAlias(mine.id))
    }

    @Test
    fun testAShelfRoutineTrainedOnThisDeviceIsNoLongerUntested() = runTest {
        val store = makeStore(sync = null, mintSession = { "ses_local" })
        store.connect(account(signedIn = false))
        val routine = (store.saveRoutine(RoutineDraft(name = "Heavy Thursday")
            .adding("deadlift")) as GymResult.Ok).value

        assertTrue(store.routines.single().untested)

        store.start(routine.id)
        store.choose("deadlift")
        store.logSet(weightKg = 140.0, reps = 5)
        store.finish()

        assertFalse("a session ran under it, and the shelf can see that",
            store.routines.single().untested)
        assertEquals(store.recent.single().startedAtMs, store.routines.single().lastTrainedAtMs)

        store.discard(store.recent.single().id)
        assertTrue(store.routines.single().untested)
    }

    @Test
    fun testTheQueueDrainsBeforeTheClaimsStartCanSettleTheWorkoutUnderIt() = runTest {
        val server = FakeTraining()
        server.nowMs = { clockMs }
        val store = liveStore(server)
        server.online = false
        store.logSet(weightKg = 82.5, reps = 5)
        val loggedAt = queueOnDisk().pending.single().set.completedAtMs
        shelfOnDisk().hold(LocalLog.FinishedSession(
            Session(id = "ses_past", startedAtMs = 500, finishedAtMs = 600),
            listOf(TrainingSet(id = "set_past", exerciseId = "back-squat", weightKg = 100.0, reps = 5,
                completedAtMs = 550))))

        clockMs += 5 * 60 * 60 * 1000
        server.online = true
        val before = server.calls.size
        val morning = makeStore(sync = server)
        morning.connect(account(signedIn = true))

        val walk = server.calls.drop(before).filter { it in setOf("start", "append", "finish", "sessions") }
        assertEquals("the owed set before any start, and the read last",
            listOf("append", "start", "append", "finish", "sessions"), walk)
        assertEquals("last night's set is on the log",
            listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals("and the log closed the workout at that set, not at this morning",
            loggedAt, server.stored.getValue("ses_1").finishedAtMs)
        assertEquals("the shelf session claimed behind it", listOf(100.0), server.sets.getValue("ses_past").map { it.weightKg })
        assertTrue(morning.refusals.isEmpty())
        assertNull("the room stands over no session — the log closed it", morning.session)
        assertTrue(shelfOnDisk().finished.isEmpty())
    }

    @Test
    fun testARecordReadWaitsForTheClaimRunnerToEnd() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()

        val gate = CompletableDeferred<Unit>()
        server.onFinish = { gate.await() }
        val connecting = launch { store.connect(account(signedIn = true)) }
        runCurrent()
        assertEquals("the claim stands parked inside the shelved session's finish",
            listOf("ses_minted"), server.finished.map { it.first })

        val reading = launch { store.record("bench-press") }
        runCurrent()
        assertFalse("no record read while the claim has a session open on the log",
            server.calls.contains("record"))

        gate.complete(Unit)
        connecting.join()
        reading.join()
        assertTrue("and it read once the runner ended", server.calls.contains("record"))
        assertTrue(server.calls.indexOf("record") > server.calls.lastIndexOf("finish"))
    }

    @Test
    fun testAClaimedLiveSessionIsNotReStartedOnConnectAndItsSetsWalk() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        assertFalse("adopted from the log: the log's", queueOnDisk().sessionIsUnclaimed)

        val relaunched = makeStore(sync = server)
        relaunched.connect(account(signedIn = true))
        assertEquals("no start replay for a session the log answered for", 0, server.started.size)
        relaunched.choose("bench-press")
        relaunched.logSet(weightKg = 82.5, reps = 5)
        assertEquals("its set walked straight to the log", listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals(SaveState.OnTheLog, relaunched.saveState)
    }

    @Test
    fun testAShelfSessionBehindThePhonesOwnLiveWorkoutWaitsForItsFinishRatherThanParkingIt() = runTest {
        val server = FakeTraining()
        shelfOnDisk().hold(LocalLog.FinishedSession(
            Session(id = "ses_past", startedAtMs = 500, finishedAtMs = 600),
            listOf(TrainingSet(id = "set_past", exerciseId = "back-squat", weightKg = 100.0, reps = 5,
                completedAtMs = 550))))
        val store = liveStore(server)

        assertEquals("the shelf start was refused and nothing waited behind it",
            listOf("start"), server.calls.filter { it == "start" })
        assertEquals("the shelf keeps its session", 1, shelfOnDisk().finished.size)
        assertFalse("the phone's live workout is still the log's", queueOnDisk().sessionIsUnclaimed)
        store.logSet(weightKg = 82.5, reps = 5)
        assertEquals("its set walked to the log rather than parking", listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals(0, store.strandedCount)

        clockMs += 60_000
        val closed = store.finish()
        assertTrue("finished on the log, not on the device: $closed", closed is FinishOutcome.Closed)
        assertFalse(server.stored.getValue("ses_1").isOpen)
        assertEquals("and the shelf session claimed the moment the road opened",
            listOf(100.0), server.sets.getValue("ses_past").map { it.weightKg })
        assertTrue(shelfOnDisk().finished.isEmpty())
        assertEquals(setOf("ses_1", "ses_past"), store.recent.map { it.id }.toSet())
    }

    @Test
    fun testAnAppend404OnAClaimedSessionIsTheWorkoutGoneSaidOnceAndForgotten() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        server.stored.remove("ses_1")
        server.sets.remove("ses_1")

        store.logSet(weightKg = 82.5, reps = 5)

        assertEquals(listOf("that workout is no longer on the log"), store.refusals.map { it.reason })
        assertEquals(listOf(82.5), store.refusals.map { (it as RefusedSet).weightKg })
        assertEquals(SaveState.Refused("that workout is no longer on the log"), store.saveState)
        assertNull("the session is forgotten", store.session)
        assertNull(queueOnDisk().session)
        assertEquals("nothing owed, nothing stranded", 0, store.strandedCount)
        assertTrue("and the log was re-read", server.calls.lastIndexOf("sessions") > server.calls.lastIndexOf("append"))
        val sent = server.appended.size
        advanceTimeBy(9_000)
        runCurrent()
        assertEquals("no cadence retries a workout that is gone", sent, server.appended.size)
    }

    @Test
    fun testFinishSaysNoAnswerOnlyForTheTransportAndAGoneWorkoutIsForgotten() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        store.logSet(weightKg = 82.5, reps = 5)

        server.online = false
        assertEquals(FinishOutcome.Failed(WriteFailure.NoAnswer), store.finish())
        assertEquals("ses_1", store.session?.id)

        server.online = true
        server.stored.remove("ses_1")
        server.sets.remove("ses_1")
        assertEquals(FinishOutcome.Failed(WriteFailure.Refused("that workout is no longer on the log")), store.finish())
        assertNull("nothing left to stand over", store.session)
        assertNull(queueOnDisk().session)
        assertTrue(server.calls.lastIndexOf("sessions") > server.calls.lastIndexOf("finish"))
    }

    @Test
    fun testASignedInOfflineConnectDrawsTheAccountsDeviceCopyAndKeepsItsPreferences() = runTest {
        val server = FakeTraining()
        server.written["rt_push"] = Routine(id = "rt_push", name = "Push Day", entries = listOf(
            RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 3)))
        server.served.add(LastSet("bench-press", 82.5, 5, atMs = 900))
        server.catalog = listOf(Exercise("bench-press", "Flat press"))
        val online = makeStore(sync = server)
        online.connect(account(signedIn = true))
        online.loadLastSets()
        online.savePreferences(GymPreferences(restSeconds = 90))
        assertEquals(listOf("Push Day"), online.routines.map { it.name })

        server.online = false
        val basement = makeStore(sync = server)
        basement.connect(account(signedIn = true))
        assertEquals("the program is the copy this phone read for the seat",
            listOf("Push Day"), basement.routines.map { it.name })
        assertEquals("the names too", "Flat press", basement.catalog.first { it.id == "bench-press" }.name)
        assertEquals("and the seat's own rack, never deleted by an offline connect",
            90, basement.preferences.restSeconds)
        basement.loadLastSets()
        assertEquals("the picker's meta from the copy, not sixty rows of silence",
            mapOf("bench-press" to LastSet("bench-press", 82.5, 5, atMs = 900)), basement.lastSets)

        val stranger = makeStore(sync = server)
        stranger.connect(account(signedIn = true, id = "u2"))
        assertEquals("nothing of the last seat crosses to the next", emptyList<Routine>(), stranger.routines)
        stranger.loadLastSets()
        assertNull(stranger.lastSets)
    }

    @Test
    fun testAnAbandonedDeviceSessionIsFinishedAtItsLastActivityOnConnect() = runTest {
        val minted = mutableListOf("ses_minted", "ses_second")
        val store = makeStore(sync = null, mintSession = { minted.removeAt(0) })
        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        val lastSetAt = store.sets.single().completedAtMs

        clockMs += 3 * 60 * 60 * 1000
        val soon = makeStore(sync = null)
        soon.connect(account(signedIn = false))
        assertEquals("three hours is still a workout", "ses_minted", soon.session?.id)

        clockMs += 2 * 60 * 60 * 1000
        val later = makeStore(sync = null)
        later.connect(account(signedIn = false))
        assertNull("five hours after the last set it is over", later.session)
        assertEquals("finished at the last set, on the shelf",
            listOf(lastSetAt), shelfOnDisk(null).finished.map { it.session.finishedAtMs })
        assertEquals(listOf(82.5), later.recent.single().let { shelfOnDisk(null).detail(it.id)!!.sets.map { s -> s.weightKg } })

        val second = makeStore(sync = null, mintSession = { minted.removeAt(0) })
        second.connect(account(signedIn = false))
        second.start()
        val startedAt = second.session!!.startedAtMs
        clockMs += 5 * 60 * 60 * 1000
        val empty = makeStore(sync = null)
        empty.connect(account(signedIn = false))
        assertNull(empty.session)
        assertEquals("a session with no sets ended when it began",
            startedAt, shelfOnDisk(null).row("ses_second")!!.session.finishedAtMs)
    }

    @Test
    fun testAClaimedSessionAbandonedForHoursIsLetGoOnConnectAndTheLogEndsIt() = runTest {
        val server = FakeTraining()
        server.nowMs = { clockMs }
        val store = liveStore(server)
        server.online = false
        store.logSet(weightKg = 82.5, reps = 5)
        val lastSetAt = store.sets.single().completedAtMs
        assertFalse(queueOnDisk().sessionIsUnclaimed)

        clockMs += 30 * 60 * 60 * 1000
        val relaunched = makeStore(sync = server)
        relaunched.connect(account(signedIn = true))

        assertNull("the room let the workout go", relaunched.session)
        assertEquals("its owed set is still queued, under that session",
            listOf("ses_1" to 82.5), queueOnDisk().pending.map { it.sessionId to it.set.weightKg })
        assertTrue("nothing was shelved", shelfOnDisk().finished.isEmpty())
        assertTrue("no finish was sent", server.finished.isEmpty())
        assertTrue("and the log still holds it open — the read is what will end it",
            server.stored.getValue("ses_1").isOpen)

        server.online = true
        val online = makeStore(sync = server)
        online.connect(account(signedIn = true))
        assertNull(online.session)
        assertEquals("the owed set drained into it before the read",
            listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals("and the read ended the workout at that set",
            lastSetAt, server.stored.getValue("ses_1").finishedAtMs)
        assertTrue(queueOnDisk().pending.isEmpty())
        assertTrue(server.finished.isEmpty())
    }

    @Test
    fun testALapsedSignInIsNamedRatherThanCalledNoSignal() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        server.refuse = { refusal(401, message = "sign in to continue") }

        store.logSet(weightKg = 82.5, reps = 5)

        assertEquals(SaveState.Blocked(Blocker.SignInLapsed), store.saveState)
        assertEquals("sign in again · saved here", store.saveState.line)
        assertEquals(Blocker.SignInLapsed, store.strandedBy)
        assertEquals(1, store.strandedCount)
        assertTrue("still owed, never dropped", store.refusals.isEmpty())
    }

    @Test
    fun testAWorkoutComposedOfflineUnderOneSeatIsNeverReplayedIntoTheNextAccount() = runTest {
        val alicesLog = FakeTraining()
        val bobsLog = FakeTraining()
        val store = makeStore(logs = mapOf("alice" to alicesLog, "bob" to bobsLog))

        store.connect(account(signedIn = true, id = "alice"))
        alicesLog.online = false
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        store.finish()
        assertEquals("composed on the device, waiting for a signal",
            1, shelfOnDisk().let { it.adopt("alice"); it.finished.size })

        store.connect(account(signedIn = false))
        store.connect(account(signedIn = true, id = "bob"))

        assertEquals("B's log was never told about A's workout",
            emptyList<String>(), bobsLog.stored.keys.toList())
        assertTrue("not even attempted under B's bearer", bobsLog.started.isEmpty())
        assertTrue("nor its sets", bobsLog.appended.isEmpty())
        assertEquals("and B's room draws none of it", emptyList<String>(), store.recent.map { it.id })

        alicesLog.online = true
        store.connect(account(signedIn = true, id = "alice"))
        assertEquals(listOf("ses_minted"), alicesLog.stored.keys.toList())
        assertEquals("A's owed set landed on A's log, in full",
            listOf(82.5), alicesLog.sets.getValue("ses_minted").map { it.weightKg })
        assertTrue("and the shelf let go once A's log confirmed",
            shelfOnDisk().let { it.adopt("alice"); it.finished.isEmpty() })
    }

    @Test
    fun testThePreviousSeatsLiveWorkoutIsNotDrawnForTheNextOne() = runTest {
        val alicesLog = FakeTraining()
        val bobsLog = FakeTraining()
        val store = makeStore(logs = mapOf("alice" to alicesLog, "bob" to bobsLog))

        store.connect(account(signedIn = true, id = "alice"))
        alicesLog.online = false
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 100.0, reps = 3)
        assertEquals("ses_minted", store.session?.id)

        store.connect(account(signedIn = false))
        assertNull("signing out takes the workout off the screen with the seat", store.session)
        assertEquals(emptyList<Double>(), store.sets.map { it.weightKg })

        store.connect(account(signedIn = true, id = "bob"))
        assertNull("and B is not standing in A's workout", store.session)
        assertTrue("so nothing of A's is owed under B's bearer", bobsLog.appended.isEmpty())

        store.connect(account(signedIn = true, id = "alice"))
        assertEquals("A comes back to their own bar", "ses_minted", store.session?.id)
        assertEquals(listOf(100.0), store.sets.map { it.weightKg })
    }

    @Test
    fun testWorkMadeSignedOutStillClaimsOntoTheFirstAccountThatSignsIn() = runTest {
        val alicesLog = FakeTraining()
        val store = makeStore(logs = mapOf("alice" to alicesLog))

        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 60.0, reps = 8)
        store.finish()

        store.connect(account(signedIn = true, id = "alice"))
        assertEquals(listOf("ses_minted"), alicesLog.stored.keys.toList())
        assertEquals(listOf(60.0), alicesLog.sets.getValue("ses_minted").map { it.weightKg })
        assertTrue(shelfOnDisk().let { it.adopt("alice"); it.finished.isEmpty() })
    }

    @Test
    fun testAnUnverifiedSeatDoesNotClaimTheAnonymousShelf() = runTest {
        val alicesLog = FakeTraining()
        val store = makeStore(logs = mapOf("alice" to alicesLog))

        store.connect(account(signedIn = false))
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 60.0, reps = 8)
        store.finish()

        val remembered = Account(
            api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
            user = User(id = "alice", email = "sam@example.com", name = "Sam"),
            verified = false)
        store.connect(remembered)
        assertEquals("nothing of nobody's was claimed onto a seat nobody answered for",
            emptyList<String>(), alicesLog.stored.keys.toList())
        assertEquals("and the room draws none of it either", emptyList<String>(),
            store.recent.map { it.id })

        store.connect(account(signedIn = true, id = "alice"))
        assertEquals("the first verified connect claims it", listOf("ses_minted"),
            alicesLog.stored.keys.toList())
    }

    @Test
    fun testAShelfFromBeforeTheSeatsBelongsToTheSeatThePhoneWasHoldingAtTheUpgrade() = runTest {
        val alicesLog = FakeTraining()
        localFile.writeText(legacyShelf)

        val store = makeStore(logs = mapOf("alice" to alicesLog), deviceOwner = "alice")
        store.connect(account(signedIn = false))
        assertNull("no door is needed and none is offered, not even on the nobody pass",
            store.unattributed)
        store.connect(account(signedIn = true, id = "alice"))

        assertNull(store.unattributed)
        assertEquals("it is A's own history and it claims like any other shelf row",
            listOf("ses_before"), alicesLog.stored.keys.toList())
        assertEquals(listOf(90.0), alicesLog.sets.getValue("ses_before").map { it.weightKg })

        val bobsLog = FakeTraining()
        val shared = makeStore(logs = mapOf("alice" to alicesLog, "bob" to bobsLog))
        shared.connect(account(signedIn = false))
        shared.connect(account(signedIn = true, id = "bob"))
        assertEquals(emptyList<String>(), bobsLog.stored.keys.toList())
        assertNull(shared.unattributed)
    }

    @Test
    fun testAShelfFromBeforeTheSeatsOnASignedOutPhoneIsQuarantinedAndReleasedByHand() = runTest {
        val alicesLog = FakeTraining()
        localFile.writeText(legacyShelf)

        val store = makeStore(logs = mapOf("alice" to alicesLog), deviceOwner = null)
        store.connect(account(signedIn = false))
        assertEquals("nobody's, so nobody's log draws it", emptyList<String>(),
            store.recent.map { it.id })
        assertEquals(1, store.unattributed?.sessions)
        assertEquals(listOf(1_000L), store.unattributed?.days)

        store.connect(account(signedIn = true, id = "alice"))
        assertEquals("no account walks in and inherits it", emptyList<String>(),
            alicesLog.stored.keys.toList())
        assertEquals(emptyList<String>(), store.recent.map { it.id })
        assertEquals("the door is still the only way out", 1, store.unattributed?.sessions)

        val bobsLog = FakeTraining()
        val relaunched = makeStore(logs = mapOf("bob" to bobsLog), deviceOwner = "bob")
        relaunched.connect(account(signedIn = false))
        relaunched.connect(account(signedIn = true, id = "bob"))
        assertEquals("BOB'S LOG RECEIVED A STRANGER'S WORKOUT", emptyList<String>(),
            bobsLog.stored.keys.toList())
        assertEquals(1, relaunched.unattributed?.sessions)

        assertNull("the human with an account says it is theirs",
            relaunched.releaseUnattributed())
        assertEquals("and only then does it claim", listOf("ses_before"),
            bobsLog.stored.keys.toList())
        assertEquals(listOf(90.0), bobsLog.sets.getValue("ses_before").map { it.weightKg })
        assertNull(relaunched.unattributed)
    }

    @Test
    fun testTheQuarantineCannotBeClaimedBySomebodyWhoIsSignedOut() = runTest {
        val alicesLog = FakeTraining()
        localFile.writeText(legacyShelf)

        val store = makeStore(logs = mapOf("alice" to alicesLog))
        store.connect(account(signedIn = false))
        assertEquals(TrainingStore.quarantineWantsAnAccount, store.releaseUnattributed())
        assertEquals("and nothing moved", 1, store.unattributed?.sessions)

        store.connect(account(signedIn = true, id = "alice"))
        assertNull(store.releaseUnattributed())
        assertEquals(listOf("ses_before"), alicesLog.stored.keys.toList())
    }

    @Test
    fun testAQuarantineTheQueueCannotTakeMovesNeitherHalfAndSaysSo() = runTest {
        val alicesLog = FakeTraining()
        queueFile.writeText("""{"session":{"id":"ses_before","startedAt":1000},"entries":{}}""")
        localFile.writeText(legacyShelf)

        val store = makeStore(logs = mapOf("alice" to alicesLog), deviceOwner = null)
        store.connect(account(signedIn = false))
        store.connect(account(signedIn = true, id = "alice"))
        assertEquals(1, store.unattributed?.sessions)

        alicesLog.online = false
        store.start()
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)

        assertEquals(TrainingStore.liveSlotTaken, store.releaseUnattributed())
        assertEquals("the shelf's half did not land on its own", 1, store.unattributed?.sessions)
        assertTrue("and the queue's half is still quarantined too", store.unattributedIsLive)
        assertEquals("nor did A lose the bar they were under", "ses_minted", store.session?.id)
    }

    @Test
    fun testALiveWorkoutFromBeforeTheSeatsIsQuarantinedAndStillOffered() = runTest {
        val alicesLog = FakeTraining()
        queueFile.writeText("""{"session":{"id":"ses_before","startedAt":1000},"entries":{}}""")

        val store = makeStore(logs = mapOf("alice" to alicesLog), deviceOwner = null)
        store.connect(account(signedIn = false))
        assertNull("nobody is standing in somebody else's workout", store.session)
        assertTrue("and the row is offered even with an empty shelf behind it",
            store.unattributedIsLive)
        assertEquals(0, store.unattributed?.sessions)

        store.connect(account(signedIn = true, id = "alice"))
        assertNull(store.releaseUnattributed())
        assertEquals("ses_before", store.session?.id)
    }


    @Test
    fun testALiveWorkoutFromBeforeTheSeatsBelongsToTheSeatThePhoneWasHolding() = runTest {
        val alicesLog = FakeTraining()
        queueFile.writeText("""{"session":{"id":"ses_before","startedAt":1000},"entries":{}}""")

        val store = makeStore(logs = mapOf("alice" to alicesLog), deviceOwner = "alice")
        store.connect(account(signedIn = false))
        store.connect(account(signedIn = true, id = "alice"))

        assertEquals("ses_before", store.session?.id)
        assertNull("no door is needed and none is offered", store.unattributed)
        assertFalse(store.unattributedIsLive)
    }

}
