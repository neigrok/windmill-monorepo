package works.windmill.gym.store

import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
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
import works.windmill.gym.domain.sync.ProposeWorkout
import works.windmill.gym.domain.sync.WorkoutProposal
import works.windmill.gym.presentation.ChangeKind
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.presentation.ProposalChange
import works.windmill.gym.presentation.ProposalSource
import works.windmill.gym.presentation.ProposalState
import works.windmill.gym.presentation.ProposalTarget
import works.windmill.gym.presentation.ProposalTargets
import works.windmill.gym.presentation.Routine
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.SetTarget
import works.windmill.platform.telemetry.Telemetry
import works.windmill.gym.domain.sync.Exercise as EngineExercise
import works.windmill.gym.domain.sync.RoutineEntry as EngineEntry
import works.windmill.gym.domain.sync.Session as EngineSession
import works.windmill.gym.domain.sync.SetTarget as EngineTarget

class WorkoutProposalsStoreTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private class Telling : Telemetry {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<String>()
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
    }

    private fun Telling.outcomes() = events.filter { it.first == "gym_proposal_outcome" }.map { it.second }

    private fun entry(movement: String, sets: Int = 3, reps: Int = 8, kg: Double? = null) =
        EngineEntry(Id(movement, EngineExercise), List(sets) { EngineTarget(reps, kg) })

    private val pushA = listOf("bench-press", "overhead-press", "incline-dumbbell-press", "cable-fly", "triceps-pushdown")

    private suspend fun open(room: EngineRoomFixture, server: works.windmill.sync.modelserver.ModelServer): Routine {
        room.select("alice"); room.pull(server)
        val draft = pushA.fold(RoutineDraft(name = "Push A")) { held, movement -> held.adding(movement, List(3) { SetTarget(8) }) }
        val routine = (room.store.routines.saveRoutine(draft.capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
        room.sync(server)
        assertTrue(room.store.workout.start(routine.id) is GymResult.Ok)
        room.store.workout.choose("overhead-press")
        room.sync(server)
        room.store.refreshEngine()
        return routine
    }

    // Coach's call on this phone: the executor commits the proposal with its call.
    private fun coachProposes(room: EngineRoomFixture, entries: List<EngineEntry>, id: String = "wp000000000000001", summary: String = "") {
        val runner = ActionRunner(room.engine, room.engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
        val session = room.store.workout.session!!.id
        assertTrue(runner.run(ProposeWorkout(Id(id, WorkoutProposal), Id(session, EngineSession), entries, summary)) is Outcome.Committed)
    }

    // Incline Dumbbell Press out, Dumbbell Floor Press in, at its place: 20 kg each.
    private val swapped get() = listOf(entry("bench-press"), entry("overhead-press"), entry("dumbbell-bench-press", 3, 10, 20.0), entry("cable-fly"), entry("triceps-pushdown"))

    private fun TestScope.finishing() = runCurrent()

    @Test
    fun aChangeCoachProposedReadsAsTheCardAndTheSheetDrawIt() = runTest {
        val server = EngineRoomFixture.server()
        val telling = Telling()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telling).use { room ->
            open(room, server)
            coachProposes(room, swapped)
            room.store.refreshEngine()

            val eight = ProposalTargets(List(3) { SetTarget(8) })
            assertEquals(mapOf("wp000000000000001" to Proposal(
                id = "wp000000000000001", routineId = room.store.workout.session!!.id, changeCount = 2,
                createdAtMs = room.store.workoutProposals.held.getValue("wp000000000000001").createdAtMs,
                source = ProposalSource(door = "ask", connection = "", agent = ""), baseName = "this workout",
                changes = listOf(
                    ProposalChange(1, ChangeKind.Kept, "bench-press", eight, eight),
                    ProposalChange(2, ChangeKind.Kept, "overhead-press", eight, eight),
                    ProposalChange(3, ChangeKind.Added, "dumbbell-bench-press", after = ProposalTargets(List(3) { SetTarget(10, 20.0) })),
                    ProposalChange(4, ChangeKind.Kept, "cable-fly", eight, eight),
                    ProposalChange(5, ChangeKind.Kept, "triceps-pushdown", eight, eight),
                    ProposalChange(6, ChangeKind.Removed, "incline-dumbbell-press", before = eight, loggedSets = 0),
                ),
                target = ProposalTarget.Workout,
            )), room.store.workoutProposals.held)
            assertEquals(emptyList<Map<String, String>>(), telling.outcomes())
            finishing()
        }
    }

    @Test
    fun applyRewritesTheRunningPlanAndTheWalkAtOnceAndTheLogConfirmsIt() = runTest {
        val server = EngineRoomFixture.server()
        val telling = Telling()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telling).use { room ->
            val routine = open(room, server)
            coachProposes(room, swapped)
            room.sync(server); room.store.refreshEngine()

            val decided = room.store.workoutProposals.apply("wp000000000000001")

            assertEquals(ProposalState.Applied, (decided as ProposalOutcome.Decided).proposal.state)
            assertEquals("Applied · this workout · 2 changes", decided.proposal.receipt)
            assertEquals(listOf("bench-press", "overhead-press", "dumbbell-bench-press", "cable-fly", "triceps-pushdown"),
                room.store.workout.session!!.plan!!.entries.map { it.exerciseId })
            assertEquals(listOf("bench-press", "overhead-press", "dumbbell-bench-press", "cable-fly", "triceps-pushdown"), room.store.workout.order)
            assertEquals("overhead-press", room.store.workout.exerciseId)
            assertEquals("no routine moved", pushA, room.store.routines.routine(routine.id)!!.entries.map { it.exerciseId })
            assertEquals("the event waits for the log's answer", emptyList<Map<String, String>>(), telling.outcomes())

            room.sync(server); room.store.refreshEngine()

            assertEquals(ProposalState.Applied, room.store.workoutProposals.held.getValue("wp000000000000001").state)
            assertEquals(listOf(mapOf("target" to "workout", "action" to "apply", "outcome" to "decided")), telling.outcomes())
            assertEquals(emptyList<String>(), telling.failures)
            finishing()
        }
    }

    @Test
    fun applyStandsTheLifterOnWhatReplacedTheMovementInHandWithItsTargetsOnTheRack() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            open(room, server)
            room.store.workout.choose("incline-dumbbell-press")
            coachProposes(room, swapped)
            room.store.refreshEngine()

            assertTrue(room.store.workoutProposals.apply("wp000000000000001") is ProposalOutcome.Decided)

            assertEquals("dumbbell-bench-press", room.store.workout.exerciseId)
            assertEquals(20.0, room.store.workout.rack!!.weightKg, 0.0)
            assertEquals(10, room.store.workout.rack!!.reps)
            assertEquals(List(3) { SetTarget(10, 20.0) }, room.store.workout.planEntry!!.sets)
            finishing()
        }
    }

    @Test
    fun applyWorksWithNoConnectionAndWaitsForTheLogToConfirm() = runTest {
        val server = EngineRoomFixture.server()
        val telling = Telling()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telling).use { room ->
            open(room, server)
            coachProposes(room, swapped)
            room.store.refreshEngine()

            assertTrue(room.store.workoutProposals.apply("wp000000000000001") is ProposalOutcome.Decided)

            assertEquals("dumbbell-bench-press", room.store.workout.order[2])
            assertEquals("the decision is queued behind everything else this phone holds", "gym.applyWorkoutProposal",
                room.outbox().last()["intent"]?.get("cmd")?.get("name")?.str())
            assertEquals(emptyList<Map<String, String>>(), telling.outcomes())
            finishing()
        }
    }

    @Test
    fun turningItDownLeavesThePlanAsItStood() = runTest {
        val server = EngineRoomFixture.server()
        val telling = Telling()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telling).use { room ->
            open(room, server)
            coachProposes(room, swapped)
            room.sync(server); room.store.refreshEngine()

            val decided = room.store.workoutProposals.dismiss("wp000000000000001")

            assertEquals(ProposalState.Dismissed, (decided as ProposalOutcome.Decided).proposal.state)
            assertEquals("Turned down · nothing changed.", decided.proposal.receipt)
            assertEquals(pushA, room.store.workout.session!!.plan!!.entries.map { it.exerciseId })
            assertEquals(pushA, room.store.workout.order)
            room.sync(server); room.store.refreshEngine()
            assertEquals(listOf(mapOf("target" to "workout", "action" to "dismiss", "outcome" to "decided")), telling.outcomes())
            finishing()
        }
    }

    // Logged movements stay immutable: a set logged since the suggestion takes Apply away and the card says which movement.
    @Test
    fun aMovementLoggedSinceMakesItOutOfDateAndTheLogsWordsAreTheCards() = runTest {
        val server = EngineRoomFixture.server()
        val telling = Telling()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telling).use { room ->
            open(room, server)
            coachProposes(room, swapped)
            room.store.refreshEngine()
            assertNull(room.store.workoutProposals.held.getValue("wp000000000000001").outOfDate)

            room.store.workout.choose("incline-dumbbell-press")
            room.store.workout.logSet(20.0, 8)
            room.store.refreshEngine()

            val line = "You logged Incline Dumbbell Press since this suggestion. Nothing was applied."
            val standing = room.store.workoutProposals.held.getValue("wp000000000000001")
            assertEquals(line, standing.outOfDate)
            assertEquals(ProposalState.Pending, standing.state)
            assertEquals(1, standing.changes.single { it.kind == ChangeKind.Removed }.loggedSets)

            assertEquals(ProposalOutcome.Moved(line), room.store.workoutProposals.apply("wp000000000000001"))

            assertEquals(pushA, room.store.workout.session!!.plan!!.entries.map { it.exerciseId })
            assertEquals(listOf(mapOf("target" to "workout", "action" to "apply", "outcome" to "moved")), telling.outcomes())
            assertEquals(emptyList<String>(), telling.failures)
            finishing()
        }
    }

    @Test
    fun aFinishedWorkoutsProposalSaysSo() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            open(room, server)
            coachProposes(room, swapped)
            room.store.workout.logSet(40.0, 5)
            room.store.workout.finish()
            room.store.refreshEngine()

            assertEquals("This workout has finished. Nothing was applied.", room.store.workoutProposals.held.getValue("wp000000000000001").outOfDate)
            finishing()
        }
    }

    @Test
    fun aDecisionOnAProposalThePhoneDoesNotHoldIsGoneAndReportedSo() = runTest {
        val server = EngineRoomFixture.server()
        val telling = Telling()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telling).use { room ->
            open(room, server)

            assertEquals(ProposalRead.Gone, room.store.workoutProposals.proposal("wp000000000000009"))
            assertEquals(ProposalOutcome.Gone("that proposal is no longer on the log"), room.store.workoutProposals.apply("wp000000000000009"))
            assertEquals(listOf(mapOf("target" to "workout", "action" to "apply", "outcome" to "gone")), telling.outcomes())
            finishing()
        }
    }

    // Signed out a proposal is still on this phone; deciding it takes an account, as a routine's does.
    @Test
    fun signedOutTheDecisionAsksForTheAccountAndNothingMoves() = runTest {
        val telling = Telling()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telling).use { room ->
            room.select(null)
            val draft = pushA.fold(RoutineDraft(name = "Push A")) { held, movement -> held.adding(movement, List(3) { SetTarget(8) }) }
            val routine = (room.store.routines.saveRoutine(draft.capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
            assertTrue(room.store.workout.start(routine.id) is GymResult.Ok)
            coachProposes(room, swapped)
            room.store.refreshEngine()

            assertEquals(ProposalOutcome.Failed(WriteFailure.Refused("Sign in again to decide this proposal.")), room.store.workoutProposals.apply("wp000000000000001"))

            assertEquals(pushA, room.store.workout.session!!.plan!!.entries.map { it.exerciseId })
            assertEquals(ProposalState.Pending, room.store.workoutProposals.held.getValue("wp000000000000001").state)
            assertEquals(listOf(mapOf("target" to "workout", "action" to "apply", "outcome" to "failed")), telling.outcomes())
            assertEquals(emptyList<String>(), telling.failures)
            finishing()
        }
    }

    @Test
    fun anotherSeatReadsNoneOfThem() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            open(room, server)
            coachProposes(room, swapped)
            room.store.refreshEngine()
            assertEquals(setOf("wp000000000000001"), room.store.workoutProposals.held.keys)

            room.select("bob")

            assertEquals(emptyMap<String, Proposal>(), room.store.workoutProposals.held)
            finishing()
        }
    }
}
