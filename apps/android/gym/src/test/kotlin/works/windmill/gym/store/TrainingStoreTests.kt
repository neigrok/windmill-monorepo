package works.windmill.gym.store

import kotlin.coroutines.ContinuationInterceptor
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
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
import works.windmill.agent.TurnRefusal
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
import works.windmill.gym.coach.CoachDraft
import works.windmill.gym.coach.CoachExchange
import works.windmill.gym.coach.CoachReceipt
import works.windmill.gym.coach.ConversationRow
import works.windmill.gym.coach.heldConversation
import works.windmill.gym.coach.heldThreads
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.presentation.GymPreferences
import works.windmill.gym.presentation.LastSet
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.presentation.ProposalState
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.Routine
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.domain.sync.ProposeRoutine
import works.windmill.gym.net.FakeGymRest
import works.windmill.sync.core.Json
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.ModelServer
import works.windmill.gym.domain.sync.Exercise as EngineExercise
import works.windmill.gym.domain.sync.Proposal as EngineProposal
import works.windmill.gym.domain.sync.Routine as EngineRoutine
import works.windmill.gym.domain.sync.RoutineEntry as EngineEntry
import works.windmill.gym.domain.sync.SetTarget as EngineTarget

@OptIn(ExperimentalCoroutinesApi::class)
class TrainingStoreTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun script(frames: String) = ScriptedTurns(Json.parse(frames).arr())

    // Virtual time, one dispatcher: the test advances it, and closing the room ends its work.
    private fun TestScope.work() = CoroutineScope(SupervisorJob() + coroutineContext[ContinuationInterceptor] as CoroutineDispatcher)

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
    fun testAProposalMintedInAConversationLandsOnTodayWithoutLeavingTheRoom() = runTest {
        val server = EngineRoomFixture.server()
        val turns = script("""[
            {"event":"text","data":{"delta":"Done — as a proposal on Push A."}},
            {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"propose_routine_change","input":{"id":"proposal1","routineId":"rt_00000001","name":"Push A — heavy",
                "entries":[{"exerciseId":"bench-press","sets":[{"reps":3,"weightKg":87.5},{"reps":3,"weightKg":87.5},{"reps":3,"weightKg":87.5}]}],"summary":"Heavier triples."}}]}},
            {"await":"results","batch":1},
            {"event":"done","data":{"state":"completed"}}]""")
        EngineRoomFixture(tmp.newFolder(), work(), coachServer = turns, mintRoutine = { "rt_00000001" }).use { room ->
            room.select("alice"); room.pull(server)
            room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) }).capturingMovements(room.store.routines.catalog))
            room.sync(server); room.store.refreshEngine()
            assertEquals(emptyList<Proposal>(), room.store.routines.pendingProposals)

            val chat = room.store.coach.freshChat()
            assertTrue(room.store.coach.send(chat, "write the triples block"))
            advanceUntilIdle()
            room.store.conversations.read()
            room.store.refreshEngine()

            val reply = checkNotNull(room.store.coach.exchanges(chat).single().answer)
            assertEquals("Done — as a proposal on Push A.", reply.text)
            assertEquals(listOf("proposal1"), reply.proposals)
            assertEquals(listOf("proposal1"), room.store.routines.pendingProposals.map { it.id })
            assertEquals("the routine reads as it did until the lifter applies", "Push A", room.store.routines.routine("rt_00000001")?.name)
        }
    }

    @Test
    fun testTheReceiptCountsWhatTheTurnReadFromTheLog() = runTest {
        val turns = script("""[{"event":"text","data":{"delta":"three sessions at the same top set."}},{"event":"done","data":{"state":"completed"}}]""")
        EngineRoomFixture(tmp.newFolder(), work(), coachServer = turns).use { room ->
            room.select("alice"); room.sync(EngineRoomFixture.server())
            room.workout()
            val chat = room.store.coach.freshChat()
            assertTrue(room.store.coach.send(chat, "what's stalled?"))
            advanceUntilIdle()
            room.store.conversations.read()
            assertEquals(CoachReceipt(ReadTally(sessions = 1, weeks = 1), truncated = false, created = emptyList()),
                room.store.coach.exchanges(chat).single().answer?.receipt)
        }
    }

    @Test
    fun testEveryCeilingKeepsItsTypedNoticeAQuietLogIsARetryAndAnAbsentRouteTakesTheDoorDown() = runTest {
        val turns = script("[]")
        EngineRoomFixture(tmp.newFolder(), work(), coachServer = turns).use { room ->
            room.select("alice"); room.sync(EngineRoomFixture.server())
            val coach = room.store.coach
            val other = coach.freshChat()
            val chat = coach.freshChat()
            for ((refusal, said) in listOf(
                TurnRefusal(429, "subject_exhausted", null) to CoachTurnRefusal.Allowance("subject_exhausted"),
                TurnRefusal(429, "free_day_exhausted", null) to CoachTurnRefusal.Allowance("free_day_exhausted"),
                TurnRefusal(429, "free_month_exhausted", 1_900_000_000_000L) to CoachTurnRefusal.FreeMonthExhausted(1_900_000_000_000L),
                TurnRefusal(429, TurnRefusal.rateLimited, null) to CoachTurnRefusal.RateLimited,
            )) {
                turns.refuseOpen = refusal
                assertTrue(coach.send(chat, "what's stalled?"))
                advanceUntilIdle()
                assertEquals(said, coach.refusal(chat))
                assertEquals("a cap the server refills stands on every chat", said, coach.refusal(other))
                assertEquals(CoachDraft("what's stalled?"), coach.draft(chat))
                assertFalse(coach.absent)
            }

            turns.refuseOpen = TurnRefusal(500, TurnRefusal.vendorError, null)
            assertTrue(coach.send(chat, "what's stalled?"))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.Said(TurnRefusal.vendorError), coach.refusal(chat))
            assertNull("a quiet server is that chat's to ask again", coach.refusal(other))
            assertEquals(CoachDraft("what's stalled?"), coach.draft(chat))
            assertFalse(coach.absent)

            turns.refuseOpen = TurnRefusal(404, "not-found", null)
            assertTrue(coach.send(chat, "what's stalled?"))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.Absent, coach.refusal(chat))
            assertEquals(CoachTurnRefusal.Absent, coach.refusal(other))
            assertTrue(coach.absent)
        }
    }

    @Test
    fun testHistoryReadsEveryThreadFromTheEngineNewestFirst() = runTest {
        EngineRoomFixture(tmp.newFolder(), work(), coachServer = script("[]")).use { room ->
            room.select("alice")
            val older = room.heldConversation("Bench has been stuck at 82.5. What do you see?", "Hold the load a week.")
            val olderAt = room.now
            room.now += 3_000
            val newer = room.heldConversation("Is my squat volume too low?", "It is fine.")
            val newerAt = room.now

            val conversations = room.store.conversations
            conversations.watchHistory(true)
            conversations.read()
            assertEquals(listOf(
                ConversationRow(newer, "Is my squat volume too low?", newerAt, answerPreview = "It is fine."),
                ConversationRow(older, "Bench has been stuck at 82.5. What do you see?", olderAt, answerPreview = "Hold the load a week."),
            ), room.store.coach.history)

            room.now += 3_000
            val newest = room.heldConversation("And my deadlift?")
            conversations.read()
            assertEquals(listOf(newest, newer, older), room.store.coach.history.map { it.id })
            assertEquals(listOf(older, newer, newest).toSet(), conversations.threads.map { it.id.record.string }.toSet())
        }
    }

    @Test
    fun testAConversationIsReadWholeAndAMissingOneReadsNothing() = runTest {
        EngineRoomFixture(tmp.newFolder(), work(), coachServer = script("[]")).use { room ->
            room.select("alice")
            val thread = room.heldConversation("what's stalled?", "bench, three weeks.")
            val coach = room.store.coach

            coach.selectChat(thread)
            room.store.conversations.read()
            val exchange = coach.exchanges(thread).single()
            assertEquals("what's stalled?", exchange.question)
            assertEquals("bench, three weeks.", exchange.answer?.text)

            coach.selectChat("thr_missing")
            room.store.conversations.read()
            assertEquals(emptyList<CoachExchange>(), coach.exchanges("thr_missing"))
        }
    }

    @Test
    fun testDeletingAThreadPreservesTheAppliedProposal() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), work(), coachServer = script("[]")).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)
            assertTrue(deciding(room, server) { room.store.routines.applyProposal("proposal1") } is ProposalOutcome.Decided)
            val thread = room.heldConversation("write the triples block")

            assertEquals(GymResult.Ok(Unit), room.store.coach.deleteThread(thread))

            val row = room.training.proposal("proposal1")!!
            assertEquals(ProposalState.Applied, row.state)
            assertEquals("the row still says the change came from Coach", "ask", row.source.door)
            assertEquals("and the conversation it opened is gone", emptyList<CoachThread>(), room.heldThreads())
            assertEquals("the program did not move on the delete", 2, room.store.routines.routine(pushA.id)?.revision)
        }
    }

    @Test
    fun testDeletingAConversationThatIsAlreadyGoneSucceedsAndAnythingElseIsSaid() = runTest {
        EngineRoomFixture(tmp.newFolder(), work(), coachServer = script("[]")).use { room ->
            room.select("alice")

            assertEquals(GymResult.Ok(Unit), room.store.coach.deleteThread("thr_gone"))

            val thread = room.heldConversation("what's stalled?")
            room.engine.failNextCommit()
            assertEquals(GymResult.Failed(WriteFailure.NoAnswer), room.store.coach.deleteThread(thread))
            assertEquals(listOf(thread), room.heldThreads().map { it.id.record.string })
        }
    }

    @Test
    fun testAPhoneOnlyDraftListsInHistoryAndDeletesSignedOutWithoutReachingRest() = runTest {
        val rest = FakeGymRest()
        EngineRoomFixture(tmp.newFolder(), work(), rest = rest, coachServer = script("[]")).use { room ->
            room.select(null)
            val coach = room.store.coach
            assertEquals(emptyList<ConversationRow>(), coach.history)
            val id = coach.freshChat("A phone-only draft")
            assertEquals(listOf(ConversationRow(id, "A phone-only draft", coach.chat(id)!!.updatedAtMs)), coach.history)
            assertEquals(GymResult.Ok(Unit), coach.deleteThread(id))
            assertEquals(emptyList<ConversationRow>(), coach.history)
            assertEquals(emptyList<String>(), rest.calls)
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
