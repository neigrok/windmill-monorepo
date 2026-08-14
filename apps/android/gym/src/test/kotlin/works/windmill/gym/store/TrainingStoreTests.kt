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
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.AskTurn
import works.windmill.gym.domain.ThreadOutcome
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.LastTime
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

// What has to be true for a set somebody lifted to survive: it is on the device before the log is
// consulted, it stays there when the log cannot be reached, the four refusals each get the repair
// they ask for, and a set that will never land is SAID rather than swallowed. These are the paths
// that lose training.

// Refusals as the wire delivers them — a sentence for a human under "error", and, for the reasons
// a client must branch on, a machine word under "code". The tests below deliberately reword the
// sentences: the code is the contract and nothing here may read English to decide what to do.
private fun refusal(status: Int, code: String? = null, message: String) =
    WindmillApiException.Refused(status, Refusal(message = message, code = code))

private val storageFailure = refusal(500, message = "internal error")

class TrainingStoreTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private var clockMs = 1_000L
    private lateinit var queueFile: File
    private lateinit var catalogFile: File
    private lateinit var localFile: File
    private lateinit var preferencesFile: File

    @Before
    fun setUp() {
        clockMs = 1_000
        queueFile = File(tmp.root, "gym-${System.nanoTime()}.json")
        catalogFile = File(tmp.root, "gym-catalog-${System.nanoTime()}.json")
        localFile = File(tmp.root, "gym-local-${System.nanoTime()}.json")
        preferencesFile = File(tmp.root, "gym-prefs-${System.nanoTime()}.json")
    }

    // The undo window is off here on purpose. What every test below is about is what happens to a
    // set once the walk REACHES it — the refusals, the remints, the lanes, the ordering — and a
    // nine-second hold in front of that would only be a delay between the tap and the subject.
    // The window has its own tests (UndoWindowStoreTests), where it is the subject.
    private fun TestScope.makeStore(
        sync: TrainingSyncing?,
        mintSet: () -> String = Ids::set,
        mintSession: () -> String = { "ses_minted" },
        retryAfterMs: Long = 4_000,
        undoWindowMs: Long = 0,
    ) = TrainingStore(
        queue = SetQueue(queueFile) { clockMs },
        deviceCatalog = DeviceCatalog(catalogFile),
        localLog = LocalLog(localFile),
        localPreferences = LocalPreferences(preferencesFile),
        scope = backgroundScope,
        now = { clockMs += 1; clockMs },
        mintSession = mintSession,
        mintSet = mintSet,
        undoWindowMs = undoWindowMs,
        retryAfterMs = retryAfterMs,
        sync = { if (it.isSignedIn) sync else null },
    )

    private fun account(signedIn: Boolean, id: String = "u1") = Account(
        api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
        user = if (signedIn) User(id = id, email = "sam@example.com", name = "Sam") else null,
    )

    // A store standing where the room stands mid-workout: a session open on the log, a movement in
    // hand, nothing owed yet.
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

    // The set is the lifter's the instant they tap and the network's problem afterwards — so a
    // basement gym costs nothing, a relaunch costs nothing, and the words say exactly that.
    @Test
    fun testASetLoggedOfflineSurvivesARelaunchAndFlushesOnReconnect() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.online = false
        store.logSet(weightKg = 82.5, reps = 5)

        assertEquals(SaveState.Offline, store.saveState)
        assertEquals("offline · saved here", store.saveState.line)
        assertEquals("the row is on screen — the device is holding it",
            listOf(82.5), store.sets.map { it.weightKg })
        assertEquals(1, SetQueue(queueFile).pending.size)

        server.online = true
        val relaunched = makeStore(sync = server)
        relaunched.connect(account(signedIn = true))

        assertEquals(listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals("the log numbered it, so it is the log's now",
            listOf(1), relaunched.sets.map { it.setNumber })
        assertTrue(SetQueue(queueFile).pending.isEmpty())
    }

    // 409 `set-id-taken` means that id names a row outside this session. A new id lands the same
    // set; treating it as terminal would drop a lift over a collision the device can repair by
    // itself.
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

    // 409 `session-finished` is the one refusal that costs a set: it never landed and never will.
    // It is removed and SAID — the banner is the last copy of it, so it carries the movement too.
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
        assertTrue(SetQueue(queueFile).pending.isEmpty())
    }

    // The queue's whole premise: send in any order, any number of times, and converge on one row
    // per minted id. A reply that never arrived leaves the set owed, and the replay answers with
    // the row the log already stored rather than filing it a second time.
    @Test
    fun testAReplyThatNeverArrivedIsReplayedAndTheLogStillHoldsOneRow() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.swallowReplies = 1
        store.logSet(weightKg = 82.5, reps = 5)
        assertEquals(SaveState.Offline, store.saveState)
        assertEquals(1, SetQueue(queueFile).pending.size)

        store.flushPendingSets()

        assertEquals("the same set went out twice", 2, server.appended.size)
        assertEquals("and the log converged on one row", 1, server.sets.getValue("ses_1").size)
        assertEquals(listOf(1), store.sets.map { it.setNumber })
        assertEquals(SaveState.OnTheLog, store.saveState)
    }

    // A session that closed before a set reached it refuses that set forever, so finishing drains
    // first and closes second. The order is the whole rule.
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

    // ...and when they cannot be drained, Finish does not fire at all. Closing over an undelivered
    // set is the one loss the device can see coming.
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

    // The close is a round trip, and a set logged into a session that closes under it is refused
    // forever. The pad is shut for exactly that window — and `isFinishing` is published so the
    // room can say where that set can still go rather than swallowing the tap.
    @Test
    fun testASetTappedWhileTheSessionIsClosingIsNotFiledIntoIt() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.onFinish = { store.logSet(weightKg = 60.0, reps = 10) }
        val outcome = store.finish()

        assertTrue("the session did not close: $outcome", outcome is FinishOutcome.Closed)
        assertNull("nothing was filed into a session that was closing", server.sets["ses_1"])
        assertTrue("and nothing was left owed against it", SetQueue(queueFile).pending.isEmpty())
    }

    // A 500 is the STORE failing, not the set being refused. Keeping it queued is the difference
    // between a five-second lock wait and a lift thrown away.
    @Test
    fun testAStorageFailureKeepsTheSetQueuedRatherThanRefusingIt() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.refuse = { storageFailure }
        store.logSet(weightKg = 90.0, reps = 5)

        assertEquals(1, SetQueue(queueFile).pending.size)
        assertTrue("the server failing is not the set being refused", store.refusals.isEmpty())
        assertEquals(SaveState.Offline, store.saveState)
        assertEquals("the row stays on screen — the device is holding it", 1, store.sets.size)
    }

    // Order is per (session, movement), because that is the only order the server keeps. A jam
    // that stopped the whole queue would stop a whole workout, silently.
    @Test
    fun testASetThatCannotLandHoldsUpItsOwnMovementAndNoOther() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)

        server.refuse = { if (it.exerciseId == "bench-press") storageFailure else null }
        store.logSet(weightKg = 82.5, reps = 5)
        store.choose("back-squat")
        store.logSet(weightKg = 100.0, reps = 5)

        assertEquals(listOf("back-squat"), server.sets.getValue("ses_1").map { it.exerciseId })
        assertEquals(listOf("bench-press"), SetQueue(queueFile).pending.map { it.set.exerciseId })
        assertEquals("both are on screen — one is on the log and one is on the device",
            listOf("bench-press", "back-squat"), store.sets.map { it.exerciseId })
    }

    // A START IS NEVER A SILENT JOIN (decisions §5). The log's default is to JOIN whatever session
    // is open — ignoring the routineId that was tapped — so "Start workout" on routine B could land
    // the lifter in yesterday's workout under the wrong plan. Every user-tapped start therefore
    // states joinOpenSession: false, and the 409 that comes back while a workout is open on the
    // account is answered by REFRESHING: the store re-reads the log, adopts the open workout with
    // its own snapshot and sets, stands it where the lifter was through the ordinary resume — at
    // the movement the last set went into, never in the picker over a session of sets — and
    // repeats the refusal in the log's own words.
    @Test
    fun testStartingWhileASessionIsOpenRefusesAndSurfacesTheOpenWorkout() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        // Another device opened a workout after this phone's boot read — the exact shape that used
        // to be joined silently under the wrong plan.
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

    // The number in front of the lifter before they touch anything: the plan's target while the
    // movement is untouched, then their own last set the moment there is one.
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

    // Signed out is a WORKING state: a session opens on the device, its sets land on the device,
    // and the finish moves the whole workout onto the shelf — where a relaunch still finds it.
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
            0, SetQueue(queueFile).pending.size)
        assertEquals(listOf(82.5), LocalLog(localFile).details().single().sets.map { it.weightKg })
    }

    // The signed-out program: a routine kept from a session, listed on Today, started from — with
    // the plan frozen off the LOCAL row at start — and retargeted, all without an account.
    @Test
    fun testSignedOutARoutineIsKeptStartedFromAndRetargeted() = runTest {
        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))

        val performed = listOf(
            TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 100.0, reps = 5, completedAtMs = 1_100),
            TrainingSet(id = "set_b", exerciseId = "bench-press", weightKg = 100.0, reps = 5, completedAtMs = 1_200),
        )
        val kept = store.keep(performed, asRoutineNamed = "Push Day")
        assertNotNull(kept)
        assertTrue(kept!!.id.startsWith("rt_"))
        assertEquals(listOf("Push Day"), store.routines.map { it.name })

        val opened = (store.start(routineId = kept.id) as GymResult.Ok).value
        assertEquals("Push Day", opened.plan?.routine)
        store.choose("bench-press")
        assertEquals("the prefill dials the local plan", Prefill(100.0, 5), store.prefill)

        assertNull(store.save(105.0, toRoutine = kept.id, forExercise = "bench-press"))
        assertEquals(105.0,
            store.routines.first { it.id == kept.id }.entries.first().targetWeightKg)
        assertEquals("and the shelf holds the retargeted document for the claim",
            105.0, LocalLog(localFile).routine(kept.id)?.entries?.first()?.targetWeightKg)
    }

    // "What did I do last time" answered off the device's own history: a finished local session is
    // the next last time, warmups excluded, and no history is a first time — never a failed read.
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

    // The read-only rooms run off the shelf: a movement's record over the local finished sessions,
    // and the review of one of them — the three facts and the slight rule, computed on the device.
    // Neither invents an estimate: Epley lives on the log, and this phone draws what it can prove.
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

    // RENAME, AND THE IDENTITY IT PROVES: the name moves and the id does not, so every set logged
    // under it is still the same movement afterwards — which is the whole reason §H offers the
    // rename on the page that draws the history. A movement the shelf holds renames on the device
    // and the claim carries the name it finds; a catalog movement the shelf has never seen needs
    // the account, and says so rather than storing a name that would silently revert on connect.
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

    // Signed in, the rename is the log's and the catalog every other screen reads is updated off
    // its answer — a routine card still printing the old name after the page said it changed would
    // be the room disagreeing with itself.
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

    // A NAME IS THE SEAT'S AND NOT THE PHONE'S. A rename is a per-account override, so the copy this
    // device holds belongs to the account it was read for — and the next lifter to hold the phone,
    // offline or signed out, may not be shown it. This is the on-device half of the wave's one
    // catastrophic failure: a private name crossing a seat, on the first frame, indefinitely.
    @Test
    fun testARenameIsTheAccountsAndNeverCrossesToTheNextSeatOnThisPhone() = runTest {
        val hers = FakeTraining()
        hers.catalog = listOf(Exercise(id = "back-squat", name = "Back Squat"))
        val alice = makeStore(sync = hers)
        alice.connect(account(signedIn = true, id = "alice"))
        alice.rename("back-squat", "Alice’s Secret Squat")

        // Her own seat, with no signal at all: the copy on the device is hers and it opens on the
        // first frame, which is the whole reason the file exists.
        val herRelaunch = makeStore(sync = null)
        herRelaunch.connect(account(signedIn = true, id = "alice"))
        assertEquals("Alice’s Secret Squat", herRelaunch.catalog.single { it.id == "back-squat" }.name)

        // The next seat, equally offline — so nothing can repair the names behind his back. This is
        // the state this room is built to work in, and the one the leak used to stand in forever.
        // What he gets is the six under their SEEDED names, which are a constant every install
        // carries and nobody's private naming of anything.
        val bob = makeStore(sync = null)
        bob.connect(account(signedIn = true, id = "bob"))
        assertEquals("this phone does not know Bob's names and does not borrow Alice's",
            TheSix.movements, bob.catalog)

        val anon = makeStore(sync = null)
        anon.connect(account(signedIn = false))
        assertEquals("and signing out is not a way back into her catalog either",
            TheSix.movements, anon.catalog)
    }

    // The anonymous seat is a seat like any other, and the movements it minted are the whole catalog
    // it has: they ride with it across a relaunch, and they ride into the account that signs in over
    // them, because a movement no claim has landed yet is still on this device to be named.
    @Test
    fun testTheShelfsOwnMovementsSurviveARelaunchAndTheSeatTheySignInto() = runTest {
        val anon = makeStore(sync = null)
        anon.connect(account(signedIn = false))
        val made = (anon.create("Sled Push", "machine") as GymResult.Ok).value

        val relaunched = makeStore(sync = null)
        relaunched.connect(account(signedIn = false))
        assertEquals(TheSix.movements + made, relaunched.catalog)

        // A seat this phone holds no copy for, standing over the same shelf: before any account read
        // answers, the logger still has a name to draw at 28sp over the lifter's own lift.
        val newSeat = makeStore(sync = null)
        newSeat.connect(account(signedIn = true, id = "alice"))
        assertEquals(listOf(made) + TheSix.movements, newSeat.catalog)
    }

    // A record the log refused is not a record that is empty: the reason is repeated in the log's
    // own words, and a movement it no longer holds gets the plain fact instead of a signal blamed
    // for an answer that was on the server.
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

    // THE CLAIM, end to end: signing in replays the shelf in the contract's order — routines
    // first, then the finished session (start → its sets in performed order → finish), then the
    // live session's own start — with joinOpenSession false on every claimed start, the TRUE local
    // instants, and no log read interleaved before the last claim call. Afterwards the server is
    // the truth and the shelf is empty.
    @Test
    fun testSigningInClaimsTheShelfInOrderAndTheServerBecomesTheTruth() = runTest {
        val server = FakeTraining()
        val minted = mutableListOf("ses_a", "ses_b")
        val store = makeStore(sync = server, mintSession = { minted.removeAt(0) })
        store.connect(account(signedIn = false))

        val kept = store.keep(listOf(
            TrainingSet(id = "set_seed", exerciseId = "bench-press", weightKg = 100.0, reps = 5,
                completedAtMs = 900)), asRoutineNamed = "Push Day")!!
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
            LocalLog(localFile).finished.isEmpty() && LocalLog(localFile).routines.isEmpty())
        assertEquals("and the log lists what the shelf held",
            setOf("ses_a", "ses_b"), store.recent.map { it.id }.toSet())
    }

    // A session id another account spent is re-minted and the same workout lands whole under the
    // fresh id — for the live session that includes re-pointing every owed set in the queue.
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
        assertTrue(LocalLog(localFile).finished.isEmpty())
    }

    // `session-already-open` is the WAIT. Another device holds the account's live workout, so the
    // backlog stays whole on the shelf — nothing dropped, nothing filed into that workout — and
    // the boot still completes.
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
        assertEquals(1, LocalLog(localFile).finished.size)
        assertTrue("the boot read still ran", server.calls.contains("sessions"))
        assertEquals("the reader sees the log and the shelf together",
            setOf("ses_phone2", "ses_minted"), store.recent.map { it.id }.toSet())
    }

    // Offline mid-claim is retry, never loss: the shelf keeps everything and the next connect
    // replays it — idempotent by the minted ids, so nothing lands twice either.
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
        assertEquals(1, LocalLog(localFile).finished.size)
        assertTrue(store.refusals.isEmpty())

        server.online = true
        store.connect(account(signedIn = true))
        assertEquals(listOf(82.5), server.sets.getValue("ses_minted").map { it.weightKg })
        assertTrue(LocalLog(localFile).finished.isEmpty())
    }

    // ...and the next connect is no longer the only carrier: a claim that stopped on a retryable
    // failure re-runs on the deliver loop's own four-second task — no remount, no tap — while a
    // start during a scheduled re-claim still composes on the device, exactly as connect's does.
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
            1, LocalLog(localFile).finished.size)
        assertTrue(store.refusals.isEmpty())
        val attempted = server.started.size

        advanceTimeBy(4_100)
        runCurrent()
        assertTrue("the cadence retried the claim on its own, with nobody tapping anything",
            server.started.size > attempted)
        assertEquals("still offline — the shelf keeps everything", 1, LocalLog(localFile).finished.size)

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
        assertTrue("the shelf let go once the log confirmed", LocalLog(localFile).finished.isEmpty())
        assertEquals("the re-claim landed the device-composed workout too, without any remount",
            listOf(999.0), server.sets.getValue("ses_b").map { it.weightKg })
        assertTrue(server.stored.getValue("ses_b").isOpen)
        assertEquals("the room stands in its claimed workout", "ses_b", store.session?.id)
    }

    // TWO CLAIMS MAY NEVER OVERLAP. A local finish while the cadence's re-claim is mid-replay
    // marks the claim owed again rather than starting a second replay — and the boot read stands
    // down while any claim runs. The alternative was the cadence's ending firing loadLog while
    // the deferred replay held a re-opened past session open on the log: the store adopted the
    // workout the lifter had just finished as the phone's live one, resurrected.
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
        assertTrue("the shelf let go of both", LocalLog(localFile).finished.isEmpty())
        assertEquals("and the eventual log read lands clean — both workouts listed, neither open",
            setOf("ses_a", "ses_b"), store.recent.map { it.id }.toSet())
        assertTrue(store.recent.none { it.session.isOpen })
        assertTrue(store.refusals.isEmpty())
    }

    // The serialization itself, pinned: a claim requested while one runs goes once more when that
    // pass ends — each shelf session claimed exactly once, never a second runner interleaving
    // starts with the first.
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
        assertTrue(LocalLog(localFile).finished.isEmpty())
        assertNull(store.session)
        assertTrue(store.refusals.isEmpty())
    }

    // A loss said during a boot claim has no logger standing to show it: the refusal surfaces on
    // Today — the same banner, drawn from the same store fact the logger reads — and dismissing
    // clears what was shown.
    @Test
    fun testABootClaimLossWithNoLiveSessionSurfacesOnTodayAndDismissClears() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        store.keep(listOf(TrainingSet(id = "set_seed", exerciseId = "bench-press", weightKg = 100.0,
            reps = 5, completedAtMs = 900)), asRoutineNamed = "Push Day")

        server.refuseRoutine = { refusal(400, code = "bad-routine", message = "that document is unclaimable") }
        store.connect(account(signedIn = true))

        assertEquals("the loss is said by name, through the store fact Today draws the banner from",
            listOf(RefusedClaim(name = "Push Day", reason = "that document is unclaimable")),
            store.refusals)
        assertNull("no logger is mounted — Today is the standing screen", store.session)
        assertTrue("said once and let go, not re-said on the next connect",
            LocalLog(localFile).routines.isEmpty())

        store.clearRefusals()
        assertEquals("dismissing clears what was shown", emptyList<RefusedWrite>(), store.refusals)
    }

    // The one loss a claim can meet, said out loud: a set the server refuses forever (the session
    // closed under a previous, partial claim) is dropped from the shelf and reported — and the
    // rest of the session still settles.
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

        // The session already closed on the server — a previous claim's finish landed, this set's
        // append never did.
        server.stored["ses_minted"] = Session(id = "ses_minted", startedAtMs = 1_000, finishedAtMs = 2_000)
        server.refuse = { refusal(409, code = "session-finished", message = "reworded on a Tuesday") }
        store.connect(account(signedIn = true))

        assertEquals(listOf("the session closed before this set reached it"),
            store.refusals.map { it.reason })
        assertEquals(listOf(82.5), store.refusals.map { (it as RefusedSet).weightKg })
        assertTrue("the shelf let go — a loss said once is not re-said every connect",
            LocalLog(localFile).finished.isEmpty())
    }

    // A WARMUP IS A KIND THE LOGGER CAN WRITE, and it counts toward nothing. Before the toggle
    // existed every set this surface could produce was `working`, so a 60 kg ramp-up was fed to
    // the record rules as the mark to beat — and the finish screen minted a gold personal record
    // for it.
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

    // A set refused in one lane must not take the retry away from a set merely jammed in another.
    // Nothing else carries the jammed one: the walk cancelled the task it arrived with, so
    // returning at the refusal left it on the device with no retry and no strip saying it was
    // there.
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
        assertEquals(listOf("bench-press"), SetQueue(queueFile).pending.map { it.set.exerciseId })
        assertEquals("the strip says the bench set is on this device, whatever the other lane answered",
            1, store.strandedCount)

        val sent = server.appended.count { it.exerciseId == "bench-press" }
        advanceTimeBy(400)
        runCurrent()
        assertTrue("and the retry fired on its own, with nobody tapping anything",
            server.appended.count { it.exerciseId == "bench-press" } > sent)
    }

    // A log that answered with a reason is not a log that went quiet. The routine was deleted from
    // the web; saying "the log didn't answer" points the lifter at their signal instead of at the
    // program that is gone.
    @Test
    fun testAStartRefusedForANamedReasonSaysTheReason() = runTest {
        val server = FakeTraining()
        server.refuseStart = { refusal(404, message = "no such routine") }
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        val why = (store.start(routineId = "rt_deleted_elsewhere") as? GymResult.Failed)?.why
        assertEquals("a 404 is not a session", WriteFailure.Refused("no such routine"), why)
        assertEquals("no such routine", why?.line("a session starts there"))
        assertNull(store.session)

        server.refuseStart = { null }
        server.online = false
        val quiet = (store.start() as? GymResult.Failed)?.why
        assertEquals("an unreachable log is not a session either", WriteFailure.NoAnswer, quiet)
        assertEquals("the log didn’t answer — a session starts there",
            quiet?.line("a session starts there"))
    }

    // The write that moves next week's target. It answers with what went wrong rather than with a
    // bool nobody reads: an unreachable log and a routine gone from it are different sentences,
    // and null is the target really standing changed.
    @Test
    fun testAWriteBackThatDidNotLandSaysWhyAndMovesNothing() = runTest {
        val server = FakeTraining()
        server.written["rt_push_a"] = Routine(id = "rt_push_a", name = "Push A", position = 0,
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5,
                targetReps = 5, targetWeightKg = 82.5)))
        val store = liveStore(server)

        server.online = false
        assertEquals(WriteFailure.NoAnswer,
            store.save(87.5, toRoutine = "rt_push_a", forExercise = "bench-press"))
        assertEquals("and nothing moved",
            82.5, server.written.getValue("rt_push_a").entries.first().targetWeightKg)

        server.online = true
        assertEquals("a routine gone from the log is not a write",
            WriteFailure.Refused("that routine is no longer on the log"),
            store.save(87.5, toRoutine = "rt_gone", forExercise = "bench-press"))

        assertNull(store.save(87.5, toRoutine = "rt_push_a", forExercise = "bench-press"))
        assertEquals(87.5, server.written.getValue("rt_push_a").entries.first().targetWeightKg)
        assertEquals("the copy in hand moved with the log's",
            87.5, store.routines.first { it.id == "rt_push_a" }.entries.first().targetWeightKg)
    }

    // The picker closed on a movement that was never minted, and absolutely nothing was said.
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

    // A movement is a stable id everywhere except on screen. Held only in memory, a cold launch in
    // a basement drew `bench-press` at 28sp where `Bench Press` belongs — for the whole session. The
    // copy is the SEAT'S: it opens with no signal at all for the account that filled it, and a name
    // that account chose is not there for anybody else, because a rename is a per-account override.
    @Test
    fun testTheMovementNamesAreHeldOnTheDeviceForTheSeatThatReadThem() = runTest {
        val server = FakeTraining()
        server.catalog = listOf(Exercise(id = "bench-press", name = "Bench Press"),
            Exercise(id = "back-squat", name = "Back Squat"))
        val store = liveStore(server)
        assertEquals("what the log served, then the six it did not",
            listOf("Bench Press", "Back Squat", "Deadlift", "Overhead Press", "Barbell Row", "Chin Up"),
            store.catalog.map { it.name })

        // A cold launch with no signal: nothing is read, and the names are already there.
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

    // THE CLAIM-JOIN TRAP: a server start JOINS whatever session is open, and mid-claim the open
    // session is a PAST one the replay just reopened. A start tapped there composes on the device
    // instead — the alternative was today's first set filed into yesterday's workout, which the
    // claim then closed at the shelf's stale instant, evaporating the live one.
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

    // While the live session is unclaimed its lanes are parked, not walked: every send would 404
    // against a session the log has never heard of, and the four-second retry would re-arm
    // forever over a healthy connection. The claim is their road; the strip says where they are.
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

    // The nobody pass answers "what did I do last time" off the shelf; a signed-in connect must
    // REPLACE that answer, never inherit it. The cache dies with the seat and the movement in
    // hand is re-asked, so the log's history stands where the shelf's "first time" was.
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

    // Process death between finishOnDevice's shelf hold and the queue's forget leaves one workout
    // both finished on the shelf and live in the queue. The relaunch converges on the shelf's
    // copy — listed once, never resumed — and converging costs no set: the queue's merge in.
    @Test
    fun testACrashBetweenShelfHoldAndQueueForgetConvergesOnRelaunch() = runTest {
        val crashed = SetQueue(queueFile) { clockMs }
        val live = Session(id = "ses_1", startedAtMs = 1_000)
        crashed.hold(live)
        crashed.store(TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 100.0,
            reps = 5, completedAtMs = 1_100), "ses_1", needsPush = true)
        crashed.flush()
        LocalLog(localFile).hold(LocalLog.FinishedSession(
            live.copy(finishedAtMs = 2_000),
            listOf(TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 100.0,
                reps = 5, completedAtMs = 1_100))))

        val store = makeStore(sync = null)
        store.connect(account(signedIn = false))

        assertNull("the finish already happened — the workout is not resumed", store.session)
        assertEquals("listed once, not twice", listOf("ses_1"), store.recent.map { it.id })
        assertTrue("the queue let go", SetQueue(queueFile).pending.isEmpty())
        assertEquals("and the shelf holds every set exactly once",
            listOf("set_a"), LocalLog(localFile).details().single().sets.map { it.id })
        assertEquals("under the finish that actually happened",
            2_000L, LocalLog(localFile).details().single().session.finishedAtMs)
    }

    // THE FOOT OF THE LOG IS PAGING ARITHMETIC AND NOTHING ELSE. A full page means there may be
    // more; a short one is the bottom, and the bottom is a real arrival rather than a box that
    // stopped offering. The cursor is the oldest row the LOG sent — never one off the shelf, which
    // the log has never heard of.
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

    // A RE-READ MAY NOT UNDO A WALK. The delivery cadence re-reads the log on a TIMER — nobody taps
    // anything — the moment a claim it owed comes good, and the lifter is not somewhere else while
    // that fires: they are on the log, ten rows into a page they asked for. So the head is
    // refreshed, the claimed session lands in it, the pages underneath stay, and the foot is still
    // the bottom they walked to.
    @Test
    fun testTheCadencesReReadKeepsThePagesTheLifterWalked() = runTest {
        val server = FakeTraining()
        repeat(60) { index ->
            server.open(Session(id = "ses_$index", startedAtMs = 1_000L + index,
                finishedAtMs = 2_000L + index))
        }
        // A session on the shelf the log will not take yet, so the boot claim stops RETRYABLY and
        // arms the cadence. Reads are healthy throughout — this is a claim that failed, not a phone
        // that is offline.
        LocalLog(localFile).hold(LocalLog.FinishedSession(
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

    // Signed out the shelf IS the whole log, so the foot is already at the bottom — there is no
    // page behind it to ask for, and a `Load older` over a device's own history would be a request
    // nobody could answer.
    @Test
    fun testSignedOutTheShelfIsTheWholeLogAndThereIsNothingOlder() = runTest {
        LocalLog(localFile).hold(LocalLog.FinishedSession(
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

    // §G18, AND THE BRANCH THAT DECIDES WHETHER A SET IS LOST. A session the SHELF holds has never
    // been sent, so the correction rewrites the row that will be sent and no PATCH may go out for an
    // id the log has never seen. The head follows: the tonnage and the top set move with the set.
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

    // THE HEADLINE OF THE WHOLE WAVE, end to end through the room: a lifter logs signed out, fixes a
    // typo and deletes a set they never did, then signs in. The CORRECTED set replays — never the
    // original, and never both — and the deleted one never goes out at all.
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
            LocalLog(localFile).finished.isEmpty())
    }

    // ...AND THE SAME CORRECTION MADE WHILE THE CLAIM IS ALREADY WALKING, through the whole room.
    // The shelf's rows go on screen before the claim starts and stay there for the length of it, so
    // this is one tap during one round trip — not an exotic race. The store takes the shelf road
    // (the row is still there) and answers Corrected; the claim has to end with the account holding
    // that same number, or the store told the lifter a repair landed that nothing kept.
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
            LocalLog(localFile).finished.isEmpty())
    }

    // ...and a session the ACCOUNT holds goes over the wire. THE LOG MOVES AND THE ROUTINE DOES
    // NOT: the frozen plan on the session and the routine document are compared whole afterwards,
    // because that is the caption of the entire screen.
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

    // A SESSION BELOW THE HEAD PAGE IS EXACTLY AS LIKELY TO HOLD THE TYPO. The row is re-read BY ID
    // after a correction rather than by re-reading the head: `loadLog` fetches the newest page and
    // keeps every walked row verbatim — deliberately, so a re-read on the delivery timer cannot
    // throw a thumb halfway down the log back to the top — which means a row the lifter walked down
    // to would have gone on printing its pre-fix tonnage, working count and gold dot forever.
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

    // The two terminal refusals, told apart BY CODE and never by the sentence. `set-not-found` is
    // the row being gone — the screen drops it rather than offering a retry onto nothing — and
    // `fix-unreadable` leaves the row standing with the log's own words beside it.
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

    // Signed out, a session the shelf does not hold is the account's. The sentence says so rather
    // than blaming a signal nobody used — and no write is attempted at all.
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

    // THE DELETE IS NOT TOLD UNTIL THE WINDOW CLOSES. The log has no undelete, so a delete already
    // on the wire could only be apologised for — the row comes off the screen, the offer to take it
    // back stands for the same nine seconds the logger's does, and only then does anything go out.
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

        store.withhold("ses_1", taken)
        assertEquals(Withheld("ses_1", taken, untilMs = clockMs + SetQueue.undoWindowMs), store.withheld)
        assertTrue("nothing has been told yet", server.removed.isEmpty())

        assertTrue(store.keepWithheld())
        assertNull(store.withheld)
        assertNull("undo sends nothing at all — it is this device changing its mind",
            store.settleWithheld())
        assertTrue(server.removed.isEmpty())
        assertEquals(2, server.sets.getValue("ses_1").size)

        store.withhold("ses_1", taken)
        assertNull(store.settleWithheld())
        assertEquals(listOf("ses_1" to taken.id), server.removed)
        assertEquals("the set does not stand", listOf(90.0),
            server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals("and the screen that read the session before it went knows not to draw it",
            setOf(taken.id), store.deletedSets)
        assertEquals("the head re-read — the row lost a set, its tonnage and its top set",
            listOf(270.0), store.logged.map { it.tonnageKg })
    }

    // ONE SLOT, AND A SECOND DELETE SETTLES THE FIRST. Overwriting the slot would make a
    // destructive gesture do nothing at all — the first set told to nobody, and its row walking
    // back onto the screen underneath the second one's Undo. It is the logger's own rule: the queue
    // holds every set inside its window and only the LAST one can be taken back.
    @Test
    fun testASecondDeleteInsideTheWindowSendsTheFirstRatherThanDroppingIt() = runTest {
        val server = FakeTraining()
        val store = liveStore(server, undoWindowMs = SetQueue.undoWindowMs)
        store.logSet(weightKg = 82.5, reps = 5)
        store.logSet(weightKg = 60.0, reps = 12)
        clockMs += 60_000
        store.flushPendingSets(force = true)
        store.finish()
        val first = server.sets.getValue("ses_1").first()
        val second = server.sets.getValue("ses_1").last()

        assertNull(store.withhold("ses_1", first))
        assertTrue("nothing is told while it is the one holding the window", server.removed.isEmpty())
        assertNull(store.withhold("ses_1", second))

        assertEquals("the first went out the moment the second took the slot",
            listOf("ses_1" to first.id), server.removed)
        assertEquals("and the screen that read the session knows not to draw it either",
            setOf(first.id), store.deletedSets)
        assertEquals(second, store.withheld?.set)

        assertTrue("the second is still the lifter's to take back", store.keepWithheld())
        assertEquals("so exactly one set is gone — the one whose window ran out",
            listOf(second.id), server.sets.getValue("ses_1").map { it.id })
    }

    // A delete the log could not take must not be drawn as one that happened, and the row comes
    // back: the store answers with what went wrong rather than with a bool nobody can act on.
    @Test
    fun testADeleteTheLogCouldNotTakeIsSaidAndTheRowStands() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()
        val taken = server.sets.getValue("ses_1").single()

        server.refuseDelete = storageFailure
        store.withhold("ses_1", taken)

        assertEquals(WriteFailure.Refused("internal error"), store.settleWithheld())
        assertEquals(emptySet<String>(), store.deletedSets)
        assertEquals(listOf(taken.id), server.sets.getValue("ses_1").map { it.id })
    }

    // A withheld delete goes with the seat, and it goes UNSENT: the row it was aimed at belongs to
    // the account that is leaving, and settling it after the change would take a set off the log of
    // the account that just arrived.
    @Test
    fun testAWithheldDeleteIsDroppedRatherThanSentAtSomebodyElsesLog() = runTest {
        val server = FakeTraining()
        val store = liveStore(server)
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.finish()
        store.withhold("ses_1", server.sets.getValue("ses_1").single())

        store.connect(account(signedIn = true, id = "u2"))

        assertNull(store.withheld)
        assertNull(store.settleWithheld())
        assertTrue("the set survives, which is the direction this one may fail in",
            server.removed.isEmpty())
    }

    // A read that never came back is not an empty log. The rows already in hand stay — they are
    // real sessions — and the foot is where the failure is SAID, with the one move that answers it:
    // the retry re-asks the same question, from the top when nothing landed at all.
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

    // KILOGRAMS ARE THE ONLY THING STORED, AND THIS IS THE PROOF. The unit is a display transform at
    // the very edge; it reaches no write. An account reading in pounds logs the same 82.5 the wire
    // has always carried, the queue holds the same number, and the string `lb` appears nowhere
    // except in the settings document itself.
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

        // ...and switching back rewrites no history: the row on the log is the row it always was.
        assertNull(store.savePreferences(GymPreferences(units = Units.Kilograms)))
        assertEquals(listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
    }

    // A room set up before signing in is the lifter's, and the sign-in claims it exactly as it
    // claims their movements, routines and sessions. A lifter who set their rest on the bus must not
    // lose it at the door.
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

    // And the other direction: an account that already has settings hands them to a phone that has
    // never opened the screen — rather than that phone's untouched defaults overwriting them.
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

    // A setting the log could not take is not a lost setting — the device is holding it and the
    // claim carries it — but a room that said nothing would leave the lifter believing the account
    // had it.
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

    // A SETTING THAT WILL NOT LAND RETRIES BY ITSELF, and this is the shape of that retry. It is
    // carried on the same four-second cadence the owed sets ride — so it does not wait for the next
    // connect — but the pass it schedules sends the DOCUMENT and nothing else. A room that folded
    // this into `claimOwed` re-walked the whole claim every four seconds forever, re-sending a live
    // start the log had already refused and starving the log re-read behind it, on an idle screen
    // with an empty queue. A 404 is what a server that has not deployed this route answers, and it
    // is retryable, so this is not a hypothetical shape.
    @Test
    fun testAnOwedSettingRetriesAloneRatherThanReWalkingTheClaim() = runTest {
        // The phone's own workout, made signed out, against an account that already has one open:
        // the claim's live start WAITS for that workout to close, and a wait is event-driven — it
        // is one of the two stops that must never be polled.
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

        // ...and it stops the moment the log takes it: no set was ever owed, so nothing stays armed.
        server.refusePreferences = null
        advanceTimeBy(4_100)
        runCurrent()
        assertEquals(90, server.settings?.restSeconds)
        server.calls.clear()
        advanceTimeBy(60_000)
        runCurrent()
        assertTrue("the cadence is not a heartbeat", server.calls.isEmpty())
    }

    // THE ONE THING A FIRST SESSION HAS TO GET RIGHT, AND IT IS NOT A SCREEN. A lifter arrives with
    // no account, no network and nothing on the phone, taps "Just start logging" (R6 retired the
    // auto-start: every session begins with a tap now), logs four sets, and the process dies — the
    // app swiped away, the activity destroyed, the phone out of battery. Every one of those sets
    // has to still be there, and so does the session they belong to and the order they were walked
    // in.
    //
    // The risk the design names is a first-session flow that starts through a path the local shelf
    // does not know about. This drives the real one: the tap's start is the queue's own.
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
            4, SetQueue(queueFile).sets(arriving.session!!.id).size)

        // The process dies here. Nothing was flushed on the way out, nobody signed in, and no
        // network was ever reachable.
        val reopened = makeStore(sync = null)
        reopened.connect(account(signedIn = false))

        assertEquals(arriving.session?.id, reopened.session?.id)
        assertEquals(listOf(100.0, 100.0, 102.5, 80.0), reopened.sets.map { it.weightKg })
        assertEquals(listOf(5, 5, 5, 8), reopened.sets.map { it.reps })
        assertEquals(listOf("back-squat", "bench-press"), reopened.order)
        assertEquals("it stands where the last set went, not in the picker over a session of sets",
            "bench-press", reopened.exerciseId)
    }

    // WHAT A FIRST SESSION IS: a room whose reads CAME BACK, and came back empty. Nothing on this
    // device remembers a lifter, counts an arrival or counts a decline — but "this lifter has no
    // log" is a claim, and an empty list is only a claim once something answered with it. An empty
    // page is not an empty history; a page that said "there is no more" is. It is what pins the six
    // over the picker and the first-session wording — the §J22 auto-start that used to read the
    // same fact on arrival is retired (R6).
    @Test
    fun testAFirstSessionIsALogThatAnsweredAndAnsweredEmpty() = runTest {
        val fresh = makeStore(sync = null)
        fresh.connect(account(signedIn = false))
        assertTrue("signed out the shelf IS the log, and it is already in hand", fresh.firstSession)

        // A brand new account is a first session too, and for the same reason: every read landed.
        val opened = makeStore(sync = FakeTraining())
        opened.connect(account(signedIn = true))
        assertTrue("nothing on the log, and the log said so", opened.firstSession)

        // A READ THAT MISSED IS NOT AN EMPTY HISTORY. This is the returning lifter on a phone with
        // no signal, and a room that treated them as brand new would pin the six over a catalog of
        // sixty-four it merely could not see.
        val offline = FakeTraining()
        offline.online = false
        val unreachable = makeStore(sync = offline)
        unreachable.connect(account(signedIn = true))
        assertFalse("the log page never answered", unreachable.firstSession)

        // The same fact through the other read: the sessions page can answer while the routines page
        // does not, and a routine list that never arrived is not a lifter who has written none.
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

    // §A2'S TWO GESTURES, and the promise under both: nothing a lifter logged leaves on either. A
    // drag moves the walk order and only the walk order, and a swipe is refused outright on a
    // movement with a set in it — the row would be somebody's own work going off the log on a flick
    // made at arm's length.
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
            listOf("romanian-deadlift", "back-squat", "bench-press"), SetQueue(queueFile).order)

        assertFalse("a movement holding a set does not leave on a swipe", store.drop("back-squat"))
        assertEquals(listOf("romanian-deadlift", "back-squat", "bench-press"), store.order)

        assertTrue(store.drop("romanian-deadlift"))
        assertEquals(listOf("back-squat", "bench-press"), store.order)
        assertNull("the movement in hand left the session, so the picker comes back up",
            store.exerciseId)
        assertEquals("and nothing logged went with it",
            listOf(100.0, 80.0), store.sets.map { it.weightKg })
        assertEquals(listOf("back-squat", "bench-press"), SetQueue(queueFile).order)
    }

    // THE PICKER'S META, and the absence it is built on. A movement the lifter has never trained
    // has NO row — there is no zero to tell apart from a real one — and the shelf is merged into
    // the log's answer rather than losing to it, because drawing `never logged` over a lift this
    // same phone recorded yesterday would be the product lying about the log it is standing on.
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

        // Signed in with a claim that cannot land: the account's own rows arrive, and the session
        // still on this device's shelf is later than the log's line for the same movement.
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

        // A read that never came back leaves the last answer standing: `never logged` is an
        // assertion about a lifter's history, and a phone in a basement has not earned it.
        server.online = false
        signedIn.loadLastSets()
        assertEquals(setOf("back-squat", "bench-press"), signedIn.lastSets?.keys)
    }

    // A READ THAT NEVER LANDED IS NOT A HISTORY THAT IS EMPTY, and the picker has exactly one place
    // to keep the difference: the map itself. Absent a row it says `never logged`, so a failure that
    // published an empty map — or half an answer — would say that about every movement in the
    // catalog, over a log this same phone is holding.
    @Test
    fun testAFailedMetaReadSaysNothingRatherThanNeverLogged() = runTest {
        val server = FakeTraining()
        // The claim cannot land, so the workout stays on this phone's own shelf — and it is real.
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

        // And when it does answer, the shelf's own row is merged back in rather than lost.
        server.online = true
        store.loadLastSets()
        assertEquals(80.0, store.lastSets!!.getValue("bench-press").weightKg, 0.0)
    }

    // SIGNING IN UNDER THE OPEN PICKER. The account card is ON the picker (§J22), so the one screen
    // that reads this meta is still standing when the seat changes — and its own effect does not run
    // again, because nothing about the picker moved. The seat that arrives answers for itself.
    @Test
    fun testSigningInUnderTheOpenPickerRefillsTheMetaItJustDropped() = runTest {
        val server = FakeTraining()
        // The claim cannot land, so the shelf keeps its session and its line stays this phone's.
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

        // The lifter taps `Build my routine →` and signs in without leaving the picker. Nothing
        // about the picker moves, so its own effect never runs again.
        store.connect(account(signedIn = true))

        assertEquals("the seat's own answer arrives without the lifter leaving the screen",
            setOf("back-squat", "bench-press"), store.lastSets?.keys)
    }

    // WHAT THE PICKER SAYS WHEN THE CATALOG READ MISSED. The six ride with every seat, so a failed
    // read no longer leaves an EMPTY catalog — it leaves a short one, and a lifter shown six rows
    // out of their sixty-four with nothing said about the rest is the app quietly losing their
    // catalog. A copy this device already held is not that: it is the catalog, one read behind.
    @Test
    fun testAMissedCatalogReadIsSaidOnlyWhenTheSixAreAllThatIsLeft() = runTest {
        val server = FakeTraining()
        server.online = false
        val bare = makeStore(sync = server)
        bare.connect(account(signedIn = true))
        assertEquals("the six and nothing else", TheSix.movements.map { it.id },
            bare.catalog.map { it.id })
        assertTrue(bare.catalogUnread)

        // The read lands, and the sentence goes with it.
        server.online = true
        server.catalog = listOf(Exercise(id = "back-squat", name = "Back Squat"),
                                Exercise(id = "hip-thrust", name = "Hip Thrust"))
        val holding = makeStore(sync = server)
        holding.connect(account(signedIn = true))
        assertFalse(holding.catalogUnread)

        // And a device that already holds this seat's catalog says nothing either: the rows on
        // screen are the lifter's own, one read behind.
        server.online = false
        val offline = makeStore(sync = server)
        offline.connect(account(signedIn = true))
        assertEquals(listOf("back-squat", "hip-thrust", "bench-press", "deadlift", "overhead-press",
                            "barbell-row", "chin-up"),
            offline.catalog.map { it.id })
        assertFalse("a held copy is the catalog, not a gap in it", offline.catalogUnread)
    }
    // ── THE AGENT PROPOSES ────────────────────────────────────────────────────────────────────
    //
    // What has to be true for a program not to move under its owner: nothing an agent sends changes
    // a routine, the tap is the only thing that does, and a routine that moved first refuses the tap
    // rather than applying over the top. These are the paths that lose a program.

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

    // THE CARD ARRIVES WITH THE ROUTINES AND NOTHING ELSE FETCHES IT — no poll, no push, no badge.
    // A boot read is the whole of what puts a proposal in front of a lifter.
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

    // SIGNED OUT THERE IS NOTHING, and nothing is asked for either: a proposal needs an account for
    // an agent to have been granted anything against, so the shelf holds none, no read is made, and
    // every verb answers about the ACCOUNT rather than about a signal nobody used.
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

        // A routine the shelf holds has no history and that is an ANSWER: this device does not
        // record the evening a local routine was typed, so the section is simply absent rather than
        // a refusal about an account nobody is being asked for.
        assertEquals(GymResult.Ok(emptyList<RoutineEvent>()), store.routineHistory(store.routines.single().id))
        assertEquals(ProposalOutcome.Failed(WriteFailure.Refused("a proposal needs your account — sign in first")),
            store.applyProposal("prop_1"))
        assertTrue("still nothing on the wire", server.calls.isEmpty())
    }

    // THE TAP IS THE ONLY THING THAT MOVES A PROGRAM. Until it happens the routine reads exactly as
    // it did — and afterwards it is the log's own document that lands, revision and all, with the
    // card gone because the thing it was waiting for happened.
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

    // AND THE OTHER SURFACE'S DECISION MOVES THE PROGRAM HERE TOO. An apply on the web settles the
    // proposal AND rewrites the routine, and nothing tells this phone: its one routines read
    // happened at connect. So the refusal is where this room learns, and it re-reads rather than
    // leaving a card standing on Today over a Tuesday that no longer says what it says.
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

    // A ROUTINE THAT MOVED FIRST IS NEVER APPLIED OVER THE TOP. The mid-session save is a whole-
    // document PUT — the exact write this base version exists to defend against — so the diff
    // written before it is superseded, the tap is refused, and the room redraws the routine AS IT
    // NOW STANDS rather than as the diff assumed.
    @Test
    fun testAMidSessionSaveSupersedesTheDiffAndTheTapIsRefused() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal(baseRevision = 1))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        // The lifter's own hand, mid-workout: 87.5 goes to Push A from the change offer — through
        // the store's own door, because the PUT is the write this whole token exists to defend a
        // diff against and a test that moved the revision by hand would prove nothing about it.
        assertNull(store.save(87.5, toRoutine = "rt_1", forExercise = "bench-press"))
        assertEquals("the log moved the revision under the diff", 2,
            server.written.getValue("rt_1").revision)
        assertEquals("and this room is holding the log's own answer, not its send", 2,
            store.routine("rt_1")?.revision)

        val refused = store.applyProposal("prop_1")

        assertEquals(ProposalOutcome.Moved("the routine moved after this was written — nothing was applied"),
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

    // AND THE SCREEN KNOWS BEFORE IT ASKS. A base the room is already holding past is superseded on
    // the spot, so the diff offers no Apply it knows would be refused — while a routine this phone
    // is merely BEHIND is not superseded at all, because a stale read is not a moved program.
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

    // DISMISS TAKES THE CARD AND LEAVES THE PROGRAM ALONE — no reason asked for, no routine sent
    // back, and the proposal keeps its dated row so the routine's history can still show it.
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

    // THE OTHER DECISION, ALREADY TAKEN — from the web, or from this phone before a reply was lost.
    // It is terminal and it is not a loss: the answer is fixed, and the screen re-reads rather than
    // sending the tap again.
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
        // The SAME decision replays instead — a lost reply is always safe to send again.
        assertTrue(store.dismissProposal("prop_1") is ProposalOutcome.Decided)
    }

    // AN APPLIED REMOVAL TAKES THE ROUTINE WITH IT, and the log sends no routine back because there
    // is none — the absence is the removal having happened. Every set logged against it stays in
    // the log: a proposal never touches one.
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

    // AND A REMOVAL TAPPED TWICE — the first reply lost, the second answered "no such proposal"
    // because the routine took its whole ledger with it. That 404 is the removal having HAPPENED,
    // and what the room does about it is re-read the program rather than keep drawing a routine the
    // log no longer holds.
    @Test
    fun testARemovalTappedTwiceLeavesTheProgramTellingTheTruth() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal(intent = ProposalIntent.Remove))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        // The log applies it and the reply never arrives, so this room is still holding the routine.
        server.applyProposal("prop_1")
        assertEquals("rt_1", store.routine("rt_1")?.id)

        val again = store.applyProposal("prop_1")

        assertEquals(ProposalOutcome.Gone("that proposal is no longer on the log"), again)
        assertNull("the program was re-read rather than guessed at", store.routine("rt_1"))
    }

    // A LOG THAT WENT QUIET IS NOT A DECISION. The proposal is still sitting on its routine, the
    // card stays, and the tap is worth making again — the one refusal here that is not terminal.
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

    // A DECISION ON A PROPOSAL THAT IS NOT THERE — another account's, or one this phone read before
    // the routine it belonged to was removed. Absent and forbidden are one answer, and there is
    // nothing left to draw.
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

    // A NEWER PROPOSAL STANDING IN THE SLOT IS NOT HIDDEN BY THE OLD ONE BEING DECIDED. The log
    // supersedes the old and puts the new one on the routine; a room that blanked the field on any
    // decision would take a card nobody has read off the screen.
    @Test
    fun testDecidingAnOldProposalDoesNotHideTheOneThatReplacedIt() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        server.propose(aProposal(id = "prop_old"))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        // The agent proposes again: the log supersedes the first and hangs the second on the routine.
        server.ledger["prop_old"] = server.ledger.getValue("prop_old").copy(state = ProposalState.Superseded)
        server.propose(aProposal(id = "prop_new"))
        val fresh = server.written.getValue("rt_1")
        store.connect(account(signedIn = true))
        assertEquals("prop_new", store.routine("rt_1")?.pendingProposal?.id)
        assertEquals("prop_new", fresh.pendingProposal?.id)

        // Dismissing the OLD one — from a screen opened before the new one landed — leaves the new
        // card exactly where it is.
        server.ledger["prop_old"] = server.ledger.getValue("prop_old").copy(state = ProposalState.Pending)
        store.dismissProposal("prop_old")

        assertEquals("prop_new", store.routine("rt_1")?.pendingProposal?.id)
    }

    // ASK READS THE ACCOUNT'S LOG, so signed out there is nothing to read and nobody to read it for.
    // The door is not drawn signed out either — this is the floor under a session that expired
    // mid-conversation, and it must not spend a round trip to find that out.
    @Test
    fun testAskSignedOutNeverReachesTheLogAndSaysWhy() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))

        assertEquals(AskOutcome.Refused("Ask reads your account's log — sign in first"),
            store.ask("thr_1", "what's stalled?"))
        assertFalse(server.calls.contains("ask"))
    }

    // A PROPOSAL MINTED IN A CONVERSATION IS A CARD ON TODAY, and the room must not have to be left
    // and re-entered for it to exist. This room reads the routines once, at connect; an answer that
    // mints one re-reads them, because the card IS this product's whole notification design.
    @Test
    fun testAProposalMintedInAConversationLandsOnTodayWithoutLeavingTheRoom() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        assertEquals(emptyList<Proposal>(), store.pendingProposals)

        // The agent's tool mints it during the exchange; the reply carries the id and nothing else.
        server.propose(aProposal(id = "prop_1"))
        server.answers.add(AskAnswer(answer = "Done — as a proposal on Push A.",
            read = ReadTally(sets = 214, sessions = 34, weeks = 12), proposals = listOf("prop_1")))

        val outcome = store.ask("thr_1", "write the triples block")

        assertEquals(AskOutcome.Answered(AskAnswer(answer = "Done — as a proposal on Push A.",
            read = ReadTally(sets = 214, sessions = 34, weeks = 12), proposals = listOf("prop_1"))),
            outcome)
        assertEquals(listOf("prop_1"), store.pendingProposals.map { it.id })
    }

    // The receipt is drawn from the reply and NEVER composed here: a count this room could arrive at
    // on its own is a count the model could have invented. The store hands over exactly what the
    // server served.
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

    // The three shapes the screen acts on differently, and the one that must never be dressed as a
    // failure: a ceiling is an answer, a quiet log is worth another tap, and a deployment with no
    // Ask at all takes the door down.
    @Test
    fun testACeilingIsAnAnswerAQuietLogIsARetryAndAnAbsentRouteTakesTheDoorDown() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        server.refuseAsk = refusal(429, code = "ask-daily-limit", message = "that's Ask for now")
        assertEquals(AskOutcome.Refused("that's Ask for now"), store.ask("thr_1", "what's stalled?"))

        server.refuseAsk = storageFailure
        assertEquals(AskOutcome.Failed("internal error"), store.ask("thr_1", "what's stalled?"))

        server.refuseAsk = refusal(404, message = "not found")
        assertEquals(AskOutcome.Absent, store.ask("thr_1", "what's stalled?"))

        // §O'S FIFTH ANSWER: eight turns is a full conversation, so the question is fine and the
        // THREAD is over — the room lets go of the id and the next ask opens a new one.
        server.refuseAsk = refusal(409, code = "ask-thread-full", message = "that conversation is full")
        assertEquals(AskOutcome.Fresh("that conversation is full"), store.ask("thr_1", "what's stalled?"))
    }

    // §O — THE PAST IS READ AND NEVER HELD. A conversation's outcome is DERIVED by the server from
    // the proposals it minted, so it moves the moment anybody applies or dismisses one: a list this
    // store cached between visits would draw `waiting` under a diff the lifter decided this morning.
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

        val listed = store.threads()

        assertEquals(listOf("thr_2", "thr_1"), (listed as GymResult.Ok).value.map { it.id })
        assertEquals("no turns on the list read", listOf(0, 0), listed.value.map { it.turns.size })
        assertEquals("4 changes → Push A", listed.value[1].outcome.detail)

        // Read again, and the log is asked again: nothing about a past is held between visits.
        store.threads()
        assertEquals(2, server.calls.count { it == "threads" })
    }

    // ONE CONVERSATION, WHOLE — the turns as they were sent. And absent is a SENTENCE rather than a
    // null the caller has to invent a reason for: another account's thread, a deleted one and one
    // that never existed are one answer, because three a stranger could tell apart would say whether
    // a conversation exists on somebody else's log.
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

    // §O'S RULE, PROVED RATHER THAN ASSUMED: DELETING A THREAD DELETES THE CONVERSATION AND NOT THE
    // CONSEQUENCE. The proposal it minted was applied, and after the delete the routine's history
    // still carries that dated row — because an applied change is a fact about the program rather
    // than a message. What goes with the conversation is the DOOR onto it, and nothing else.
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
        // AND THE DOOR ONTO THE CONVERSATION IS WHAT WENT — `on delete set null` in the schema, so
        // the row draws no `Ask ›` at all rather than one that opens a refusal. This is the half a
        // fake that merely forgot the conversation would have got wrong.
        assertEquals("the door onto the conversation is gone with it", null, row.source.conversation)
        assertEquals("and the conversation it opened is gone",
            GymResult.Failed(WriteFailure.Refused("that conversation is no longer on the log")),
            store.thread("thr_1"))
        assertEquals("the program did not move on the delete", 2, store.routine("rt_1")?.revision)
    }

    // A DELETE OF SOMETHING ALREADY GONE IS A DELETE THAT HAPPENED: the screen asked for a
    // conversation not to be there, and it is not there. Every other refusal is said out loud and
    // the row stays — a screen that crossed it out on the strength of its own tap would tell a
    // lifter their past was deleted on a request that never landed.
    @Test
    fun testDeletingAConversationThatIsAlreadyGoneSucceedsAndAnythingElseIsSaid() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        assertEquals(GymResult.Ok(Unit), store.deleteThread("thr_gone"))

        server.refuseThreads = storageFailure
        assertEquals(GymResult.Failed(WriteFailure(storageFailure)), store.deleteThread("thr_1"))
    }

    // THE PAST IS THE ACCOUNT'S. Signed out there is nothing to read, nothing to delete and nobody
    // to do it for — and no round trip is spent finding that out, because the door is not drawn
    // signed out either.
    @Test
    fun testTheThreadDoorsNeverReachTheLogSignedOut() = runTest {
        val server = FakeTraining()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = false))
        val signIn = WriteFailure.Refused("Ask reads your account's log — sign in first")

        assertEquals(GymResult.Failed(signIn), store.threads())
        assertEquals(GymResult.Failed(signIn), store.thread("thr_1"))
        assertEquals(GymResult.Failed(signIn), store.deleteThread("thr_1"))
        assertTrue(server.calls.none { it in listOf("threads", "thread", "deleteThread") })
    }

    // §M'S SAVE, and the rule the whole wave turns on: a day built at the kitchen table is savable
    // while incomplete, and an open row travels as an ABSENCE the whole way — draft, wire, stored
    // routine — because a zero would be a target of nothing and a prefill would be a guess.
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

    // A day with no name and a day with no movements are both refused BEFORE a round trip that
    // could only repeat the refusal — and each says which of the two it is.
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

    // SIGNED OUT IT LANDS ON THE SHELF, exactly as "Keep this as a routine" does, and the claim
    // carries it later — what the lifter typed tonight is what the account receives.
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

    // A ROUTINE THAT ALREADY STANDS IS WRITTEN WHOLE — the edit and the rename are one write, and it
    // MOVES THE REVISION and supersedes what an agent proposed against the old document. That is
    // what a rename is supposed to do, not something to work around: the day the diff was written
    // about really did change.
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

    // The routine's own dated history — how the day came to exist, and every proposal made about it
    // since — off ONE read. Nothing polls a second route, so nothing can disagree with the document
    // the screen is holding.
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

    // A HISTORY THAT COULD NOT BE READ IS NOT AN EMPTY ONE. A routine with four decisions on it must
    // never read as one nobody has ever touched, which is the false claim this room refuses to make
    // about a log.
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

    // §M'S DELETE, THE SHELF'S SIDE: a routine the device still holds leaves through the shelf's
    // own door — no wire — and the sessions run under it keep every set and their frozen plan,
    // dropping only the dead id, so the claim replays them ad-hoc rather than naming a routine the
    // log must refuse.
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
        assertEquals("the shelf let go of the document", emptyList<Routine>(), LocalLog(localFile).routines)
        val past = LocalLog(localFile).finished.single()
        assertEquals("the session run under it keeps every set", listOf(100.0), past.sets.map { it.weightKg })
        assertNull("only the dead id goes — the claim replays this session ad-hoc", past.session.routineId)
        assertEquals("the frozen plan is a copy, not a reference, and it stays",
            "Push Day", past.session.plan?.routine)

        assertEquals("a routine the shelf never held is the account's, and the sentence says so",
            WriteFailure.Refused("that routine is on your account — sign in to change it"),
            store.dropRoutine("rt_account"))
    }

    // §M'S DELETE, THE ACCOUNT'S SIDE: the routine leaves only once the log says it is gone. A log
    // that answered with a reason repeats the reason, an unreachable one says nobody answered, and
    // in both cases the program stands exactly as it stood — a delete drawn as done on the strength
    // of a request that never landed would be the room lying about somebody's program.
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

    // A DELETE OF SOMETHING ALREADY GONE IS A DELETE THAT HAPPENED: the caller asked for the
    // routine not to be there, and it is not there. The 404 answers as success and the list lets
    // go — repeating "no such routine" over a delete would refuse the lifter the thing they asked
    // for on the grounds that they already have it.
    @Test
    fun testADeleteOfARoutineAlreadyGoneAnswersAsSuccess() = runTest {
        val server = FakeTraining()
        server.written["rt_1"] = aRoutine()
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))
        assertEquals(listOf("rt_1"), store.routines.map { it.id })

        // Deleted from the web after this phone's read — the wire answers 404, not silence.
        server.written.remove("rt_1")
        server.refuseRoutineDelete = refusal(404, message = "no such routine")

        assertNull("asked for it not to be there, and it is not there", store.dropRoutine("rt_1"))
        assertEquals("the list lets go without a second read", emptyList<Routine>(), store.routines)
        assertTrue("nothing to say out loud about a wish already granted", store.refusals.isEmpty())
    }

    // §N'S SECOND QUESTION, AND IT IS THE CALLER'S ANSWER. This used to file every created movement
    // as a barbell — a claim about somebody's gym made by a client that never asked.
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

    // THE ALIAS IS THE ACCOUNT'S ROW, so the sheet may only promise it where the rename lands there.
    // A movement this device minted and no claim has carried yet renames on a shelf that has no
    // alias table at all.
    @Test
    fun testTheAliasIsOnlyPromisedWhereTheRenameReachesTheAccount() = runTest {
        val anon = makeStore(sync = null)
        anon.connect(account(signedIn = false))
        val mine = (anon.create("Hammer row", "machine") as GymResult.Ok).value
        assertFalse("signed out there is no alias table to keep anything in",
            anon.renameKeepsAnAlias(mine.id))

        // Signed in with the claim unable to land that movement yet: it is still the shelf's, and it
        // still renames there.
        val server = FakeTraining()
        server.catalog = listOf(Exercise(id = "bench-press", name = "Bench Press"))
        server.refuseCreate = storageFailure
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        assertTrue("a catalog movement renames on the log", store.renameKeepsAnAlias("bench-press"))
        assertFalse("one the claim has not carried yet does not", store.renameKeepsAnAlias(mine.id))
    }

    // `untested` IS DERIVED ON THE SHELF TOO. It used to say `never trained` over a routine this
    // same phone had recorded a session under — the aggregate the log computes, computed nowhere.
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

        // And it is DERIVED rather than stored: discarding the only session that ever ran takes the
        // word back, which a flag written at finish could never do.
        store.discard(store.recent.single().id)
        assertTrue(store.routines.single().untested)
    }
}
