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
import works.windmill.gym.domain.sync.Prefill
import works.windmill.gym.presentation.ProposalState
import works.windmill.gym.presentation.Routine
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.RoutineEntry
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.domain.sync.ProposeRoutine
import works.windmill.sync.core.Json
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.ModelServer
import works.windmill.gym.domain.sync.Exercise as EngineExercise
import works.windmill.gym.domain.sync.Proposal as EngineProposal
import works.windmill.gym.domain.sync.Routine as EngineRoutine
import works.windmill.gym.domain.sync.RoutineEntry as EngineEntry
import works.windmill.gym.domain.sync.SetTarget as EngineTarget

class RoutinesStoreTests {
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
    fun testSignedOutARoutineIsSavedStartedFromAndExplicitlyEdited() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)

            val kept = (room.store.routines.saveRoutine(RoutineDraft(name = "Push Day")
                .adding("bench-press").targeting("bench-press", List(2) { SetTarget(5, 100.0) }).capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
            assertTrue(kept.id.startsWith("rt_"))
            assertEquals(listOf("Push Day"), room.store.routines.all.map { it.name })

            val opened = (room.store.workout.start(routineId = kept.id) as GymResult.Ok).value
            assertEquals("Push Day", opened.plan?.routine)
            room.store.workout.choose("bench-press")
            assertEquals("the prefill dials the routine's plan", Prefill(100.0, 5), room.store.workout.prefill)

            assertEquals("the saved routine carries every target",
                listOf(SetTarget(5, 100.0), SetTarget(5, 100.0)), kept.entries.first().sets)
            assertTrue(room.store.routines.saveRoutine(RoutineDraft.of(kept)
                .targeting("bench-press", List(2) { SetTarget(5, 105.0) }).capturingMovements(room.store.routines.catalog)) is GymResult.Ok)
            assertEquals(listOf(SetTarget(5, 105.0), SetTarget(5, 105.0)),
                room.store.routines.all.first { it.id == kept.id }.entries.first().sets)
            assertEquals("and the phone's replica holds the edited document",
                listOf(SetTarget(5, 105.0), SetTarget(5, 105.0)),
                room.training.routine(kept.id)?.entries?.first()?.sets)
            runCurrent()
        }
    }

    @Test
    fun testAMovementThatWasNotCreatedSaysWhyAndIsNotDrawn() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())
            room.store.routines.create("Sled Push", "machine", id = "ex_taken")
            val before = room.store.routines.catalog

            val why = (room.store.routines.create("Zercher Squat", "barbell", id = "ex_taken") as? GymResult.Failed)?.why
            assertEquals("a refused create is not a movement",
                WriteFailure.Refused("already saved as Sled Push (machine) — choose it from the movement list"), why)
            assertFalse(room.store.routines.catalog.any { it.name == "Zercher Squat" })

            val made = (room.store.routines.create("Zercher Squat", "barbell") as? GymResult.Ok)?.value
            assertEquals("the second attempt lands", "Zercher Squat", made?.name)
            assertEquals(before + made, room.store.routines.catalog)
            runCurrent()
        }
    }

    @Test
    fun testTheCardArrivesOnTheRoutineTheReadAlreadyMakes() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            assertEquals(listOf("proposal1"), room.store.routines.pendingProposals.map { it.id })
            assertEquals("Coach", room.store.routines.pendingProposals.single().source.name)
            assertEquals("proposal1", room.store.routines.routine(pushA.id)?.pendingProposal?.id)
            runCurrent()
        }
    }

    @Test
    fun testASignedOutRoomHasNoProposalsAndDecidesNone() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            pushAWaitingOnADiff(room, server)
            room.select(null)
            room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", listOf(SetTarget(5, 82.5))).capturingMovements(room.store.routines.catalog))

            assertTrue("the phone's own routine wears no card",
                room.store.routines.all.isNotEmpty() && room.store.routines.all.all { it.pendingProposal == null })
            assertTrue(room.store.routines.pendingProposals.isEmpty())
            val before = owed(room)

            assertEquals(ProposalOutcome.Failed(WriteFailure.Refused("Sign in again to decide this proposal.")),
                room.store.routines.applyProposal("proposal1"))
            assertEquals("nothing was written", before, owed(room))
            runCurrent()
        }
    }

    @Test
    fun testNothingMovesUntilTheTapAndThenTheLogsOwnRoutineLands() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            assertEquals("Push A", room.store.routines.routine(pushA.id)?.name)
            assertEquals(1, room.store.routines.routine(pushA.id)?.revision)

            val decided = deciding(room, server) { room.store.routines.applyProposal("proposal1") }

            assertTrue(decided is ProposalOutcome.Decided)
            assertEquals(ProposalState.Applied, (decided as ProposalOutcome.Decided).proposal.state)
            assertEquals("Push A — heavy", room.store.routines.routine(pushA.id)?.name)
            assertEquals(2, room.store.routines.routine(pushA.id)?.revision)
            assertEquals("and the diff itself landed, not only the name",
                listOf(RoutineEntry(position = 1, exerciseId = "bench-press", sets = List(5) { SetTarget(3, 87.5) })),
                room.store.routines.routine(pushA.id)?.entries)
            assertTrue("the card goes because the decision was taken", room.store.routines.pendingProposals.isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testADecisionTakenOnAnotherSurfaceRedrawsTheProgramHere() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)
            assertEquals(listOf("proposal1"), room.store.routines.pendingProposals.map { it.id })
            anotherPhone(server, room.now) { phone ->
                assertTrue(deciding(phone, server) { phone.store.routines.applyProposal("proposal1") } is ProposalOutcome.Decided)
            }

            val refused = deciding(room, server) { room.store.routines.dismissProposal("proposal1") }

            assertEquals(ProposalOutcome.Settled("That proposal has already been decided."), refused)
            assertTrue("the card goes with the decision it was waiting for", room.store.routines.pendingProposals.isEmpty())
            assertEquals("and the routine is the one the log now holds", "Push A — heavy",
                room.store.routines.routine(pushA.id)?.name)
            assertEquals(2, room.store.routines.routine(pushA.id)?.revision)
            assertEquals(
                listOf(RoutineEntry(position = 1, exerciseId = "bench-press", sets = List(5) { SetTarget(3, 87.5) })),
                room.store.routines.routine(pushA.id)?.entries)
            runCurrent()
        }
    }

    @Test
    fun testAMidSessionSaveSupersedesTheDiffAndTheTapIsRefused() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            assertTrue(room.store.routines.saveRoutine(RoutineDraft.of(pushA)
                .targeting("bench-press", List(5) { SetTarget(5, 87.5) }).capturingMovements(room.store.routines.catalog)) is GymResult.Ok)
            room.sync(server); room.store.refreshEngine()
            assertEquals("the log moved the revision under the diff", 2, room.store.routines.routine(pushA.id)?.revision)

            val refused = deciding(room, server) { room.store.routines.applyProposal("proposal1") }

            assertEquals("the log's own sentence, as sent",
                ProposalOutcome.Moved("That proposal has been replaced."), refused)
            assertEquals("the routine was re-read, not argued with", 2, room.store.routines.routine(pushA.id)?.revision)
            assertTrue(room.store.routines.pendingProposals.isEmpty())
            assertEquals("the lifter's own 87.5 stands, and the triples the diff wanted never landed",
                List(5) { SetTarget(5, 87.5) }, room.store.routines.routine(pushA.id)?.entries?.first()?.sets)
            assertEquals("set aside by the save rather than applied", ProposalState.Superseded,
                room.training.proposal("proposal1")?.state)
            runCurrent()
        }
    }

    @Test
    fun testTheStoreNamesTheProposalsTheLogWouldRefuseToApply() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)
            assertEquals(1, room.store.routines.pendingProposals.single().baseRevision)
            assertEquals(emptySet<String>(), room.store.routines.outOfDateProposals)

            assertTrue(room.store.routines.saveRoutine(RoutineDraft.of(pushA)
                .targeting("bench-press", List(5) { SetTarget(5, 87.5) }).capturingMovements(room.store.routines.catalog)) is GymResult.Ok)
            room.store.refreshEngine()
            assertEquals("an edit the log has not confirmed already dates the diff", setOf("proposal1"), room.store.routines.outOfDateProposals)

            room.sync(server); room.store.refreshEngine()
            assertEquals(2, room.store.routines.routine(pushA.id)?.revision)
            assertEquals("and so does the revision the log counted", setOf("proposal1"), room.store.routines.outOfDateProposals)
            runCurrent()
        }
    }

    @Test
    fun testDismissTakesTheCardAndTouchesNothingElse() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            val decided = deciding(room, server) { room.store.routines.dismissProposal("proposal1") }

            assertEquals(ProposalState.Dismissed, (decided as ProposalOutcome.Decided).proposal.state)
            assertTrue(room.store.routines.pendingProposals.isEmpty())
            assertEquals("the routine did not move", 1, room.store.routines.routine(pushA.id)?.revision)
            assertEquals("Push A", room.store.routines.routine(pushA.id)?.name)
            assertEquals(ProposalState.Dismissed, room.training.proposal("proposal1")?.state)
            runCurrent()
        }
    }

    // A decision the rules refuse is reported as refused, never as the other decision taken first: here the movement
    // became a barbell after Coach asked an assisted load of it, so the load floor refuses the Apply.
    @Test
    fun testAnApplyTheLoadFloorRefusesIsReportedRefused() = runTest {
        val server = EngineRoomFixture.server()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : works.windmill.platform.telemetry.Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {}
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select("alice"); room.pull(server)
            val pushA = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) }).capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
            room.sync(server)
            anotherPhone(server, room.now) { coach ->
                val runner = ActionRunner(coach.engine, coach.engine.registry, FixedZone(0),
                    object : ActionContext { override var insideRun = false })
                val bench = works.windmill.gym.domain.sync.SeedExercises.all.single { it.id.record.toString() == "bench-press" }
                assertTrue(runner.run(works.windmill.gym.domain.sync.EditExercise(bench, bench.name, "machine", 1)) is Outcome.Committed)
                assertTrue(runner.run(ProposeRoutine(Id("proposal1", EngineProposal), Id(pushA.id, EngineRoutine), "Push A",
                    listOf(EngineEntry(Id("bench-press", EngineExercise), listOf(EngineTarget(5, -10.0)))), "Assisted.")) is Outcome.Committed)
                assertTrue(runner.run(works.windmill.gym.domain.sync.EditExercise(bench.copy(equipment = "machine"), bench.name, "barbell", 1)) is Outcome.Committed)
                coach.sync(server)
            }
            room.pull(server); room.store.refreshEngine()
            events.clear()

            val refused = deciding(room, server) { room.store.routines.applyProposal("proposal1") }

            assertEquals(ProposalOutcome.Refused("Load, 0 or more."), refused)
            assertEquals(listOf("gym_proposal_outcome" to mapOf("action" to "apply", "outcome" to "refused")),
                events.filter { it.first == "gym_proposal_outcome" })
            assertEquals(ProposalState.Pending, room.training.proposal("proposal1")?.state)
            runCurrent()
        }
    }

    @Test
    fun testDecidingWhatWasAlreadyDecidedTheOtherWayIsTerminal() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            pushAWaitingOnADiff(room, server)
            assertTrue(deciding(room, server) { room.store.routines.dismissProposal("proposal1") } is ProposalOutcome.Decided)

            assertEquals(ProposalOutcome.Settled("That proposal has already been decided."),
                deciding(room, server) { room.store.routines.applyProposal("proposal1") })
            assertTrue(deciding(room, server) { room.store.routines.dismissProposal("proposal1") } is ProposalOutcome.Decided)
            runCurrent()
        }
    }

    @Test
    fun testARemovalTappedTwiceLeavesTheProgramTellingTheTruth() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server, removing = true)
            val receipt = room.store.routines.pendingProposals.single().copy(state = ProposalState.Applied)
            // Another surface taps Apply and the log takes the removal.
            anotherPhone(server, room.now) { phone ->
                assertEquals(ProposalOutcome.Decided(receipt),
                    deciding(phone, server) { phone.store.routines.applyProposal("proposal1") })
                assertNull(phone.store.routines.routine(pushA.id))
            }
            assertEquals(pushA.id, room.store.routines.routine(pushA.id)?.id)

            val again = deciding(room, server) { room.store.routines.applyProposal("proposal1") }

            assertEquals("the log accepts the same removal again", ProposalOutcome.Decided(receipt), again)
            assertNull("the program reflects the confirmed removal", room.store.routines.routine(pushA.id))
            assertNull(room.training.routine(pushA.id))
            assertEquals(mapOf(receipt.id to receipt), room.store.routines.unseenRemovalReceipts)
            assertEquals(mapOf(receipt.id to receipt), room.training.removalReceipts())
            assertTrue(room.outbox().isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testAnUnreachableLogLeavesTheCardExactlyWhereItWas() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            val decision = async { room.store.routines.applyProposal("proposal1") }
            runCurrent(); advanceTimeBy(15_001); runCurrent()

            assertEquals(ProposalOutcome.Failed(WriteFailure.NoAnswer), decision.await())
            room.store.refreshEngine()
            assertEquals("proposal1", room.store.routines.routine(pushA.id)?.pendingProposal?.id)
            assertEquals(ProposalState.Pending, room.training.proposal("proposal1")?.state)
            runCurrent()
        }
    }

    @Test
    fun testAProposalThatIsNotThereIsOneFactAndNotAnError() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(EngineRoomFixture.server())

            assertEquals(ProposalOutcome.Gone("that proposal is no longer on the log"),
                room.store.routines.applyProposal("proposal_gone"))
            assertEquals(ProposalRead.Gone, room.store.routines.proposal("proposal_gone"))
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
            assertEquals("proposalNew", room.store.routines.routine(pushA.id)?.pendingProposal?.id)

            deciding(room, server) { room.store.routines.dismissProposal("proposalOld") }

            assertEquals("proposalNew", room.store.routines.routine(pushA.id)?.pendingProposal?.id)
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

            val saved = (room.store.routines.saveRoutine(draft.capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value

            assertEquals("the name is trimmed and never blank", "Heavy Thursday", saved.name)
            val lines = listOf(
                RoutineEntry(position = 1, exerciseId = "back-squat", sets = List(5) { SetTarget(3, 110.0) }),
                RoutineEntry(position = 2, exerciseId = "barbell-row"))
            assertEquals(lines, saved.entries.sortedBy { it.position })
            assertTrue("an open row stays open", saved.entries.single { it.exerciseId == "barbell-row" }.isOpen)
            assertTrue("it is on the list the moment it lands", room.store.routines.all.any { it.id == saved.id })
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
                room.store.routines.saveRoutine(RoutineDraft(name = "   ").adding("back-squat")))
            assertEquals(GymResult.Failed(WriteFailure.Refused("a routine needs at least one movement")),
                room.store.routines.saveRoutine(RoutineDraft(name = "Heavy Thursday")))
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

            saved = (room.store.routines.saveRoutine(RoutineDraft(name = "Heavy Thursday")
                .adding("deadlift")) as GymResult.Ok).value

            assertEquals(listOf("Heavy Thursday"), room.store.routines.all.map { it.name })
            runCurrent()
            snapshot = room.engine.snapshot(); clock = room.now
        }

        EngineRoomFixture(folder, backgroundScope, snapshot).use { relaunched ->
            relaunched.now = clock; relaunched.engine.start()
            relaunched.select(null)
            assertEquals(listOf(saved.id), relaunched.store.routines.all.map { it.id })
            assertTrue(relaunched.store.routines.all.single().entries.single().isOpen)
            runCurrent()
        }
    }

    @Test
    fun testRenamingARoutineIsTheWholeDocumentAndSupersedesAPendingProposal() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server)

            val renamed = (room.store.routines.saveRoutine(
                RoutineDraft.of(room.store.routines.routine(pushA.id)!!).named("Heavy Thursday")) as GymResult.Ok).value

            assertEquals("Heavy Thursday", renamed.name)
            assertEquals("the same routine, not a fork", pushA.id, renamed.id)
            room.sync(server); room.store.refreshEngine()
            assertEquals(2, room.store.routines.routine(pushA.id)?.revision)
            assertEquals("Heavy Thursday", room.store.routines.routine(pushA.id)?.name)
            assertEquals("its lines came through untouched",
                listOf("bench-press"), room.store.routines.routine(pushA.id)?.entries?.map { it.exerciseId })
            assertEquals(ProposalState.Superseded, room.training.proposal("proposal1")?.state)
            runCurrent()
        }
    }

    @Test
    fun testADroppedSignedOutRoutineLeavesAndItsSessionsKeepTheirSets() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val kept = (room.store.routines.saveRoutine(RoutineDraft(name = "Push Day")
                .adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 100.0) }).capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
            val opened = (room.store.workout.start(routineId = kept.id) as GymResult.Ok).value
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 100.0, reps = 5)
            room.now += 60_000
            room.store.workout.finish()
            runCurrent()

            assertNull("the drop is a success", room.store.routines.dropRoutine(kept.id))

            assertEquals(emptyList<Routine>(), room.store.routines.all)
            assertEquals("the phone let go of the document", emptyList<Routine>(), room.training.program())
            val past = room.training.session(opened.id)!!
            assertEquals("the session run under it keeps every set", listOf(100.0), past.sets.map { it.weightKg })
            assertEquals(kept.id, past.session.routineId)
            assertEquals("the frozen plan is a copy, not a reference, and it stays",
                "Push Day", past.session.plan?.routine)

            assertNull("a routine this phone never held is already not there", room.store.routines.dropRoutine("rt_account"))
            runCurrent()
        }
    }

    @Test
    fun testADroppedAccountRoutineLeavesTheProgramAndTheLogFollows() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val pushA = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) }).capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
            room.sync(server); room.store.refreshEngine()

            assertNull(room.store.routines.dropRoutine(pushA.id))

            assertEquals(emptyList<Routine>(), room.store.routines.all)
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
            val pushA = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")
                .targeting("bench-press", List(5) { SetTarget(5, 82.5) }).capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
            room.sync(server); room.store.refreshEngine()
            assertEquals(listOf(pushA.id), room.store.routines.all.map { it.id })
            anotherPhone(server, room.now) { phone ->
                assertNull(phone.store.routines.dropRoutine(pushA.id))
                phone.sync(server)
            }

            assertNull("asked for it not to be there, and it is not there", room.store.routines.dropRoutine(pushA.id))
            assertEquals("the list lets go without a second read", emptyList<Routine>(), room.store.routines.all)
            room.sync(server); room.store.refreshEngine()
            assertTrue("nothing to say out loud about a wish already granted",
                room.engine.snapshot().member("replicas").arr().none { it["notices"] != null })
            assertTrue(room.store.workout.refusals.isEmpty())
            runCurrent()
        }
    }

    @Test
    fun testACreatedMovementCarriesTheLoadingTheLifterPicked() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)

            val made = (room.store.routines.create("Hammer row", "machine") as GymResult.Ok).value

            assertEquals("machine", made.equipment)
            assertEquals("Hammer row", made.name)
            assertTrue("a movement the lifter minted is tagged as theirs", made.custom)
            room.sync(server)
            assertEquals("machine", anotherPhone(server, room.now) { phone ->
                phone.store.routines.catalog.single { it.id == made.id }.equipment })

            room.select(null)
            val local = (room.store.routines.create("Sled push", "bodyweight") as GymResult.Ok).value
            assertEquals("bodyweight", local.equipment)
            runCurrent()
        }
    }

    @Test
    fun testASignedOutRoutineTracksItsLastWorkoutAndClearsItOnDiscard() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val routine = (room.store.routines.saveRoutine(RoutineDraft(name = "Heavy Thursday")
                .adding("deadlift")) as GymResult.Ok).value

            assertNull(room.store.routines.all.single().lastTrainedAtMs)

            room.store.workout.start(routine.id)
            room.store.workout.choose("deadlift")
            room.store.workout.logSet(weightKg = 140.0, reps = 5)
            room.store.workout.finish()
            runCurrent()
            room.store.refreshEngine()

            assertNotNull("a session ran under it, and the phone can see that",
                room.store.routines.all.single().lastTrainedAtMs)
            assertEquals(room.store.history.allSessions.single().startedAtMs, room.store.routines.all.single().lastTrainedAtMs)

            assertTrue(room.store.workout.discard(room.store.history.allSessions.single().id))
            runCurrent()
            room.store.refreshEngine()
            assertNull(room.store.routines.all.single().lastTrainedAtMs)
            runCurrent()
        }
    }

    @Test
    fun testAnAppliedRemovalTakesTheRoutineOffTheProgram() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val pushA = pushAWaitingOnADiff(room, server, removing = true)
            assertEquals(1, room.store.routines.all.size)

            val decided = deciding(room, server) { room.store.routines.applyProposal("proposal1") }

            assertTrue(decided is ProposalOutcome.Decided)
            assertNull(room.store.routines.routine(pushA.id))
            assertTrue(room.store.routines.all.isEmpty())
            assertTrue(room.store.routines.pendingProposals.isEmpty())
            runCurrent()
        }
    }
}
