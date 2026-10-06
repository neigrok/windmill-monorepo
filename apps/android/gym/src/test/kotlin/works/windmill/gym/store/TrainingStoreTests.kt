package works.windmill.gym.store

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.AskTurn
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Prefill
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.ReadTally
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.RecordMark
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.ReviewStats
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.ThreadOutcome
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.Units
import works.windmill.gym.domain.sync.ProposeRoutine
import works.windmill.gym.net.FakeGymRest
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.sync.core.Json
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.ModelServer
import works.windmill.gym.domain.sync.Exercise as EngineExercise
import works.windmill.gym.domain.sync.Proposal as EngineProposal
import works.windmill.gym.domain.sync.Routine as EngineRoutine
import works.windmill.gym.domain.sync.RoutineEntry as EngineEntry
import works.windmill.gym.domain.sync.SetTarget as EngineTarget

private fun refusal(status: Int, code: String? = null, message: String) =
    WindmillApiException.Refused(status, Refusal(message = message, code = code))

class TrainingStoreTests {
    @get:Rule
    val tmp = TemporaryFolder()

    // A second phone signed into the same account reads what the log holds, or writes as somebody
    // elsewhere would.
    private suspend fun <T> TestScope.anotherPhone(server: ModelServer, now: Long, account: String = "alice",
                                                   act: suspend (EngineRoomFixture) -> T): T =
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { phone ->
            phone.now = now
            phone.select(account); phone.pull(server); phone.store.refreshEngine()
            act(phone).also { runCurrent() }
        }

    // Coach, answering elsewhere, writes a diff against the account's routine.
    private suspend fun TestScope.coachProposes(server: ModelServer, now: Long, routineId: String, proposalId: String,
                                                name: String = "Push A — heavy",
                                                sets: List<SetTarget> = List(5) { SetTarget(3, 87.5) },
                                                removing: Boolean = false) = anotherPhone(server, now) { coach ->
        val runner = ActionRunner(coach.engine, coach.engine.registry, FixedZone(0),
            object : ActionContext { override var insideRun = false })
        assertTrue(runner.run(ProposeRoutine(Id(proposalId, EngineProposal), Id(routineId, EngineRoutine), name,
            listOf(EngineEntry(Id("bench-press", EngineExercise), sets.map { EngineTarget(it.reps, it.weightKg) })),
            "Heavier triples.", removing)) is Outcome.Committed)
        coach.sync(server)
    }

    // The lifter's Push A on the account, with Coach's diff waiting on it.
    private suspend fun TestScope.pushAWaitingOnADiff(room: EngineRoomFixture, server: ModelServer,
                                                      name: String = "Push A — heavy", removing: Boolean = false,
                                                      proposalId: String = "proposal1"): Routine {
        room.select("alice"); room.pull(server)
        val pushA = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
            .targeting("bench-press", List(5) { SetTarget(5, 82.5) })) as GymResult.Ok).value
        room.sync(server)
        coachProposes(server, room.now, pushA.id, proposalId, name, removing = removing)
        room.pull(server); room.store.refreshEngine()
        return room.store.routine(pushA.id)!!
    }

    // A decision waits for the log's receipt, so the phone syncs while the tap is held open.
    private suspend fun TestScope.deciding(room: EngineRoomFixture, server: ModelServer,
                                           decide: suspend () -> ProposalOutcome): ProposalOutcome {
        val decision = async { decide() }
        runCurrent()
        if (!decision.isCompleted) {
            room.now += 1_000; room.sync(server); advanceTimeBy(25); runCurrent()
        }
        if (!decision.isCompleted) {
            noticed(room); advanceTimeBy(25); runCurrent()
        }
        return decision.await()
    }

    // What this phone still owes the log, one line per intent: a command by name, a record by type and id.
    private fun owed(room: EngineRoomFixture): List<String> = room.outbox().map { entry ->
        val intent = entry.member("intent")
        intent["cmd"]?.member("name")?.str()
            ?: intent.member("d").arr().joinToString { "${it.member("t").str()} ${it.member("id").str()}" }
    }

    // A refusal reaches the notices off the engine's own thread.
    private suspend fun noticed(room: EngineRoomFixture) =
        withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.notices("gym").notices.first { it.isNotEmpty() } } }

    @Test
    fun testASetLoggedOfflineSurvivesARelaunchAndFlushesOnReconnect() = runTest {
        val folder = tmp.newFolder()
        val server = EngineRoomFixture.server()
        val snapshot: Json
        val clock: Long
        val opened: Session
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            opened = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            assertTrue(room.training.reportDelivery(room.engine.activeReplica(), Reply.Unreachable))
            room.store.refreshEngine()

            assertEquals(SaveState.Blocked(Blocker.Offline), room.store.saveState)
            assertEquals("offline · saved here", room.store.saveState.line)
            assertEquals("the row is on screen — the device is holding it",
                listOf(82.5), room.store.sets.map { it.weightKg })
            assertEquals(listOf("gym.start", "set ${room.store.sets.single().id}"), owed(room))
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start(); relaunched.selected = "alice"
            relaunched.store.connect(relaunched.account())
            relaunched.sync(server); relaunched.store.refreshEngine()

            assertEquals(listOf(82.5), anotherPhone(server, relaunched.now) { phone ->
                phone.training.session(opened.id)!!.sets.map { it.weightKg } })
            assertEquals("the log numbered it, so it is the log's now",
                listOf(1), relaunched.store.sets.map { it.setNumber })
            assertTrue(relaunched.outbox().isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testASetRefusedByAClosedSessionIsDroppedAndSaidOutLoud() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            (room.store.start() as GymResult.Ok).value
            room.sync(server)
            anotherPhone(server, room.now) { phone ->
                assertTrue(phone.store.finish() is FinishOutcome.Closed)
                phone.sync(server)
            }

            room.store.choose("bench-press")
            room.store.logSet(weightKg = 60.0, reps = 10)
            val lost = room.store.sets.single()
            room.sync(server); noticed(room); room.store.refreshEngine()

            assertTrue("a set that never landed is not drawn as though it had", room.store.sets.isEmpty())
            assertEquals(listOf<RefusedWrite>(RefusedSet(lost.id, "bench-press", 60.0, 10, "That workout has finished.")),
                room.store.refusals)
            assertEquals("That workout has finished.", room.store.saveState.line)
            assertTrue(room.outbox().isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testFinishingSendsWhatIsOwedBeforeItClosesTheSession() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press")
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Unreachable)
            room.store.logSet(weightKg = 100.0, reps = 5)
            room.store.logSet(weightKg = 100.0, reps = 5)
            val logged = room.store.sets.map { it.id }

            val outcome = room.store.finish()
            runCurrent()

            val closed = (outcome as? FinishOutcome.Closed)?.session
            assertNotNull("the session did not close: $outcome", closed)
            assertFalse(closed!!.isOpen)
            assertNull("the room has nothing running once the workout closed", room.store.session)
            assertEquals("every set of this session is ahead of its finish in what the phone owes",
                listOf("gym.start") + logged.map { "set $it" } + "gym.finish", owed(room))

            room.sync(server)
            anotherPhone(server, room.now) { phone ->
                val held = phone.training.session(opened.id)!!
                assertEquals(listOf(100.0, 100.0), held.sets.map { it.weightKg })
                assertFalse(held.session.isOpen)
            }
            runCurrent()
        }
    }

    @Test
    fun testAStorageFailureKeepsTheSetQueuedRatherThanRefusingIt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            room.store.start(); room.store.choose("bench-press")
            room.store.logSet(weightKg = 90.0, reps = 5)

            assertTrue(room.training.reportDelivery(room.engine.activeReplica(),
                Reply.Failed(SyncResponse(500, Json.objectOf()))))
            room.store.refreshEngine()

            assertEquals(listOf("gym.start", "set ${room.store.sets.single().id}"), owed(room))
            assertTrue("the server failing is not the set being refused", room.store.refusals.isEmpty())
            assertEquals("and a log that answered 500 is not a missing signal — the note names the log",
                SaveState.Blocked(Blocker.LogFailed), room.store.saveState)
            assertEquals("the log didn’t answer · saved here", room.store.saveState.line)
            assertEquals(Blocker.LogFailed, room.store.strandedBy)
            assertEquals("the row stays on screen — the device is holding it", 1, room.store.sets.size)
            runCurrent()
        }
    }

    @Test
    fun testStartingWhileASessionIsOpenRefusesAndSurfacesTheOpenWorkout() = runTest {
        val server = EngineRoomFixture.server()
        val (live, logged) = anotherPhone(server, 1_800_000_000_000L) { phone ->
            // A finished workout first, so the open one never shares an id with the start this room mints.
            phone.workout()
            val pushA = (phone.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) })) as GymResult.Ok).value
            val live = (phone.store.start(pushA.id) as GymResult.Ok).value
            phone.store.choose("bench-press"); phone.store.logSet(82.5, 5)
            val start = phone.outbox().map { it.member("intent") }
                .last { it["cmd"]?.member("name")?.str() == "gym.start" }.member("cmd").member("args")
            assertEquals("every user-tapped start states the flag as an explicit false",
                Json.of(false), start.member("joinOpenSession"))
            phone.sync(server)
            live to phone.store.sets.single().id
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.now = 1_800_000_100_000L
            room.select("alice"); room.pull(server)

            val refused = room.store.start(routineId = "rt_other")

            assertTrue("a start while a workout is open is a refusal, never a silent join: $refused",
                refused is GymResult.Failed)
            assertEquals("A workout is already open. Finish it first.",
                ((refused as GymResult.Failed).why as WriteFailure.Refused).said)
            assertTrue("the refused start wrote nothing", room.outbox().isEmpty())
            assertEquals("the refresh adopted the open workout, with its own snapshot", live.id, room.store.session?.id)
            assertEquals("Push A", room.store.session?.plan?.routine)
            assertEquals("and the sets already logged into it", listOf(logged), room.store.sets.map { it.id })
            assertEquals("and stands where the last set went, not in the picker over a session of sets",
                "bench-press", room.store.exerciseId)
            runCurrent()
        }
    }

    @Test
    fun testThePrefillTakesThePlanUntilTheLifterHasLiftedSomething() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())
            val pushA = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) })) as GymResult.Ok).value
            room.store.start(pushA.id)
            room.store.choose("bench-press")

            assertEquals(Prefill(weightKg = 82.5, reps = 5), room.store.prefill)

            room.store.logSet(weightKg = 85.0, reps = 4)
            assertEquals("the sticky carry-forward follows the thumb",
                Prefill(weightKg = 85.0, reps = 4), room.store.prefill)
            runCurrent()
        }
    }

    @Test
    fun testSignedOutASessionRunsFinishesAndSurvivesARelaunch() = runTest {
        val folder = tmp.newFolder()
        val snapshot: Json
        val clock: Long
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select(null)
            assertEquals(SaveState.Idle, room.store.saveState)

            val opened = (room.store.start() as GymResult.Ok).value
            assertEquals("session01", opened.id)
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)

            assertEquals(listOf(82.5), room.store.sets.map { it.weightKg })
            assertEquals("saved on this device", room.store.saveState.line)

            room.now += 60_000
            val ended = (room.store.finish() as FinishOutcome.Closed).session
            runCurrent()
            assertFalse(ended.isOpen)
            assertNull(room.store.session)
            assertEquals(listOf("session01"), room.store.recent.map { it.id })
            assertEquals(listOf(1), room.store.recent.map { it.setCount })
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start()
            relaunched.select(null)
            assertEquals(listOf("session01"), relaunched.store.recent.map { it.id })
            assertEquals("the phone's replica is the one owner of a finished signed-out session",
                listOf(82.5), relaunched.training.details().single().sets.map { it.weightKg })
            runCurrent()
        }
    }

    @Test
    fun testSignedOutARoutineIsKeptStartedFromAndRetargeted() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)

            val performed = listOf(
                TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 100.0, reps = 5, completedAtMs = 1_100),
                TrainingSet(id = "set_b", exerciseId = "bench-press", weightKg = 100.0, reps = 5, completedAtMs = 1_200),
            )
            val kept = (room.store.keep(performed, asRoutineNamed = "Push Day") as GymResult.Ok).value
            assertTrue(kept.id.startsWith("rt_"))
            assertEquals(listOf("Push Day"), room.store.routines.map { it.name })

            val opened = (room.store.start(routineId = kept.id) as GymResult.Ok).value
            assertEquals("Push Day", opened.plan?.routine)
            room.store.choose("bench-press")
            assertEquals("the prefill dials the routine's plan", Prefill(100.0, 5), room.store.prefill)

            assertEquals("the kept routine carries every working set as it was lifted",
                listOf(SetTarget(5, 100.0), SetTarget(5, 100.0)), kept.entries.first().sets)
            assertNull(room.store.save(listOf(SetTarget(5, 105.0), SetTarget(5, 105.0)),
                toRoutine = kept.id, atPosition = 1, forExercise = "bench-press"))
            assertEquals(listOf(SetTarget(5, 105.0), SetTarget(5, 105.0)),
                room.store.routines.first { it.id == kept.id }.entries.first().sets)
            assertEquals("and the phone's replica holds the retargeted document",
                listOf(SetTarget(5, 105.0), SetTarget(5, 105.0)),
                room.training.routine(kept.id)?.entries?.first()?.sets)
            runCurrent()
        }
    }

    @Test
    fun testSignedOutLastTimeAndPrefillComeFromTheDeviceHistory() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)

            room.store.start()
            room.store.choose("bench-press")
            assertEquals("no history is a first time", true, room.store.lastTime?.isFirstTime)

            room.store.logSet(weightKg = 60.0, reps = 10, kind = SetKind.Warmup)
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.now += 60_000
            room.store.finish()
            runCurrent()

            room.store.start()
            room.store.choose("bench-press")
            assertEquals("the working set carries, the warmup does not",
                listOf(82.5), room.store.lastTime?.sets?.map { it.weightKg })
            assertEquals(Prefill(82.5, 5), room.store.prefill)
            runCurrent()
        }
    }

    @Test
    fun testSignedOutTheRecordAndTheReviewAreComputedOnThePhone() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val movement = (room.store.create("Bench Press", "barbell") as GymResult.Ok).value

            room.store.start()
            room.store.choose(movement.id)
            room.store.logSet(weightKg = 60.0, reps = 10, kind = SetKind.Warmup)
            repeat(4) { room.store.logSet(weightKg = 82.5, reps = 5) }
            room.now += 60_000
            val ended = (room.store.finish() as FinishOutcome.Closed).session
            runCurrent()

            val record = (room.store.record(movement.id) as GymResult.Ok).value
            val top = RecordMark(weightKg = 82.5, reps = 5, atMs = ended.startedAtMs, e1rm = 96.3)
            assertEquals("Bench Press", record.exercise.name)
            assertEquals(1, record.sessionCount)
            assertEquals(0, record.routineCount)
            assertEquals(top, record.heaviest)
            assertEquals("the phone runs the same estimate the log does", top, record.bestE1rm)
            assertEquals(listOf(top), record.e1rmSeries)
            assertEquals(emptyList<Any>(), record.records)
            assertEquals(listOf(ended.id), record.recentDays.map { it.sessionId })
            assertEquals("a warmup counts toward nothing, here as everywhere",
                listOf(82.5, 82.5, 82.5, 82.5), record.recentDays.single().sets.map { it.weightKg })

            val review = room.store.review(ended.id)
            assertEquals(Review(stats = ReviewStats(durationMs = ended.finishedAtMs!! - ended.startedAtMs,
                workingSets = 4, topE1rm = 96.3), slight = false), review)

            val detail = (room.store.sessionDetail(ended.id) as GymResult.Ok).value
            assertEquals(5, detail.sets.size)
            runCurrent()
        }
    }

    @Test
    fun testARenameMovesTheNameAndNeverTheIdAndTheReplicaKeepsIt() = runTest {
        val folder = tmp.newFolder()
        val snapshot: Json
        val clock: Long
        val movement: works.windmill.gym.domain.Exercise
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select(null)
            movement = (room.store.create("Bench Pres", "barbell") as GymResult.Ok).value

            room.store.start()
            room.store.choose(movement.id)
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.now += 60_000
            room.store.finish()
            runCurrent()

            assertEquals("the page draws the movement the write confirmed, not the string typed at it",
                movement.copy(name = "Bench Press", aliases = listOf("Bench Pres")),
                (room.store.rename(movement.id, " Bench Press ") as GymResult.Ok).value)
            assertEquals("Bench Press", room.store.catalog.single { it.id == movement.id }.name)

            val record = (room.store.record(movement.id) as GymResult.Ok).value
            assertEquals("Bench Press", record.exercise.name)
            assertEquals("the history is whole — the id never moved", 1, record.sessionCount)

            assertEquals("Name it to save it.",
                ((room.store.rename(movement.id, "   ") as GymResult.Failed).why as WriteFailure.Refused).said)
            assertEquals("a catalog movement is renamed on the phone signed out too",
                "Squat", (room.store.rename("back-squat", "Squat") as GymResult.Ok).value.name)
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start()
            relaunched.select(null)
            assertEquals("Bench Press", relaunched.store.catalog.single { it.id == movement.id }.name)
            runCurrent()
        }
    }

    @Test
    fun testSignedInARenameGoesToTheLogAndTheCatalogFollowsIt() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)

            assertEquals("Low-bar Squat",
                (room.store.rename("back-squat", "Low-bar Squat") as GymResult.Ok).value.name)

            assertEquals(listOf("exerciseName back-squat"), owed(room))
            assertEquals("Low-bar Squat", room.store.catalog.single { it.id == "back-squat" }.name)
            assertEquals("the id is what every set points at, and it did not move",
                "back-squat", room.store.catalog.single { it.id == "back-squat" }.id)
            room.sync(server)
            assertEquals("Low-bar Squat", anotherPhone(server, room.now) { phone ->
                phone.store.catalog.single { it.id == "back-squat" }.name })
            runCurrent()
        }
    }

    @Test
    fun testARenameIsTheAccountsAndNeverCrossesToTheNextSeatOnThisPhone() = runTest {
        val folder = tmp.newFolder()
        val snapshot: Json
        val clock: Long
        val pristine: List<works.windmill.gym.domain.Exercise>
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select("alice")
            pristine = room.store.catalog
            room.store.rename("back-squat", "Alice’s Secret Squat")
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start(); relaunched.selected = "alice"
            relaunched.store.connect(relaunched.account())
            assertEquals("Alice’s Secret Squat", relaunched.store.catalog.single { it.id == "back-squat" }.name)

            relaunched.select("bob")
            assertEquals("this phone does not know Bob's names and does not borrow Alice's",
                pristine, relaunched.store.catalog)

            relaunched.select(null)
            assertEquals("and signing out is not a way back into her catalog either",
                pristine, relaunched.store.catalog)
            runCurrent()
        }
    }

    @Test
    fun testARecordOfAMovementTheLogDoesNotHoldSaysWhyRatherThanDrawingNothing() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())

            assertEquals(GymResult.Failed(WriteFailure.Refused("that movement is no longer on the log")),
                room.store.record("ex_gone"))
            runCurrent()
        }
    }

    @Test
    fun testAWarmupIsWrittenAsAWarmupAndCarriesNothingForward() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val legs = (room.store.saveRoutine(RoutineDraft(name = "Legs").adding("back-squat")
                .targeting("back-squat", List(5) { SetTarget(5, 100.0) })) as GymResult.Ok).value
            val opened = (room.store.start(legs.id) as GymResult.Ok).value
            room.store.choose("back-squat")
            assertEquals(Prefill(weightKg = 100.0, reps = 5), room.store.prefill)

            room.store.logSet(weightKg = 60.0, reps = 10, kind = SetKind.Warmup)

            assertEquals(listOf(SetKind.Warmup), room.training.session(opened.id)!!.sets.map { it.kind })
            assertEquals(listOf(SetKind.Warmup), room.store.sets.map { it.kind })
            assertEquals("a ramp-up is not the weight the next set starts from — the dial stays on the plan",
                Prefill(weightKg = 100.0, reps = 5), room.store.prefill)

            room.store.logSet(weightKg = 100.0, reps = 5)
            assertEquals(listOf(SetKind.Warmup, SetKind.Working), room.store.sets.map { it.kind })
            assertEquals(Prefill(weightKg = 100.0, reps = 5), room.store.prefill)

            room.store.logSet(weightKg = 105.0, reps = 3)
            assertEquals("and a working set does carry, past the warmup that came before it",
                Prefill(weightKg = 105.0, reps = 3), room.store.prefill)

            room.sync(server)
            assertEquals("the kind travels to the log", listOf(SetKind.Warmup, SetKind.Working, SetKind.Working),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets.map { it.kind } })
            runCurrent()
        }
    }

    @Test
    fun testSignedInWithNoSignalAStartComposesOnTheDeviceAndTheEngineSyncsIt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val routine = (room.store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")
                .targeting("bench-press", List(3) { SetTarget(5, 100.0) })) as GymResult.Ok).value
            room.store.refreshEngine()
            val opened = (room.store.start(routine.id) as GymResult.Ok).value
            assertEquals("the plan froze off the routine this store holds", PlanSnapshot(routine), opened.plan)
            room.store.choose("bench-press"); room.store.logSet(100.0, 5)
            assertEquals(1, room.store.strandedCount)
            val set = room.store.sets.single()
            assertEquals(listOf(100.0), room.training.session(opened.id)!!.sets.map { it.weightKg })
            assertTrue("the offline command and set are durable", room.outbox().isNotEmpty())
            val server = EngineRoomFixture.server()
            room.sync(server); room.store.refreshEngine()
            assertEquals(opened.id, room.store.session!!.id)
            assertEquals(set.id, room.store.sets.single().id)
            assertEquals(opened.plan, room.store.session!!.plan)
            assertEquals(listOf(100.0), room.store.sets.map { it.weightKg })
            assertTrue(room.store.refusals.isEmpty())
        }
    }

    @Test
    fun testAStartWhoseReplyWasLostRetriesTheExactEngineIntentAndKeepsItsId() = runTest {
        val folder = tmp.newFolder()
        val server = EngineRoomFixture.server()
        var snapshot: works.windmill.sync.core.Json
        var original: works.windmill.sync.core.Json
        var opened: Session
        var set: TrainingSet
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select("alice")
            opened = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press"); room.store.logSet(100.0, 5)
            set = room.store.sets.single()
            room.engine.releaseHeld(true)
            original = room.engine.nextPush()!!
            assertEquals(200, server.push(original, works.windmill.sync.modelserver.Credential.Account("alice"), room.now).status)
            snapshot = room.engine.snapshot() // The response is lost after the server has committed it.
        }
        EngineRoomFixture(folder, backgroundScope, snapshot).use { restored ->
            restored.selected = "alice"
            restored.engine.start()
            val retry = restored.engine.nextPush()!!
            assertEquals(original, retry)
            val response = server.push(retry, works.windmill.sync.modelserver.Credential.Account("alice"), restored.now)
            val reading = works.windmill.sync.core.ClockReading(restored.now, restored.now, "test")
            restored.engine.onPushResponse(retry, works.windmill.sync.engine.SyncResponse(response.status, response.body),
                works.windmill.sync.engine.RequestTiming(reading, reading))
            restored.pull(server); restored.store.connect(restored.account())
            assertEquals(opened.id, restored.store.session!!.id)
            assertEquals(listOf(set.id), restored.store.sets.map { it.id })
            assertEquals(listOf(100.0), restored.store.sets.map { it.weightKg })
            assertEquals(1, restored.training.details().size)
            assertTrue(restored.store.refusals.isEmpty())
        }
    }

    @Test
    fun testARefusedEngineStartIsSaidOnceAndItsOriginalIntentStaysOnThePhone() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val opened = (room.store.start() as GymResult.Ok).value
            val server = EngineRoomFixture.server()
            server.refuse(code = "id-taken")
            room.sync(server)
            withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.notices("gym").notices.first { it.isNotEmpty() } } }
            room.store.refreshEngine()
            val notices = room.engine.notices("gym").notices.value
            assertEquals(1, notices.size)
            assertTrue("the refused source retains its original identity", notices.single().content.command!!.args.member("id").str() == opened.id)
            val said = room.store.refusals
            assertEquals(1, said.size)
            repeat(2) { room.store.refreshEngine(); assertEquals("said again, held once", said, room.store.refusals) }
            assertEquals(notices, room.engine.notices("gym").notices.value)
        }
    }

    @Test
    fun testAWriteBackToARoutineGoneFromTheLogSaysWhyAndMovesNothing() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val pushA = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) })) as GymResult.Ok).value
            room.sync(server); room.store.refreshEngine()
            room.store.start(pushA.id); room.store.choose("bench-press")

            val heavier = List(5) { SetTarget(5, 87.5) }
            assertEquals("a routine gone from the log is not a write",
                WriteFailure.Refused("that routine is no longer on the log"),
                room.store.save(heavier, toRoutine = "rt_gone", atPosition = 1, forExercise = "bench-press"))
            assertEquals("and nothing moved",
                List(5) { SetTarget(5, 82.5) }, room.training.routine(pushA.id)!!.entries.first().sets)

            assertNull(room.store.save(heavier, toRoutine = pushA.id, atPosition = 1, forExercise = "bench-press"))
            assertEquals(heavier, room.training.routine(pushA.id)!!.entries.first().sets)
            assertEquals("the copy in hand moved with the log's",
                heavier, room.store.routines.first { it.id == pushA.id }.entries.first().sets)
            room.sync(server)
            assertEquals(heavier, anotherPhone(server, room.now) { phone ->
                phone.training.routine(pushA.id)!!.entries.first().sets })
            runCurrent()
        }
    }

    @Test
    fun testARetargetWithNothingToMoveIsRefusedAndNeverWritten() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val pushA = (room.store.saveRoutine(RoutineDraft(name = "Push A")
                .adding("overhead-press").targeting("overhead-press", List(3) { SetTarget(8, 45.0) })
                .adding("bench-press").targeting("bench-press", List(5) { SetTarget(5, 82.5) })) as GymResult.Ok).value
            room.sync(server); room.store.refreshEngine()
            room.store.start(pushA.id); room.store.choose("bench-press")
            val before = owed(room)

            assertEquals(WriteFailure.Refused("Push A has changed since this session started"),
                room.store.save(List(5) { SetTarget(5, 87.5) }, toRoutine = pushA.id, atPosition = 1,
                    forExercise = "bench-press"))
            assertEquals("nothing to write is no write", before, owed(room))
            assertEquals("and the revision did not move", 1, room.training.routine(pushA.id)!!.revision)
            assertEquals(listOf(List(3) { SetTarget(8, 45.0) }, List(5) { SetTarget(5, 82.5) }),
                room.training.routine(pushA.id)!!.entries.map { it.sets })

            room.select(null)
            val kept = (room.store.keep(listOf(
                TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 100.0, reps = 5,
                    completedAtMs = 1_100)), asRoutineNamed = "Push Day") as GymResult.Ok).value
            assertEquals(WriteFailure.Refused("Push Day has changed since this session started"),
                room.store.save(listOf(SetTarget(5, 105.0)), toRoutine = kept.id, atPosition = 2,
                    forExercise = "bench-press"))
            assertEquals("the signed-out document stood still",
                listOf(SetTarget(5, 100.0)), room.training.routine(kept.id)?.entries?.first()?.sets)
            runCurrent()
        }
    }

    @Test
    fun testAMovementThatWasNotCreatedSaysWhyAndIsNotDrawn() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())
            room.store.create("Sled Push", "machine", id = "ex_taken")
            val before = room.store.catalog

            val why = (room.store.create("Zercher Squat", "barbell", id = "ex_taken") as? GymResult.Failed)?.why
            assertEquals("a refused create is not a movement",
                WriteFailure.Refused("already saved as Sled Push (machine) — choose it from the movement list"), why)
            assertFalse(room.store.catalog.any { it.name == "Zercher Squat" })

            val made = (room.store.create("Zercher Squat", "barbell") as? GymResult.Ok)?.value
            assertEquals("the second attempt lands", "Zercher Squat", made?.name)
            assertEquals(before + made, room.store.catalog)
            runCurrent()
        }
    }

    @Test
    fun testTheMovementNamesAreHeldOnTheDeviceForTheSeatThatReadThem() = runTest {
        val folder = tmp.newFolder()
        val server = EngineRoomFixture.server()
        anotherPhone(server, 1_800_000_000_000L) { phone ->
            phone.store.rename("bench-press", "Flat press")
            phone.sync(server)
        }
        val snapshot: Json
        val clock: Long
        val pristine: List<works.windmill.gym.domain.Exercise>
        val read: List<works.windmill.gym.domain.Exercise>
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.now = 1_800_000_100_000L
            pristine = room.training.catalogue()
            room.select("alice"); room.pull(server); room.store.refreshEngine()
            assertEquals("Flat press", Readout.movement("bench-press", room.store.catalog))
            read = room.store.catalog
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start(); relaunched.selected = "alice"
            relaunched.store.connect(relaunched.account())
            assertEquals("the names this phone read for the account draw on the next launch, unread",
                read, relaunched.store.catalog)
            assertEquals("Flat press", Readout.movement("bench-press", relaunched.store.catalog))

            relaunched.select(null)
            assertEquals("the names read for an account are that account's, and signing out is not a way to keep reading them",
                pristine, relaunched.store.catalog)
            runCurrent()
        }
    }

    @Test
    fun testTheLogPagesOlderOnAskAndKnowsWhenItHasReachedTheBottom() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())
            repeat(60) { index ->
                val id = "session${index.toString().padStart(3, '0')}"
                room.training.startSession(SessionStart(id, room.now - 100_000 + index * 1_000L))
                room.training.finishSession(id, room.now - 99_500 + index * 1_000L)
            }
            room.store.connect(room.account())

            assertEquals("a full page, so there may be more", Older.More, room.store.older)
            assertEquals(50, room.store.logged.size)
            assertEquals("newest first", "session059", room.store.logged.first().id)

            room.store.loadOlder()

            assertEquals("sixty sessions, no row twice", 60, room.store.logged.size)
            assertEquals(60, room.store.logged.map { it.id }.toSet().size)
            assertEquals("a short page is the bottom", Older.End, room.store.older)
            assertEquals("session000", room.store.logged.last().id)

            room.store.loadOlder()
            assertEquals("the bottom stays the bottom", Older.End, room.store.older)
            assertEquals(60, room.store.logged.size)
            runCurrent()
        }
    }

    @Test
    fun testTheEngineReReadKeepsThePagesTheLifterWalked() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            repeat(60) { index ->
                val id = "session${index.toString().padStart(3, '0')}"
                room.training.startSession(SessionStart(id, room.now - 100000 + index * 1000L))
                room.training.finishSession(id, room.now - 99500 + index * 1000L)
            }
            room.select(null); room.store.loadOlder()
            assertEquals(60, room.store.logged.size)
            assertEquals(Older.End, room.store.older)
            room.training.startSession(SessionStart("sessionShelf", room.now - 1000))
            room.training.appendSet("sessionShelf", SetWrite("setShelf", "bench-press", 100.0, 5, SetKind.Working, room.now - 900))
            room.training.finishSession("sessionShelf", room.now - 500)
            room.store.refreshEngine()
            assertEquals("the pages the lifter walked are still under their thumb", 61, room.store.logged.size)
            assertEquals("no row twice", 61, room.store.logged.map { it.id }.toSet().size)
            assertEquals("newest first, with the imported session at the head", "sessionShelf", room.store.logged.first().id)
            assertEquals("the deepest row is where the walk left it", "session000", room.store.logged.last().id)
            assertEquals("the foot is still the bottom they arrived at", Older.End, room.store.older)
        }
    }

    @Test
    fun testSignedOutThePhoneIsTheWholeLogAndThereIsNothingOlder() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val ended = room.workout(load = 100.0)
            runCurrent()
            room.store.refreshEngine()

            assertEquals(Older.End, room.store.older)
            assertEquals(listOf(ended.id), room.store.recent.map { it.id })
            assertEquals("saved on this device is the only thing it is", setOf(ended.id), room.store.deviceOnlySessionIds)
            assertEquals("and the row carries what the log's own row would",
                listOf(1), room.store.recent.map { it.workingSetCount })
            assertEquals(listOf(500.0), room.store.recent.map { it.tonnageKg })
            runCurrent()
        }
    }

    @Test
    fun testFixingASetSignedOutRewritesThePhonesRowAndWritesNothingForAnIdItNeverHeld() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            room.store.start()
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.now += 60_000
            val ended = (room.store.finish() as FinishOutcome.Closed).session
            runCurrent()

            val setId = (room.store.sessionDetail(ended.id) as GymResult.Ok).value.sets.single().id
            val fixed = room.store.fixSet(ended.id, setId, SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))

            assertEquals(listOf(90.0), listOf((fixed as FixOutcome.Corrected).set.weightKg))
            assertEquals("one row per set — a correction is never a second set",
                listOf(setId), (room.store.sessionDetail(ended.id) as GymResult.Ok).value.sets.map { it.id })
            assertEquals(listOf(90.0),
                (room.store.sessionDetail(ended.id) as GymResult.Ok).value.sets.map { it.weightKg })
            assertEquals("the row the log screen draws moved with it",
                listOf(270.0), room.store.recent.map { it.tonnageKg })
            val before = owed(room)
            assertEquals("a row this workout does not hold is not one a fix can reach",
                FixOutcome.Gone("that set is no longer on the log"),
                room.store.fixSet(ended.id, "set_gone", SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working)))
            assertNull(room.store.deleteSet(ended.id, "set_gone"))
            assertEquals("nothing is written for an id this phone has never held", before, owed(room))
            runCurrent()
        }
    }

    @Test
    fun testFixingASetOnTheAccountReachesTheLogAndMovesNoPlanAndNoRoutine() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val pushA = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) })) as GymResult.Ok).value
            room.store.refreshEngine()
            val opened = (room.store.start(pushA.id) as GymResult.Ok).value
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.now += 60_000
            room.store.finish()
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val logged = room.training.session(opened.id)!!.sets.single()

            val fixed = room.store.fixSet(opened.id, logged.id, SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Drop))

            val corrected = logged.copy(weightKg = 90.0, reps = 3, kind = SetKind.Drop)
            assertEquals(corrected, (fixed as FixOutcome.Corrected).set)
            assertEquals("the head re-read, and it followed the correction all the way to the KIND — a " +
                "drop set counts toward no tonnage, so the row that read 412.5 now reads nothing",
                listOf(0.0), room.store.logged.map { it.tonnageKg })
            assertEquals(listOf(0), room.store.logged.map { it.workingSetCount })

            room.sync(server)
            anotherPhone(server, room.now) { phone ->
                assertEquals(listOf(corrected), phone.training.session(opened.id)!!.sets)
                assertEquals("the frozen plan is what makes last Tuesday still readable — it may not move",
                    PlanSnapshot(pushA), phone.training.session(opened.id)!!.session.plan)
                assertEquals("and next week's target is nobody's business here",
                    listOf(List(5) { SetTarget(5, 82.5) }), phone.training.routine(pushA.id)!!.entries.map { it.sets })
            }
            runCurrent()
        }
    }

    // The live session's rows are the phone's until the log takes them. A set no sync has carried
    // yet is corrected in place, still owed: the strip draws the correction at once, and the
    // corrected body is what lands when the signal is back.
    @Test
    fun testFixingASetNoSyncHasCarriedRewritesItOnThePhoneAndTheCorrectionIsWhatLands() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = (room.store.start() as GymResult.Ok).value
            room.sync(server)
            room.store.choose("bench-press")
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Unreachable)
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.store.logSet(weightKg = 85.0, reps = 5)
            runCurrent()
            val (tried, behind) = room.store.sets.map { it.id }
            assertEquals(setOf(tried, behind), room.store.stalled)
            assertEquals(2, room.store.strandedCount)

            val fixed = room.store.fixSet(opened.id, behind, SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working))
            runCurrent()

            assertEquals(90.0, (fixed as FixOutcome.Corrected).set.weightKg, 0.0)
            assertEquals("the strip draws the correction from the store", listOf(82.5 to 5, 90.0 to 3),
                room.store.sets.map { it.weightKg to it.reps })
            assertEquals("still owed — the log has never seen the id", setOf(tried, behind), room.store.stalled)

            room.sync(server)
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Answer(SyncResponse(200, Json.objectOf())))
            room.store.refreshEngine()
            assertEquals("the corrected body is the one that landed", listOf(82.5 to 5, 90.0 to 3),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets.map { it.weightKg to it.reps } })
            assertTrue(room.store.stalled.isEmpty())
            assertEquals(0, room.store.strandedCount)
            runCurrent()
        }
    }

    @Test
    fun testFixingADeliveredSetOfTheLiveSessionRedrawsTheStripFromTheStore() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val logged = room.store.sets.single()
            assertTrue(room.store.stalled.isEmpty())

            val fixed = room.store.fixSet(opened.id, logged.id, SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Drop))

            val corrected = (fixed as FixOutcome.Corrected).set
            assertEquals("the strip draws the correction the moment it is filed", listOf(corrected), room.store.sets)
            runCurrent()
            assertEquals("the correction is owed until the log takes it", listOf("set ${logged.id}"), owed(room))

            room.sync(server); room.store.refreshEngine()
            assertEquals("the log holds the whole row the device read", listOf(corrected),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets })
            assertEquals("the strip follows the log's answer", listOf(Triple(90.0, 3, SetKind.Drop)),
                room.store.sets.map { Triple(it.weightKg, it.reps, it.kind) })
            assertTrue("a fix the log took owes nothing", room.store.stalled.isEmpty())
            assertTrue(room.outbox().isEmpty())
            runCurrent()
        }
    }

    // A set no sync has carried leaves the strip at once, and the log never keeps it.
    @Test
    fun testDeletingASetNoSyncHasCarriedLeavesThePhoneAndTheLogNeverKeepsIt() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = (room.store.start() as GymResult.Ok).value
            room.sync(server)
            room.store.choose("bench-press")
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Unreachable)
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.store.logSet(weightKg = 85.0, reps = 5)
            runCurrent()
            val (tried, behind) = room.store.sets

            assertNull(room.store.deleteSet(opened.id, behind.id))
            runCurrent()

            assertEquals(listOf(tried), room.store.sets)
            assertEquals("the unsent row and its tombstone ride out together",
                listOf("set ${tried.id}", "set ${behind.id}", "set ${behind.id}"), owed(room))
            assertEquals(1, room.store.strandedCount)
            room.sync(server)
            assertEquals("and it never lands", listOf(tried.id),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets.map { it.id } })
            runCurrent()
        }
    }

    @Test
    fun testDeletingADeliveredSetOfTheLiveSessionTakesItOffTheStrip() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val first = room.store.sets.single()

            assertNull(room.store.deleteSet(opened.id, first.id))
            runCurrent()

            assertEquals(emptyList<TrainingSet>(), room.store.sets)
            assertEquals(setOf(first.id), room.store.deletedSets)
            assertEquals(listOf("set ${first.id}"), owed(room))
            room.sync(server)
            assertEquals("the log let it go", emptyList<TrainingSet>(),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets })

            room.store.logSet(weightKg = 90.0, reps = 3)
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val second = room.store.sets.single()
            assertNull("a delete is filed, never refused on the spot", room.store.deleteSet(opened.id, second.id))
            runCurrent()
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Failed(SyncResponse(503, Json.objectOf())))
            room.store.refreshEngine()
            assertEquals(emptyList<TrainingSet>(), room.store.sets)
            assertEquals("a delete the log could not take stays owed", listOf("set ${second.id}"), owed(room))
            assertEquals(listOf(second.id),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets.map { it.id } })

            room.sync(server)
            assertEquals(emptyList<TrainingSet>(),
                anotherPhone(server, room.now) { phone -> phone.training.session(opened.id)!!.sets })
            assertTrue(room.outbox().isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testARowWalkedDownToWithLoadOlderFollowsItsOwnCorrection() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())
            repeat(60) { index ->
                val id = "session${index.toString().padStart(3, '0')}"
                val startedAt = room.now - 100_000 + index * 1_000L
                room.training.startSession(SessionStart(id, startedAt))
                room.training.appendSet(id, SetWrite("set${index.toString().padStart(5, '0')}", "bench-press", 100.0, 5,
                    SetKind.Working, startedAt + 100))
                room.training.finishSession(id, startedAt + 500)
            }
            room.store.connect(room.account())
            room.store.loadOlder()
            assertEquals("the deepest row is a page and a half down", "session000", room.store.logged.last().id)
            assertEquals(listOf(500.0, 1), listOf(room.store.logged.last().tonnageKg, room.store.logged.last().workingSetCount))

            room.store.fixSet("session000", "set00000", SetFix(weightKg = 60.0, reps = 3, kind = SetKind.Warmup))

            assertEquals("the walk is not undone by a fix at the bottom of it", 60, room.store.logged.size)
            assertEquals("and the row followed the correction — a warmup counts toward nothing",
                listOf(0.0, 0), listOf(room.store.logged.last().tonnageKg, room.store.logged.last().workingSetCount))
            runCurrent()
        }
    }

    @Test
    fun testSignedOutASetOnTheAccountCannotBeTouchedAndIsNotBlamedOnTheSignal() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val opened = room.workout()
            runCurrent()
            val held = room.training.session(opened.id)!!.sets.single()
            room.select(null)
            val before = owed(room)

            assertEquals(FixOutcome.Gone("that set is no longer on the log"),
                room.store.fixSet(opened.id, held.id, SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Working)))
            assertNull(room.store.deleteSet(opened.id, held.id))
            assertEquals("nothing was written", before, owed(room))

            room.select("alice")
            assertEquals("signing out was not a way to touch the account's set",
                listOf(held), room.training.session(opened.id)!!.sets)
            runCurrent()
        }
    }

    @Test
    fun testADeleteIsWithheldUntilTheWindowClosesAndUndoTakesItBackUnsent() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.store.logSet(weightKg = 90.0, reps = 3)
            room.now += 60_000
            room.store.finish()
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val taken = room.training.session(opened.id)!!.sets.first()

            room.store.withhold(Deletion.Set(opened.id, taken))
            assertEquals(
                listOf(WithheldDelete(Deletion.Set(opened.id, taken), untilMs = room.now + Withheld.windowMs)),
                room.store.withheld)
            assertTrue("nothing has been told yet", room.outbox().isEmpty())

            assertNotNull(room.store.keepWithheld())
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertNull("undo writes nothing at all — it is this device changing its mind",
                room.store.settleWithheld(taken.id))
            assertTrue(room.outbox().isEmpty())
            assertEquals(2, room.training.session(opened.id)!!.sets.size)

            room.store.withhold(Deletion.Set(opened.id, taken))
            assertNull(room.store.settleWithheld(taken.id))
            assertEquals(listOf("set ${taken.id}"), owed(room))
            assertEquals("the set does not stand", listOf(90.0),
                room.training.session(opened.id)!!.sets.map { it.weightKg })
            assertEquals("and the screen that read the session before it went knows not to draw it",
                setOf(taken.id), room.store.deletedSets)
            assertEquals("the head re-read — the row lost a set, its tonnage and its top set",
                listOf(270.0), room.store.logged.map { it.tonnageKg })
            room.sync(server)
            assertEquals(listOf(90.0), anotherPhone(server, room.now) { phone ->
                phone.training.session(opened.id)!!.sets.map { it.weightKg } })
            runCurrent()
        }
    }

    // The old rule REVERSED, and this is the one the gesture wave turns on: behind a swipe two rows
    // can be gone in a second, and a second delete that settled the first would send it while its
    // Undo was still on screen.
    @Test
    fun testASecondDeleteOpensAWindowOfItsOwnAndSettlesNothing() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.store.logSet(weightKg = 60.0, reps = 12)
            room.now += 60_000
            room.store.finish()
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val (first, second) = room.training.session(opened.id)!!.sets

            room.store.withhold(Deletion.Set(opened.id, first))
            room.store.withhold(Deletion.Set(opened.id, second))

            assertTrue("nothing went out — a second delete settles nothing", room.outbox().isEmpty())
            assertEquals(setOf(first.id, second.id), room.store.withheldIds)
            assertEquals("both rows are off every list that reads them",
                emptySet<String>(), room.store.deletedSets)

            assertEquals("Undo takes the NEWEST back first",
                Deletion.Set(opened.id, second), room.store.keepWithheld()?.deletion)
            assertEquals("and the transient re-reads for the one still held",
                Deletion.Set(opened.id, first), room.store.holding?.deletion)
            assertNotNull(room.store.keepWithheld())

            assertEquals("so both sets are still on the log", listOf(first.id, second.id),
                room.training.session(opened.id)!!.sets.map { it.id })
            assertTrue(room.outbox().isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testAWithheldDeleteIsDroppedRatherThanSentAtSomebodyElsesLog() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val opened = room.workout()
            runCurrent()
            val taken = room.training.session(opened.id)!!.sets.single()
            room.store.withhold(Deletion.Set(opened.id, taken))

            room.select("bob")

            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertNull("and there is nothing left for a settle over it to find",
                room.store.settleWithheld(taken.id))
            room.select("alice")
            assertEquals("the set survives, which is the direction this one may fail in",
                listOf(taken), room.training.session(opened.id)!!.sets)
            runCurrent()
        }
    }

    @Test
    fun testAFailedLogReadIsSaidAtTheFootAndRetriedFromWhereItStopped() = runTest {
        val server = EngineRoomFixture.server()
        val held = anotherPhone(server, 1_800_000_000_000L) { phone ->
            phone.workout().also { phone.sync(server) }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.now = 1_800_000_100_000L
            room.select("alice")

            assertEquals(Older.Failed, room.store.older)
            assertTrue(room.store.logged.isEmpty())

            room.pull(server)
            room.store.loadOlder()

            assertEquals(listOf(held.id), room.store.logged.map { it.id })
            assertEquals(Older.End, room.store.older)
            runCurrent()
        }
    }

    @Test
    fun testUnitsAreADisplayTransformAndReachNoWrite() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val opened = (room.store.start() as GymResult.Ok).value
            room.store.choose("bench-press")

            assertNull(room.store.savePreferences(GymPreferences(units = Units.Pounds)))
            room.store.logSet(weightKg = 82.5, reps = 5)

            assertEquals(Units.Pounds, room.store.preferences.units)
            assertEquals(listOf(82.5), room.training.session(opened.id)!!.sets.map { it.weightKg })
            assertEquals(listOf(82.5), room.store.sets.map { it.weightKg })
            val written = room.outbox().map { it.member("intent") }
                .single { intent -> intent["d"]?.arr()?.any { it.member("t").str() == "set" } == true }.jcs
            assertTrue("the set went out in kilograms: $written", written.contains("\"weightKg\":[82.5,"))
            assertFalse("no unit reached the set that was written: $written", written.contains("lb"))
            assertFalse(written.contains("units"))

            assertNull(room.store.savePreferences(GymPreferences(units = Units.Kilograms)))
            assertEquals(listOf(82.5), room.training.session(opened.id)!!.sets.map { it.weightKg })
            runCurrent()
        }
    }

    @Test
    fun testAnAccountsOwnSettingsArriveOnSignInAndAreNotOverwrittenByAFreshPhone() = runTest {
        val server = EngineRoomFixture.server()
        anotherPhone(server, 1_800_000_000_000L) { phone ->
            assertNull(phone.store.savePreferences(GymPreferences(units = Units.Pounds, confirmHaptic = false)))
            phone.sync(server)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.now = 1_800_000_100_000L
            room.select("alice"); room.pull(server); room.store.refreshEngine()

            assertEquals(Units.Pounds, room.store.preferences.units)
            assertEquals(false, room.store.preferences.confirmHaptic)
            assertTrue("a phone with nothing to say says nothing", room.outbox().isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testASettingSavedWithNoSignalIsHeldHereAndLandsOnTheNextSync() = runTest {
        val folder = tmp.newFolder()
        val server = EngineRoomFixture.server()
        val snapshot: Json
        val clock: Long
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            room.training.reportDelivery(room.engine.activeReplica(), Reply.Unreachable)

            assertNull(room.store.savePreferences(GymPreferences(confirmSound = true)))

            assertEquals("the row on screen is the one the lifter chose", true, room.store.preferences.confirmSound)
            assertEquals(listOf("prefs prefs"), owed(room))
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start(); relaunched.selected = "alice"
            relaunched.store.connect(relaunched.account())
            relaunched.sync(server)
            assertEquals(true, anotherPhone(server, relaunched.now) { phone -> phone.store.preferences.confirmSound })
            runCurrent()
        }
    }

    @Test
    fun testAFirstSessionIsALogThatAnsweredAndAnsweredEmpty() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { fresh ->
            fresh.select(null)
            assertTrue("signed out the phone IS the log, and it is already in hand", fresh.store.firstSession)
        }

        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { opened ->
            opened.select("alice"); opened.pull(EngineRoomFixture.server()); opened.store.refreshEngine()
            assertTrue("nothing on the log, and the log said so", opened.store.firstSession)
        }

        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { unreachable ->
            unreachable.select("alice")
            assertFalse("the log page never answered", unreachable.store.firstSession)
        }

        val folder = tmp.newFolder()
        val snapshot: Json
        val clock: Long
        EngineRoomFixture(folder, backgroundScope).use { returning ->
            returning.select(null)
            returning.workout(load = 100.0, movement = "back-squat")
            runCurrent()
            returning.store.refreshEngine()
            assertFalse("the phone holds a session now", returning.store.firstSession)
            snapshot = returning.engine.snapshot(); clock = returning.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start()
            relaunched.select(null)
            assertFalse("and it still does on the next launch", relaunched.store.firstSession)
            runCurrent()
        }
    }

    @Test
    fun testAReorderMovesTheWalkAndASwipeRefusesAMovementWithASetInIt() = runTest {
        val folder = tmp.newFolder()
        val snapshot: Json
        val clock: Long
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select(null)
            room.store.start()
            room.store.choose("back-squat")
            room.store.logSet(weightKg = 100.0, reps = 5)
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 80.0, reps = 8)
            room.store.choose("romanian-deadlift")
            assertEquals(listOf("back-squat", "bench-press", "romanian-deadlift"), room.store.order)

            room.store.reorder(from = 2, to = 0)
            assertEquals(listOf("romanian-deadlift", "back-squat", "bench-press"), room.store.order)
            assertEquals("every set is exactly where it was — sets are keyed by movement, never position",
                listOf(100.0, 80.0), room.store.sets.map { it.weightKg })
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start()
            relaunched.select(null)
            assertEquals("and the walk survives the relaunch",
                listOf("romanian-deadlift", "back-squat", "bench-press"), relaunched.store.order)

            assertFalse("a movement holding a set does not leave on a swipe", relaunched.store.drop("back-squat"))
            assertEquals(listOf("romanian-deadlift", "back-squat", "bench-press"), relaunched.store.order)

            assertTrue(relaunched.store.drop("romanian-deadlift"))
            assertEquals(listOf("back-squat", "bench-press"), relaunched.store.order)
            assertNull("the movement in hand left the session, so the picker comes back up",
                relaunched.store.exerciseId)
            assertEquals("and nothing logged went with it",
                listOf(100.0, 80.0), relaunched.store.sets.map { it.weightKg })
            runCurrent()
        }
    }

    @Test
    fun testTheCardArrivesOnTheRoutineTheReadAlreadyMakes() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            assertEquals(listOf("proposal1"), room.store.pendingProposals.map { it.id })
            assertEquals("Coach", room.store.pendingProposals.single().source.name)
            assertEquals("proposal1", room.store.routine(pushA.id)?.pendingProposal?.id)
            runCurrent()
        }
    }

    @Test
    fun testASignedOutRoomHasNoProposalsAndDecidesNone() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            pushAWaitingOnADiff(room, server)
            room.select(null)
            room.store.keep(listOf(TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 82.5,
                reps = 5, completedAtMs = 1_100)), asRoutineNamed = "Push A")

            assertTrue("the phone's own routine wears no card",
                room.store.routines.isNotEmpty() && room.store.routines.all { it.pendingProposal == null })
            assertTrue(room.store.pendingProposals.isEmpty())
            val before = owed(room)

            assertEquals(ProposalOutcome.Failed(WriteFailure.Refused("Sign in again to decide this proposal.")),
                room.store.applyProposal("proposal1"))
            assertEquals("nothing was written", before, owed(room))
            runCurrent()
        }
    }

    @Test
    fun testNothingMovesUntilTheTapAndThenTheLogsOwnRoutineLands() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            assertEquals("Push A", room.store.routine(pushA.id)?.name)
            assertEquals(1, room.store.routine(pushA.id)?.revision)

            val decided = deciding(room, server) { room.store.applyProposal("proposal1") }

            assertTrue(decided is ProposalOutcome.Decided)
            assertEquals(ProposalState.Applied, (decided as ProposalOutcome.Decided).proposal.state)
            assertEquals("Push A — heavy", room.store.routine(pushA.id)?.name)
            assertEquals(2, room.store.routine(pushA.id)?.revision)
            assertEquals("and the diff itself landed, not only the name",
                listOf(RoutineEntry(position = 1, exerciseId = "bench-press", sets = List(5) { SetTarget(3, 87.5) })),
                room.store.routine(pushA.id)?.entries)
            assertTrue("the card goes because the decision was taken", room.store.pendingProposals.isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testADecisionTakenOnAnotherSurfaceRedrawsTheProgramHere() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)
            assertEquals(listOf("proposal1"), room.store.pendingProposals.map { it.id })
            anotherPhone(server, room.now) { phone ->
                assertTrue(deciding(phone, server) { phone.store.applyProposal("proposal1") } is ProposalOutcome.Decided)
            }

            val refused = deciding(room, server) { room.store.dismissProposal("proposal1") }

            assertEquals(ProposalOutcome.Settled("That proposal has already been decided."), refused)
            assertTrue("the card goes with the decision it was waiting for", room.store.pendingProposals.isEmpty())
            assertEquals("and the routine is the one the log now holds", "Push A — heavy",
                room.store.routine(pushA.id)?.name)
            assertEquals(2, room.store.routine(pushA.id)?.revision)
            assertEquals(
                listOf(RoutineEntry(position = 1, exerciseId = "bench-press", sets = List(5) { SetTarget(3, 87.5) })),
                room.store.routine(pushA.id)?.entries)
            runCurrent()
        }
    }

    @Test
    fun testAMidSessionSaveSupersedesTheDiffAndTheTapIsRefused() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            assertNull(room.store.save(List(5) { SetTarget(5, 87.5) }, toRoutine = pushA.id, atPosition = 1,
                forExercise = "bench-press"))
            room.sync(server); room.store.refreshEngine()
            assertEquals("the log moved the revision under the diff", 2, room.store.routine(pushA.id)?.revision)

            val refused = deciding(room, server) { room.store.applyProposal("proposal1") }

            assertEquals("the log's own sentence, as sent",
                ProposalOutcome.Moved("That proposal has been replaced."), refused)
            assertEquals("the routine was re-read, not argued with", 2, room.store.routine(pushA.id)?.revision)
            assertTrue(room.store.pendingProposals.isEmpty())
            assertEquals("the lifter's own 87.5 stands, and the triples the diff wanted never landed",
                List(5) { SetTarget(5, 87.5) }, room.store.routine(pushA.id)?.entries?.first()?.sets)
            assertEquals("set aside by the save rather than applied", ProposalState.Superseded,
                room.training.proposal("proposal1")?.state)
            runCurrent()
        }
    }

    @Test
    fun testASupersededDiffIsReadableOffTheRoutineTheRoomHolds() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            val waiting = room.store.pendingProposals.single()
            val held = room.store.routine(pushA.id)!!
            assertEquals(1, waiting.baseRevision)
            assertFalse(waiting.supersededBy(held))
            assertTrue(waiting.supersededBy(held.copy(revision = 2)))
            runCurrent()
        }
    }

    @Test
    fun testDismissTakesTheCardAndTouchesNothingElse() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            val decided = deciding(room, server) { room.store.dismissProposal("proposal1") }

            assertEquals(ProposalState.Dismissed, (decided as ProposalOutcome.Decided).proposal.state)
            assertTrue(room.store.pendingProposals.isEmpty())
            assertEquals("the routine did not move", 1, room.store.routine(pushA.id)?.revision)
            assertEquals("Push A", room.store.routine(pushA.id)?.name)
            assertEquals(ProposalState.Dismissed, room.training.proposal("proposal1")?.state)
            runCurrent()
        }
    }

    @Test
    fun testDecidingWhatWasAlreadyDecidedTheOtherWayIsTerminal() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            pushAWaitingOnADiff(room, server)
            assertTrue(deciding(room, server) { room.store.dismissProposal("proposal1") } is ProposalOutcome.Decided)

            assertEquals(ProposalOutcome.Settled("That proposal has already been decided."),
                deciding(room, server) { room.store.applyProposal("proposal1") })
            assertTrue(deciding(room, server) { room.store.dismissProposal("proposal1") } is ProposalOutcome.Decided)
            runCurrent()
        }
    }

    @Test
    fun testARemovalTappedTwiceLeavesTheProgramTellingTheTruth() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server, removing = true)
            // Another surface taps Apply and the log takes the removal.
            anotherPhone(server, room.now) { phone ->
                val elsewhere = async { phone.store.applyProposal("proposal1") }
                runCurrent(); phone.now += 1_000; phone.sync(server)
                elsewhere.cancel()
            }
            assertEquals(pushA.id, room.store.routine(pushA.id)?.id)

            val again = deciding(room, server) { room.store.applyProposal("proposal1") }

            assertEquals(ProposalOutcome.Gone("that proposal is no longer on the log"), again)
            assertNull("the program was re-read rather than guessed at", room.store.routine(pushA.id))
            runCurrent()
        }
    }

    @Test
    fun testAnUnreachableLogLeavesTheCardExactlyWhereItWas() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            val decision = async { room.store.applyProposal("proposal1") }
            runCurrent(); advanceTimeBy(15_001); runCurrent()

            assertEquals(ProposalOutcome.Failed(WriteFailure.NoAnswer), decision.await())
            room.store.refreshEngine()
            assertEquals("proposal1", room.store.routine(pushA.id)?.pendingProposal?.id)
            assertEquals(ProposalState.Pending, room.training.proposal("proposal1")?.state)
            runCurrent()
        }
    }

    @Test
    fun testAProposalThatIsNotThereIsOneFactAndNotAnError() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())

            assertEquals(ProposalOutcome.Gone("that proposal is no longer on the log"),
                room.store.applyProposal("proposal_gone"))
            assertEquals(ProposalRead.Gone, room.store.proposal("proposal_gone"))
            runCurrent()
        }
    }

    @Test
    fun testDecidingAnOldProposalDoesNotHideTheOneThatReplacedIt() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server, proposalId = "proposalOld")
            coachProposes(server, room.now, pushA.id, "proposalNew", sets = List(4) { SetTarget(3, 90.0) })
            room.pull(server); room.store.refreshEngine()
            assertEquals("proposalNew", room.store.routine(pushA.id)?.pendingProposal?.id)

            deciding(room, server) { room.store.dismissProposal("proposalOld") }

            assertEquals("proposalNew", room.store.routine(pushA.id)?.pendingProposal?.id)
            runCurrent()
        }
    }

    @Test
    fun testAskSignedOutNeverReachesTheLogAndSaysWhy() = runTest {
        val rest = FakeGymRest()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select(null)

            assertEquals(AskOutcome.Refused("Sign in first."), room.store.ask("thr_1", "what's stalled?"))
            assertEquals(emptyList<String>(), rest.calls)
            runCurrent()
        }
    }

    @Test
    fun testAProposalMintedInAConversationLandsOnTodayWithoutLeavingTheRoom() = runTest {
        val rest = FakeGymRest()
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select("alice"); room.pull(server)
            val pushA = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) })) as GymResult.Ok).value
            room.sync(server); room.store.refreshEngine()
            assertEquals(emptyList<Proposal>(), room.store.pendingProposals)

            rest.answers.add(AskAnswer(answer = "Done — as a proposal on Push A.",
                read = ReadTally(sets = 214, sessions = 34, weeks = 12), proposals = listOf("proposal1")))
            rest.onAsk = {
                coachProposes(server, room.now, pushA.id, "proposal1")
                room.pull(server)
            }

            val outcome = room.store.ask("thr_1", "write the triples block")

            assertEquals(AskOutcome.Answered(AskAnswer(answer = "Done — as a proposal on Push A.",
                read = ReadTally(sets = 214, sessions = 34, weeks = 12), proposals = listOf("proposal1"))),
                outcome)
            assertEquals(listOf("proposal1"), room.store.pendingProposals.map { it.id })
            runCurrent()
        }
    }

    @Test
    fun testTheReceiptIsTheServersNumberCarriedThrough() = runTest {
        val rest = FakeGymRest()
        rest.answers.add(AskAnswer(answer = "three sessions at the same top set.",
            read = ReadTally(sets = 214, sessions = 34, weeks = 12)))
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select("alice")

            val outcome = room.store.ask("thr_1", "what's stalled?")

            assertEquals(ReadTally(sets = 214, sessions = 34, weeks = 12),
                (outcome as AskOutcome.Answered).answer.read)
            runCurrent()
        }
    }

    @Test
    fun testBothCeilingsTakeTheComposerDownAQuietLogIsARetryAndAnAbsentRouteTakesTheDoorDown() = runTest {
        val rest = FakeGymRest()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select("alice")
            rest.refuseAsk = refusal(429, code = "ask-daily-limit", message = "the next question frees up in a couple of hours")
            assertEquals("the daily cap takes the composer down",
                AskOutcome.Capped("the next question frees up in a couple of hours", AskCap.Daily),
                room.store.ask("thr_1", "what's stalled?"))
            rest.refuseAsk = refusal(429, code = "ask-out-of-budget", message = "this account has reached its AI ceiling")
            assertEquals("and so does the account's 30-day ceiling, carrying its OWN sentence",
                AskOutcome.Capped("this account has reached its AI ceiling", AskCap.Ceiling),
                room.store.ask("thr_1", "what's stalled?"))

            rest.refuseAsk = refusal(500, message = "internal error")
            assertEquals(AskOutcome.Failed("internal error"), room.store.ask("thr_1", "what's stalled?"))

            rest.refuseAsk = refusal(404, message = "not found")
            assertEquals(AskOutcome.Absent, room.store.ask("thr_1", "what's stalled?"))

            rest.refuseAsk = refusal(409, code = "ask-thread-full", message = "that conversation is full")
            assertEquals(AskOutcome.Fresh("that conversation is full"), room.store.ask("thr_1", "what's stalled?"))
            runCurrent()
        }
    }

    @Test
    fun testTheThreadsListIsReadEveryTimeAndCarriesNoTurns() = runTest {
        val rest = FakeGymRest()
        rest.conversations["thr_1"] = AskThread(
            id = "thr_1", title = "Bench has been stuck at 82.5. What do you see?",
            askedAtMs = 2_000, outcome = ThreadOutcome("applied", changes = 4, routine = "Push A"),
            turns = listOf(AskTurn("lifter", "Bench has been stuck at 82.5. What do you see?", 2_000)))
        rest.conversations["thr_2"] = AskThread(
            id = "thr_2", title = "Is my squat volume too low?", askedAtMs = 5_000,
            outcome = ThreadOutcome("read-only"))
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select("alice")

            val listed = room.store.readThreads()

            assertEquals(listOf("thr_2", "thr_1"), (listed as GymResult.Ok).value.map { it.id })
            assertEquals("no turns on the list read", listOf(0, 0), listed.value.map { it.turns.size })
            assertEquals("4 changes → Push A", listed.value[1].outcome.detail)

            room.store.readThreads()
            assertEquals(2, rest.calls.count { it == "threads" })
            runCurrent()
        }
    }

    @Test
    fun testAConversationIsReadWholeAndAMissingOneAnswersInWords() = runTest {
        val rest = FakeGymRest()
        rest.conversations["thr_1"] = AskThread(id = "thr_1", title = "what's stalled?",
            turns = listOf(AskTurn("lifter", "what's stalled?", 1_000),
                AskTurn("ask", "bench, three weeks.", 1_200)))
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select("alice")

            val opened = room.store.thread("thr_1")

            assertEquals(listOf("what's stalled?", "bench, three weeks."),
                (opened as GymResult.Ok).value.turns.map { it.text })
            assertEquals(GymResult.Failed(WriteFailure.Refused("that conversation is no longer on the log")),
                room.store.thread("thr_missing"))
            runCurrent()
        }
    }

    @Test
    fun testDeletingAThreadPreservesTheAppliedProposal() = runTest {
        val rest = FakeGymRest()
        val server = EngineRoomFixture.server()
        rest.conversations["thr_1"] = AskThread(id = "thr_1", title = "write the triples block")
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)
            assertTrue(deciding(room, server) { room.store.applyProposal("proposal1") } is ProposalOutcome.Decided)

            assertEquals(GymResult.Ok(Unit), room.store.deleteThread("thr_1"))

            val row = room.training.proposal("proposal1")!!
            assertEquals(ProposalState.Applied, row.state)
            assertEquals("the row still says the change came from Coach", "ask", row.source.door)
            assertEquals("and the conversation it opened is gone",
                GymResult.Failed(WriteFailure.Refused("that conversation is no longer on the log")),
                room.store.thread("thr_1"))
            assertEquals("the program did not move on the delete", 2, room.store.routine(pushA.id)?.revision)
            runCurrent()
        }
    }

    @Test
    fun testDeletingAConversationThatIsAlreadyGoneSucceedsAndAnythingElseIsSaid() = runTest {
        val rest = FakeGymRest()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select("alice")

            assertEquals(GymResult.Ok(Unit), room.store.deleteThread("thr_gone"))

            rest.refuseThreads = refusal(500, message = "internal error")
            assertEquals(GymResult.Failed(WriteFailure.Refused("internal error")), room.store.deleteThread("thr_1"))
            runCurrent()
        }
    }

    @Test
    fun testANoteIsSavedEditedReorderedAndDeletedInTheLogsOwnOrder() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())

            val first = room.store.saveNote("note_a", NoteWrite("How I want to be talked to", "Blunt."))
            val second = room.store.saveNote("note_b", NoteWrite("What I am training for", "A 140 squat."))
            assertEquals(GymResult.Ok(Note("note_a", 0, "How I want to be talked to", "Blunt.", 0)), first)
            assertEquals(GymResult.Ok(Note("note_b", 1, "What I am training for", "A 140 squat.", 0)), second)

            assertEquals("a spent id edits in place and keeps its position",
                GymResult.Ok(Note("note_a", 0, "How I want to be talked to", "Blunt, no cheering.", 0)),
                room.store.saveNote("note_a", NoteWrite("How I want to be talked to", "Blunt, no cheering.")))

            val reordered = room.store.reorderNotes(listOf("note_b", "note_a"))
            assertEquals(GymResult.Ok(listOf(
                Note("note_b", 0, "What I am training for", "A 140 squat.", 0),
                Note("note_a", 1, "How I want to be talked to", "Blunt, no cheering.", 0),
            )), reordered)
            assertEquals("an order naming a note outside the notebook is refused before anything is written",
                GymResult.Failed(WriteFailure.Refused("The notes changed. Read them again before reordering.")),
                room.store.reorderNotes(listOf("note_gone")))

            assertNull(room.store.deleteNote("note_b"))
            assertNull("a note already gone is gone", room.store.deleteNote("note_b"))
            assertEquals(GymResult.Ok(listOf(
                Note("note_a", 0, "How I want to be talked to", "Blunt, no cheering.", 0),
            )), room.store.readNotes())
            runCurrent()
        }
    }

    @Test
    fun testTheThreadDoorsNeverReachTheLogSignedOut() = runTest {
        val rest = FakeGymRest()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select(null)
            val signIn = WriteFailure.Refused("Sign in first.")

            assertEquals(GymResult.Failed(signIn), room.store.readThreads())
            assertEquals(GymResult.Failed(signIn), room.store.thread("thr_1"))
            assertEquals(GymResult.Failed(signIn), room.store.deleteThread("thr_1"))
            assertEquals(emptyList<String>(), rest.calls)
            runCurrent()
        }
    }

    @Test
    fun testADayBuiltAtHomeSavesWithAnOpenRowIntact() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)

            val draft = RoutineDraft(name = "  Heavy Thursday  ", position = 3)
                .adding("back-squat")
                .adding("barbell-row")
                .targeting("back-squat", List(5) { SetTarget(3, 110.0) })

            val saved = (room.store.saveRoutine(draft) as GymResult.Ok).value

            assertEquals("the name is trimmed and never blank", "Heavy Thursday", saved.name)
            val lines = listOf(
                RoutineEntry(position = 1, exerciseId = "back-squat", sets = List(5) { SetTarget(3, 110.0) }),
                RoutineEntry(position = 2, exerciseId = "barbell-row"))
            assertEquals(lines, saved.entries.sortedBy { it.position })
            assertTrue("an open row stays open", saved.entries.single { it.exerciseId == "barbell-row" }.isOpen)
            assertTrue("it is on the list the moment it lands", room.store.routines.any { it.id == saved.id })
            assertNull("and it has never been trained", saved.lastTrainedAtMs)
            room.sync(server)
            assertEquals(lines, anotherPhone(server, room.now) { phone ->
                phone.training.routine(saved.id)!!.entries.sortedBy { it.position } })
            runCurrent()
        }
    }

    @Test
    fun testAnEmptyDayIsRefusedInWordsAndNothingGoesOut() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")

            assertEquals(GymResult.Failed(WriteFailure.Refused("a routine needs a name")),
                room.store.saveRoutine(RoutineDraft(name = "   ").adding("back-squat")))
            assertEquals(GymResult.Failed(WriteFailure.Refused("a routine needs at least one movement")),
                room.store.saveRoutine(RoutineDraft(name = "Heavy Thursday")))
            assertTrue("nothing written", room.outbox().isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testSignedOutTheDayLandsOnThePhoneAndSurvivesARelaunch() = runTest {
        val folder = tmp.newFolder()
        val snapshot: Json
        val clock: Long
        val saved: Routine
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select(null)

            saved = (room.store.saveRoutine(RoutineDraft(name = "Heavy Thursday")
                .adding("deadlift")) as GymResult.Ok).value

            assertEquals(listOf("Heavy Thursday"), room.store.routines.map { it.name })
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start()
            relaunched.select(null)
            assertEquals(listOf(saved.id), relaunched.store.routines.map { it.id })
            assertTrue(relaunched.store.routines.single().entries.single().isOpen)
            runCurrent()
        }
    }

    @Test
    fun testRenamingARoutineIsTheWholeDocumentAndSupersedesAPendingProposal() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            val renamed = (room.store.saveRoutine(
                RoutineDraft.of(room.store.routine(pushA.id)!!).named("Heavy Thursday")) as GymResult.Ok).value

            assertEquals("Heavy Thursday", renamed.name)
            assertEquals("the same routine, not a fork", pushA.id, renamed.id)
            room.sync(server); room.store.refreshEngine()
            assertEquals(2, room.store.routine(pushA.id)?.revision)
            assertEquals("Heavy Thursday", room.store.routine(pushA.id)?.name)
            assertEquals("its lines came through untouched",
                listOf("bench-press"), room.store.routine(pushA.id)?.entries?.map { it.exerciseId })
            assertEquals(ProposalState.Superseded, room.training.proposal("proposal1")?.state)
            runCurrent()
        }
    }

    @Test
    fun testADroppedSignedOutRoutineLeavesAndItsSessionsKeepTheirSets() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val kept = (room.store.saveRoutine(RoutineDraft(name = "Push Day")
                .adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 100.0) })) as GymResult.Ok).value
            val opened = (room.store.start(routineId = kept.id) as GymResult.Ok).value
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 100.0, reps = 5)
            room.now += 60_000
            room.store.finish()
            runCurrent()

            assertNull("the drop is a success", room.store.dropRoutine(kept.id))

            assertEquals(emptyList<Routine>(), room.store.routines)
            assertEquals("the phone let go of the document", emptyList<Routine>(), room.training.program())
            val past = room.training.session(opened.id)!!
            assertEquals("the session run under it keeps every set", listOf(100.0), past.sets.map { it.weightKg })
            assertEquals(kept.id, past.session.routineId)
            assertEquals("the frozen plan is a copy, not a reference, and it stays",
                "Push Day", past.session.plan?.routine)

            assertNull("a routine this phone never held is already not there", room.store.dropRoutine("rt_account"))
            runCurrent()
        }
    }

    @Test
    fun testADroppedAccountRoutineLeavesTheProgramAndTheLogFollows() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val pushA = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) })) as GymResult.Ok).value
            room.sync(server); room.store.refreshEngine()

            assertNull(room.store.dropRoutine(pushA.id))

            assertEquals(emptyList<Routine>(), room.store.routines)
            assertEquals(listOf("routine ${pushA.id}"), owed(room))
            room.sync(server)
            assertEquals(emptyList<Routine>(), anotherPhone(server, room.now) { phone -> phone.training.program() })
            runCurrent()
        }
    }

    @Test
    fun testADeleteOfARoutineAlreadyGoneAnswersAsSuccess() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val pushA = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) })) as GymResult.Ok).value
            room.sync(server); room.store.refreshEngine()
            assertEquals(listOf(pushA.id), room.store.routines.map { it.id })
            anotherPhone(server, room.now) { phone ->
                assertNull(phone.store.dropRoutine(pushA.id))
                phone.sync(server)
            }

            assertNull("asked for it not to be there, and it is not there", room.store.dropRoutine(pushA.id))
            assertEquals("the list lets go without a second read", emptyList<Routine>(), room.store.routines)
            room.sync(server); room.store.refreshEngine()
            assertTrue("nothing to say out loud about a wish already granted",
                room.engine.snapshot().member("replicas").arr().none { it["notices"] != null })
            assertTrue(room.store.refusals.isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testACreatedMovementCarriesTheLoadingTheLifterPicked() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)

            val made = (room.store.create("Hammer row", "machine") as GymResult.Ok).value

            assertEquals("machine", made.equipment)
            assertEquals("Hammer row", made.name)
            assertTrue("a movement the lifter minted is tagged as theirs", made.custom)
            room.sync(server)
            assertEquals("machine", anotherPhone(server, room.now) { phone ->
                phone.store.catalog.single { it.id == made.id }.equipment })

            room.select(null)
            val local = (room.store.create("Sled push", "bodyweight") as GymResult.Ok).value
            assertEquals("bodyweight", local.equipment)
            runCurrent()
        }
    }

    @Test
    fun testASignedOutRoutineTracksItsLastWorkoutAndClearsItOnDiscard() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val routine = (room.store.saveRoutine(RoutineDraft(name = "Heavy Thursday")
                .adding("deadlift")) as GymResult.Ok).value

            assertNull(room.store.routines.single().lastTrainedAtMs)

            room.store.start(routine.id)
            room.store.choose("deadlift")
            room.store.logSet(weightKg = 140.0, reps = 5)
            room.store.finish()
            runCurrent()
            room.store.refreshEngine()

            assertNotNull("a session ran under it, and the phone can see that",
                room.store.routines.single().lastTrainedAtMs)
            assertEquals(room.store.recent.single().startedAtMs, room.store.routines.single().lastTrainedAtMs)

            assertTrue(room.store.discard(room.store.recent.single().id))
            runCurrent()
            room.store.refreshEngine()
            assertNull(room.store.routines.single().lastTrainedAtMs)
            runCurrent()
        }
    }

    @Test
    fun testALiveSessionTheLogHoldsIsNotReStartedOnARelaunchAndItsSetsLand() = runTest {
        val folder = tmp.newFolder()
        val server = EngineRoomFixture.server()
        val snapshot: Json
        val clock: Long
        val opened: Session
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            opened = (room.store.start() as GymResult.Ok).value
            room.sync(server)
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start(); relaunched.selected = "alice"
            relaunched.store.connect(relaunched.account())
            assertEquals(opened.id, relaunched.store.session?.id)
            assertTrue("no start replay for a session the log answered for", relaunched.outbox().isEmpty())

            relaunched.store.choose("bench-press")
            relaunched.store.logSet(weightKg = 82.5, reps = 5)
            runCurrent()
            assertEquals("only its set is owed", listOf("set ${relaunched.store.sets.single().id}"), owed(relaunched))
            relaunched.sync(server); relaunched.store.refreshEngine()
            assertEquals(SaveState.OnTheLog, relaunched.store.saveState)
            assertEquals("its set walked straight to the log", listOf(82.5),
                anotherPhone(server, relaunched.now) { phone -> phone.training.session(opened.id)!!.sets.map { it.weightKg } })
            runCurrent()
        }
    }

    @Test
    fun testASignedInOfflineRelaunchDrawsTheAccountsReplicaAndKeepsItsPreferences() = runTest {
        val folder = tmp.newFolder()
        val server = EngineRoomFixture.server()
        val snapshot: Json
        val clock: Long
        val lastSet: LastSet
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            room.store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")
                .targeting("bench-press", List(3) { SetTarget() }))
            room.store.rename("bench-press", "Flat press")
            room.workout()
            room.store.savePreferences(GymPreferences(confirmSound = true))
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            room.store.loadLastSets()
            lastSet = room.store.lastSets!!.getValue("bench-press")
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { basement ->
            basement.now = clock; basement.engine.start(); basement.selected = "alice"
            basement.store.connect(basement.account())
            assertEquals("the program is the copy this phone holds for the seat",
                listOf("Push Day"), basement.store.routines.map { it.name })
            assertEquals("the names too", "Flat press", basement.store.catalog.first { it.id == "bench-press" }.name)
            assertEquals("and the seat's own rack, never deleted by an offline launch",
                true, basement.store.preferences.confirmSound)
            basement.store.loadLastSets()
            assertEquals("the picker's meta from the replica, not sixty rows of silence",
                mapOf("bench-press" to lastSet), basement.store.lastSets)

            basement.select("u2")
            assertEquals("nothing of the last seat crosses to the next", emptyList<Routine>(), basement.store.routines)
            basement.store.loadLastSets()
            assertNull(basement.store.lastSets)
            runCurrent()
        }
    }

    @Test
    fun testAnAbandonedDeviceSessionIsFinishedAtItsLastActivityOnConnect() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            room.store.start()
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            val lastSetAt = room.store.sets.single().completedAtMs
            runCurrent()

            room.now += 3 * 60 * 60 * 1000
            val soon = room.freshStore()
            soon.connect(room.account())
            assertEquals("three hours is still a workout", "session01", soon.session?.id)
            runCurrent()

            room.now += 2 * 60 * 60 * 1000
            val later = room.freshStore()
            later.connect(room.account())
            assertNull("five hours after the last set it is over", later.session)
            assertEquals("finished at the last set", lastSetAt, room.training.session("session01")!!.session.finishedAtMs)
            assertEquals(listOf(82.5), room.training.session("session01")!!.sets.map { it.weightKg })
            runCurrent()

            val second = room.freshStore()
            second.connect(room.account())
            val startedAt = (second.start() as GymResult.Ok).value.startedAtMs
            runCurrent()
            room.now += 5 * 60 * 60 * 1000
            val empty = room.freshStore()
            empty.connect(room.account())
            assertNull(empty.session)
            assertEquals("a session with no sets ended when it began",
                startedAt, room.training.session("session02")!!.session.finishedAtMs)
            runCurrent()
        }
    }

    @Test
    fun testAnAccountSessionAbandonedForHoursIsLetGoOnConnectAndTheLogEndsIt() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = (room.store.start() as GymResult.Ok).value
            room.sync(server)
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            val logged = room.store.sets.single()
            runCurrent()

            room.now += 30 * 60 * 60 * 1000
            val relaunched = room.freshStore()
            relaunched.connect(room.account())

            assertNull("the room let the workout go", relaunched.session)
            assertEquals("its owed set is still owed, and no finish was written", listOf("set ${logged.id}"), owed(room))

            room.sync(server)
            anotherPhone(server, room.now) { phone ->
                val held = phone.training.session(opened.id)!!
                assertEquals("the owed set drained into it", listOf(82.5), held.sets.map { it.weightKg })
                assertEquals("and the log ended the workout at that set", logged.completedAtMs, held.session.finishedAtMs)
            }
            runCurrent()
        }
    }

    @Test
    fun testALapsedSignInIsNamedRatherThanCalledNoSignal() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            room.store.start(); room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)

            assertTrue(room.training.reportDelivery(room.engine.activeReplica(),
                Reply.Failed(SyncResponse(401, Json.objectOf()))))
            room.store.refreshEngine()

            assertEquals(SaveState.Blocked(Blocker.SignInLapsed), room.store.saveState)
            assertEquals("sign in again · saved here", room.store.saveState.line)
            assertEquals(Blocker.SignInLapsed, room.store.strandedBy)
            assertEquals(1, room.store.strandedCount)
            assertTrue("still owed, never dropped", room.store.refusals.isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testAWorkoutComposedOfflineUnderOneSeatNeverAppearsInTheNextAccount() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val finished = room.workout()
            val original = room.training.session(finished.id)!!
            assertEquals(listOf(82.5), original.sets.map { it.weightKg })
            room.select(null); room.select("bob")
            assertEquals("B's room draws none of A's workout", emptyList<String>(), room.store.recent.map { it.id })
            assertTrue("B's replica contains none of A's training", room.training.details().isEmpty())
            assertTrue(room.engine.dormantReplicas().any { it.account == "alice" && it.unsent > 0 })
            room.select("alice")
            assertEquals(original, room.training.session(finished.id))
            assertEquals(listOf(finished.id), room.store.recent.map { it.id })
            assertEquals("A's owed set is kept in full under the same identity", listOf(82.5), room.training.session(finished.id)!!.sets.map { it.weightKg })
        }
    }

    @Test
    fun testThePreviousSeatsLiveWorkoutIsNotDrawnForTheNextOne() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            room.store.start()
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 100.0, reps = 3)
            runCurrent()
            assertEquals("session01", room.store.session?.id)

            room.select(null)
            assertNull("signing out takes the workout off the screen with the seat", room.store.session)
            assertEquals(emptyList<Double>(), room.store.sets.map { it.weightKg })

            room.select("bob")
            assertNull("and B is not standing in A's workout", room.store.session)
            room.sync(server)
            assertTrue("so nothing of A's went out under B's account",
                anotherPhone(server, room.now, account = "bob") { phone -> phone.training.details().isEmpty() })

            room.select("alice")
            assertEquals("A comes back to their own bar", "session01", room.store.session?.id)
            assertEquals(listOf(100.0), room.store.sets.map { it.weightKg })
            runCurrent()
        }
    }
}
