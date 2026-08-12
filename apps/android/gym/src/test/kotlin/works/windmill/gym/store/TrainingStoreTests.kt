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
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Prefill
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

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

    @Before
    fun setUp() {
        clockMs = 1_000
        queueFile = File(tmp.root, "gym-${System.nanoTime()}.json")
        catalogFile = File(tmp.root, "gym-catalog-${System.nanoTime()}.json")
        localFile = File(tmp.root, "gym-local-${System.nanoTime()}.json")
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
    ) = TrainingStore(
        queue = SetQueue(queueFile) { clockMs },
        deviceCatalog = DeviceCatalog(catalogFile),
        localLog = LocalLog(localFile),
        scope = backgroundScope,
        now = { clockMs += 1; clockMs },
        mintSession = mintSession,
        mintSet = mintSet,
        undoWindowMs = 0,
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
    ): TrainingStore {
        server.open(Session(id = "ses_1", startedAtMs = 1_000, plan = plan))
        val store = makeStore(sync = server, mintSet = mintSet, retryAfterMs = retryAfterMs)
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

    // Pressing Start cannot re-plan a workout that is already running: the session that comes back
    // is the live one, with ITS snapshot, and its sets come with it rather than being drawn over.
    @Test
    fun testStartingWhileASessionIsOpenJoinsItWithItsOwnSets() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_live", startedAtMs = 500,
            plan = PlanSnapshot(routine = "Push A",
                entries = listOf(PlanEntry(exerciseId = "bench-press", sets = 5,
                    reps = 5, weightKg = 82.5)))))
        server.sets["ses_live"] = mutableListOf(TrainingSet(id = "set_old",
            exerciseId = "bench-press", setNumber = 1, weightKg = 82.5, reps = 5,
            completedAtMs = 600))
        val store = makeStore(sync = server)
        store.connect(account(signedIn = true))

        val joined = (store.start(routineId = "rt_other") as? GymResult.Ok)?.value

        assertEquals("a start joins the open session rather than opening a second",
            "ses_live", joined?.id)
        assertEquals("and it keeps that session's own snapshot — Start cannot re-plan a running workout",
            "Push A", store.session?.plan?.routine)
        assertEquals("the sets already logged into it come with it",
            listOf("set_old"), store.sets.map { it.id })
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
        val movement = (store.create("Bench Press") as GymResult.Ok).value

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
        val movement = (store.create("Bench Pres") as GymResult.Ok).value

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
        assertEquals("Alice’s Secret Squat", herRelaunch.catalog.single().name)

        // The next seat, equally offline — so nothing can repair the names behind his back. This is
        // the state this room is built to work in, and the one the leak used to stand in forever.
        val bob = makeStore(sync = null)
        bob.connect(account(signedIn = true, id = "bob"))
        assertEquals("a slug is honest — this phone does not know Bob's names",
            emptyList<Exercise>(), bob.catalog)

        val anon = makeStore(sync = null)
        anon.connect(account(signedIn = false))
        assertEquals("and signing out is not a way back into her catalog either",
            emptyList<Exercise>(), anon.catalog)
    }

    // The anonymous seat is a seat like any other, and the movements it minted are the whole catalog
    // it has: they ride with it across a relaunch, and they ride into the account that signs in over
    // them, because a movement no claim has landed yet is still on this device to be named.
    @Test
    fun testTheShelfsOwnMovementsSurviveARelaunchAndTheSeatTheySignInto() = runTest {
        val anon = makeStore(sync = null)
        anon.connect(account(signedIn = false))
        val made = (anon.create("Sled Push") as GymResult.Ok).value

        val relaunched = makeStore(sync = null)
        relaunched.connect(account(signedIn = false))
        assertEquals(listOf(made), relaunched.catalog)

        // A seat this phone holds no copy for, standing over the same shelf: before any account read
        // answers, the logger still has a name to draw at 28sp over the lifter's own lift.
        val newSeat = makeStore(sync = null)
        newSeat.connect(account(signedIn = true, id = "alice"))
        assertEquals(listOf(made), newSeat.catalog)
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
        val why = (store.create("Zercher Squat") as? GymResult.Failed)?.why
        assertEquals("a refused create is not a movement",
            WriteFailure.Refused("that movement id is taken"), why)
        assertFalse(store.catalog.any { it.name == "Zercher Squat" })

        server.refuseCreate = null
        val made = (store.create("Zercher Squat") as? GymResult.Ok)?.value
        assertEquals("the second attempt lands", "Zercher Squat", made?.name)
        assertEquals(listOf("Zercher Squat"), store.catalog.map { it.name })
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
        assertEquals(listOf("Bench Press", "Back Squat"), store.catalog.map { it.name })

        // A cold launch with no signal: nothing is read, and the names are already there.
        val relaunched = makeStore(sync = null)
        relaunched.connect(account(signedIn = true))
        assertEquals(listOf("bench-press", "back-squat"), relaunched.catalog.map { it.id })
        assertEquals("Bench Press", Readout.movement("bench-press", relaunched.catalog))

        val signedOut = makeStore(sync = null)
        signedOut.connect(account(signedIn = false))
        assertEquals("the names read for an account are that account's, and signing out is not a way to keep reading them",
            emptyList<Exercise>(), signedOut.catalog)
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
}
