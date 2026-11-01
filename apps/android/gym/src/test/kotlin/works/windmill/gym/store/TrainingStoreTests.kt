package works.windmill.gym.store

import works.windmill.gym.coach.AskOutcome
import works.windmill.gym.coach.Ask
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.sync.engine.signIn
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
import works.windmill.gym.coach.AskAnswer
import works.windmill.gym.coach.AskCap
import works.windmill.gym.coach.AskThread
import works.windmill.gym.coach.AskTurn
import works.windmill.gym.presentation.GymPreferences
import works.windmill.gym.presentation.LastSet
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.presentation.ProposalState
import works.windmill.gym.coach.ReadTally
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.Routine
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.coach.ThreadOutcome
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
        val pushA = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
            .targeting("bench-press", List(5) { SetTarget(5, 82.5) }).capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
        room.sync(server)
        coachProposes(server, room.now, pushA.id, proposalId, name, removing = removing)
        room.pull(server); room.store.refreshEngine()
        return room.store.routines.routine(pushA.id)!!
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

    // A refusal reaches the notices off the engine's own thread.
    private suspend fun noticed(room: EngineRoomFixture) =
        withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.notices("gym").notices.first { it.isNotEmpty() } } }

    // A workout chosen signed out, carried into an account the phone has not read yet, restored with no cached owner:
    // the account cannot answer last time, so the rack opens without it rather than refusing the workout.
    @Test
    fun testARestoreOverAnUnreadAccountOpensTheWorkoutWithoutLastTime() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val session = room.startExternalWorkout()
            room.store.workout.choose("back-squat")
            val schema = works.windmill.sync.schema.SyncSchema.registry.version
            val question = room.engine.signIn("a", mapOf("gym" to true), serverSchema = schema)
            if (!question.member("complete").bool()) {
                val pins = question.member("due").arr().associate { due -> due.member("product").str() to due.member("counted").arr().map { it.str() } }
                room.engine.signIn("a", mapOf("gym" to true), mapOf("gym" to "add"), pins, serverSchema = schema)
            }
            assertFalse(room.training.anonymous || room.training.firstPullComplete)
            val cold = room.freshStore()
            assertTrue(cold.restoreWorkout(null, true))
            assertNull(cold.workout.workoutFailure)
            assertEquals(session.id, cold.workout.session?.id)
            assertEquals("back-squat", cold.workout.exerciseId)
            assertTrue(cold.workout.lastTime!!.isUnread)
        }
    }

    @Test
    fun testARenameIsTheAccountsAndNeverCrossesToTheNextSeatOnThisPhone() = runTest {
        val folder = tmp.newFolder()
        val snapshot: Json
        val clock: Long
        val pristine: List<works.windmill.gym.presentation.Exercise>
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.select("alice")
            pristine = room.store.routines.catalog
            room.store.history.edit("back-squat", "Alice’s Secret Squat")
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start(); relaunched.selected = "alice"
            relaunched.store.connect(relaunched.account())
            assertEquals("Alice’s Secret Squat", relaunched.store.routines.catalog.single { it.id == "back-squat" }.name)

            relaunched.select("bob")
            assertEquals("this phone does not know Bob's names and does not borrow Alice's",
                pristine, relaunched.store.routines.catalog)

            relaunched.select(null)
            assertEquals("and signing out is not a way back into her catalog either",
                pristine, relaunched.store.routines.catalog)
            runCurrent()
        }
    }

    @Test
    fun testTheMovementNamesAreHeldOnTheDeviceForTheSeatThatReadThem() = runTest {
        val folder = tmp.newFolder()
        val server = EngineRoomFixture.server()
        anotherPhone(server, 1_800_000_000_000L) { phone ->
            phone.store.history.edit("bench-press", "Flat press")
            phone.sync(server)
        }
        val snapshot: Json
        val clock: Long
        val pristine: List<works.windmill.gym.presentation.Exercise>
        val read: List<works.windmill.gym.presentation.Exercise>
        EngineRoomFixture(folder, backgroundScope).use { room ->
            room.now = 1_800_000_100_000L
            pristine = room.training.catalogue()
            room.select("alice"); room.pull(server); room.store.refreshEngine()
            assertEquals("Flat press", Readout.movement("bench-press", room.store.routines.catalog))
            read = room.store.routines.catalog
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start(); relaunched.selected = "alice"
            relaunched.store.connect(relaunched.account())
            assertEquals("the names this phone read for the account draw on the next launch, unread",
                read, relaunched.store.routines.catalog)
            assertEquals("Flat press", Readout.movement("bench-press", relaunched.store.routines.catalog))

            relaunched.select(null)
            assertEquals("the names read for an account are that account's, and signing out is not a way to keep reading them",
                pristine, relaunched.store.routines.catalog)
            runCurrent()
        }
    }

    @Test
    fun testAskSignedOutNeverReachesTheLogAndSaysWhy() = runTest {
        val rest = FakeGymRest()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select(null)

            assertEquals(AskOutcome.Refused("Sign in first."), room.store.coach.ask("thr_1", "what's stalled?"))
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
            val pushA = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) }).capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
            room.sync(server); room.store.refreshEngine()
            assertEquals(emptyList<Proposal>(), room.store.routines.pendingProposals)

            rest.answers.add(AskAnswer(answer = "Done — as a proposal on Push A.",
                read = ReadTally(sets = 214, sessions = 34, weeks = 12), proposals = listOf("proposal1")))
            rest.onAsk = {
                coachProposes(server, room.now, pushA.id, "proposal1")
                room.pull(server)
            }

            val outcome = room.store.coach.ask("thr_1", "write the triples block")

            assertEquals(AskOutcome.Answered(AskAnswer(answer = "Done — as a proposal on Push A.",
                read = ReadTally(sets = 214, sessions = 34, weeks = 12), proposals = listOf("proposal1"))),
                outcome)
            runCurrent()
            assertEquals(listOf("proposal1"), room.store.routines.pendingProposals.map { it.id })
        }
    }

    @Test
    fun testTheReceiptIsTheServersNumberCarriedThrough() = runTest {
        val rest = FakeGymRest()
        rest.answers.add(AskAnswer(answer = "three sessions at the same top set.",
            read = ReadTally(sets = 214, sessions = 34, weeks = 12)))
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select("alice")

            val outcome = room.store.coach.ask("thr_1", "what's stalled?")

            assertEquals(ReadTally(sets = 214, sessions = 34, weeks = 12),
                (outcome as AskOutcome.Answered).answer.read)
            runCurrent()
        }
    }

    @Test
    fun testBothCeilingsKeepTheirTypedNoticeAQuietLogIsARetryAndAnAbsentRouteTakesTheDoorDown() = runTest {
        val rest = FakeGymRest()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select("alice")
            rest.refuseAsk = refusal(429, code = "ask-daily-limit", message = "the next question frees up in a couple of hours")
            assertEquals("the daily cap keeps its distinct typed outcome",
                AskOutcome.Capped(Ask.capReached, AskCap.Daily),
                room.store.coach.ask("thr_1", "what's stalled?"))
            rest.refuseAsk = refusal(429, code = "ask-out-of-budget", message = "this account has reached its AI ceiling")
            assertEquals("the account's 30-day ceiling carries its own sentence",
                AskOutcome.Capped("this account has reached its AI ceiling", AskCap.Ceiling),
                room.store.coach.ask("thr_1", "what's stalled?"))

            rest.refuseAsk = refusal(500, message = "internal error")
            assertEquals(AskOutcome.Failed("internal error"), room.store.coach.ask("thr_1", "what's stalled?"))

            rest.refuseAsk = refusal(404, message = "not found")
            assertEquals(AskOutcome.Absent, room.store.coach.ask("thr_1", "what's stalled?"))

            rest.refuseAsk = refusal(409, code = "ask-thread-full", message = "that conversation is full")
            assertEquals(AskOutcome.Fresh("that conversation is full"), room.store.coach.ask("thr_1", "what's stalled?"))
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

            val listed = room.store.coach.readThreads()

            assertEquals(listOf("thr_2", "thr_1"), (listed as GymResult.Ok).value.map { it.id })
            assertEquals("no turns on the list read", listOf(0, 0), listed.value.map { it.turns.size })
            assertEquals("4 changes → Push A", listed.value[1].outcome.detail)

            room.store.coach.readThreads()
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

            val opened = room.store.coach.thread("thr_1")

            assertEquals(listOf("what's stalled?", "bench, three weeks."),
                (opened as GymResult.Ok).value.turns.map { it.text })
            assertEquals(GymResult.Failed(WriteFailure.Refused("that conversation is no longer on the log")),
                room.store.coach.thread("thr_missing"))
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
            assertTrue(deciding(room, server) { room.store.routines.applyProposal("proposal1") } is ProposalOutcome.Decided)

            assertEquals(GymResult.Ok(Unit), room.store.coach.deleteThread("thr_1"))

            val row = room.training.proposal("proposal1")!!
            assertEquals(ProposalState.Applied, row.state)
            assertEquals("the row still says the change came from Coach", "ask", row.source.door)
            assertEquals("and the conversation it opened is gone",
                GymResult.Failed(WriteFailure.Refused("that conversation is no longer on the log")),
                room.store.coach.thread("thr_1"))
            assertEquals("the program did not move on the delete", 2, room.store.routines.routine(pushA.id)?.revision)
            runCurrent()
        }
    }

    @Test
    fun testDeletingAConversationThatIsAlreadyGoneSucceedsAndAnythingElseIsSaid() = runTest {
        val rest = FakeGymRest()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select("alice")

            assertEquals(GymResult.Ok(Unit), room.store.coach.deleteThread("thr_gone"))

            rest.refuseThreads = refusal(500, message = "internal error")
            assertEquals(GymResult.Failed(WriteFailure.Refused("internal error")), room.store.coach.deleteThread("thr_1"))
            runCurrent()
        }
    }

    @Test
    fun testTheThreadDoorsNeverReachTheLogSignedOut() = runTest {
        val rest = FakeGymRest()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = rest).use { room ->
            room.select(null)
            assertEquals(GymResult.Ok(emptyList<AskThread>()), room.store.coach.readThreads())
            assertEquals(GymResult.Failed(WriteFailure.Refused("that conversation is no longer on the log")), room.store.coach.thread("thr_1"))
            val id = room.store.coach.freshChat("A phone-only draft")
            val local = room.store.coach.allThreads.single()
            assertEquals(GymResult.Ok(listOf(local)), room.store.coach.readThreads())
            assertEquals(GymResult.Ok(local), room.store.coach.thread(id))
            assertEquals(GymResult.Ok(Unit), room.store.coach.deleteThread(id))
            assertEquals(GymResult.Ok(emptyList<AskThread>()), room.store.coach.readThreads())
            assertEquals(emptyList<String>(), rest.calls)
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
            room.store.routines.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")
                .targeting("bench-press", List(3) { SetTarget() }).capturingMovements(room.store.routines.catalog))
            room.store.history.edit("bench-press", "Flat press")
            room.workout()
            room.seedFeedback(GymPreferences(confirmSound = true))
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            room.store.workout.loadLastSets()
            lastSet = room.store.workout.lastSets!!.getValue("bench-press")
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { basement ->
            basement.now = clock; basement.engine.start(); basement.selected = "alice"
            basement.store.connect(basement.account())
            assertEquals("the program is the copy this phone holds for the seat",
                listOf("Push Day"), basement.store.routines.all.map { it.name })
            assertEquals("the names too", "Flat press", basement.store.routines.catalog.first { it.id == "bench-press" }.name)
            assertEquals("and the seat's own rack, never deleted by an offline launch",
                true, basement.store.workout.preferences.confirmSound)
            basement.store.workout.loadLastSets()
            assertEquals("the picker's meta from the replica, not sixty rows of silence",
                mapOf("bench-press" to lastSet), basement.store.workout.lastSets)

            basement.select("u2")
            assertEquals("nothing of the last seat crosses to the next", emptyList<Routine>(), basement.store.routines.all)
            basement.store.workout.loadLastSets()
            assertNull(basement.store.workout.lastSets)
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
            assertEquals("B's room draws none of A's workout", emptyList<String>(), room.store.history.allSessions.map { it.id })
            assertTrue("B's replica contains none of A's training", room.training.details().isEmpty())
            assertTrue(room.engine.dormantReplicas().any { it.account == "alice" && it.unsent > 0 })
            room.select("alice")
            assertEquals(original, room.training.session(finished.id))
            assertEquals(listOf(finished.id), room.store.history.allSessions.map { it.id })
            assertEquals("A's owed set is kept in full under the same identity", listOf(82.5), room.training.session(finished.id)!!.sets.map { it.weightKg })
        }
    }

    @Test
    fun testThePreviousSeatsLiveWorkoutIsNotDrawnForTheNextOne() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 100.0, reps = 3)
            runCurrent()
            assertEquals("session01", room.store.workout.session?.id)

            room.select(null)
            assertNull("signing out takes the workout off the screen with the seat", room.store.workout.session)
            assertEquals(emptyList<Double>(), room.store.workout.sets.map { it.weightKg })

            room.select("bob")
            assertNull("and B is not standing in A's workout", room.store.workout.session)
            room.sync(server)
            assertTrue("so nothing of A's went out under B's account",
                anotherPhone(server, room.now, account = "bob") { phone -> phone.training.details().isEmpty() })

            room.select("alice")
            assertEquals("A comes back to their own bar", "session01", room.store.workout.session?.id)
            assertEquals(listOf(100.0), room.store.workout.sets.map { it.weightKg })
            runCurrent()
        }
    }
}
