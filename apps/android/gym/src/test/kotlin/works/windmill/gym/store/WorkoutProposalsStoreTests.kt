package works.windmill.gym.store

import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Runnable
import kotlinx.coroutines.launch
import kotlinx.coroutines.newSingleThreadContext
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.spelled
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
import works.windmill.gym.presentation.SetWrite
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineClock
import works.windmill.sync.engine.Reply
import works.windmill.sync.engine.SyncResponse
import works.windmill.sync.schema.SyncSchema
import works.windmill.gym.domain.sync.Exercise as EngineExercise
import works.windmill.gym.domain.sync.RoutineEntry as EngineEntry
import works.windmill.gym.domain.sync.Session as EngineSession
import works.windmill.gym.domain.sync.SetTarget as EngineTarget

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
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
                source = ProposalSource(door = "ask", connection = "", agent = ""),
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
            assertEquals("this workout", room.store.workoutProposals.held.getValue("wp000000000000001").routineNamed.spelled())
            assertEquals(emptyList<Map<String, String>>(), telling.outcomes())
            finishing()
        }
    }

    // The commit leaves the caller's thread, and what a screen reads next still holds it: the outcome the call returns, the card, the running plan and the walk. A read begun before the commit and landing after it is turned away by its revision, and publishes nothing older.
    @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class, kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun aDecisionCommitsOnStorageAndNothingAScreenReadsNextIsOlderThanIt() = runTest {
        val server = EngineRoomFixture.server()
        val askedOn = java.util.concurrent.CopyOnWriteArrayList<String>()
        val clock = object : EngineClock { override fun now(): Long { askedOn += Thread.currentThread().name; return 1_800_000_000_000L } }
        newSingleThreadContext("coach-storage").use { storage ->
            EngineRoomFixture(tmp.newFolder(), backgroundScope, coachStorage = storage,
                createEngine = { held, _ -> Engine.memory(SyncSchema.registry, held, clock = clock, intentResultWrites = EngineTraining.intentResultWrites, pendingDeviceWork = WorkoutImports.pendingDeviceWork, rewriteDeviceValue = WorkoutImports.rewriteDeviceValue) }).use { room ->
                open(room, server)
                coachProposes(room, swapped)
                room.sync(server); room.store.refreshEngine()

                val earlier = object : CoroutineDispatcher() {
                    val held = ArrayDeque<Runnable>()
                    override fun dispatch(context: CoroutineContext, block: Runnable) { held += block }
                    fun runHeld() { while (held.isNotEmpty()) held.removeFirst().run() }
                }
                val landing = launch(earlier) { room.store.workoutProposals.read() }
                earlier.runHeld()
                runCurrent()
                assertEquals(false, landing.isCompleted)

                askedOn.clear()
                val decided = room.store.workoutProposals.apply("wp000000000000001")
                val committing = askedOn.filter { it.startsWith("coach-storage") }
                assertTrue(committing.isNotEmpty())
                assertEquals("every read this asks for comes after its commit", committing, askedOn.take(committing.size))
                assertEquals(ProposalState.Applied, (decided as ProposalOutcome.Decided).proposal.state)
                assertEquals(ProposalState.Applied, room.store.workoutProposals.held.getValue("wp000000000000001").state)
                assertEquals(listOf("bench-press", "overhead-press", "dumbbell-bench-press", "cable-fly", "triceps-pushdown"), room.store.workout.order)

                while (!landing.isCompleted) { earlier.runHeld(); runCurrent() }
                assertEquals(ProposalState.Applied, room.store.workoutProposals.held.getValue("wp000000000000001").state)
                finishing()
            }
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
            assertEquals("Applied · this workout · 2 changes", decided.proposal.settledReceipt?.words.spelled())
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
            assertEquals("Turned down · nothing changed.", decided.proposal.settledReceipt?.words.spelled())
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
            assertNull(room.store.workoutProposals.held.getValue("wp000000000000001").stale)

            room.store.workout.choose("incline-dumbbell-press")
            room.store.workout.logSet(20.0, 8)
            room.store.refreshEngine()

            val line = "You logged Incline Dumbbell Press since this suggestion. Nothing was applied."
            val standing = room.store.workoutProposals.held.getValue("wp000000000000001")
            assertEquals(line, standing.staleWhy.spelled())
            assertEquals(ProposalState.Pending, standing.state)
            assertEquals(1, standing.changes.single { it.kind == ChangeKind.Removed }.loggedSets)

            assertEquals(line, (room.store.workoutProposals.apply("wp000000000000001") as ProposalOutcome.Moved).words.spelled())

            assertEquals(pushA, room.store.workout.session!!.plan!!.entries.map { it.exerciseId })
            assertEquals(listOf(mapOf("target" to "workout", "action" to "apply", "outcome" to "moved")), telling.outcomes())
            assertEquals(emptyList<String>(), telling.failures)
            finishing()
        }
    }

    // Another phone logged the movement before this one's Apply reached the log: the decision comes back, and the plan and the walk with it.
    @Test
    fun aDecisionTheLogRefusesComesBackWithThePlanAndTheWalk() = runTest {
        val server = EngineRoomFixture.server()
        val telling = Telling()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telling).use { room ->
            open(room, server)
            coachProposes(room, swapped)
            room.sync(server); room.store.refreshEngine()
            val session = room.store.workout.session!!.id
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
                other.now = room.now
                other.select("alice"); other.pull(server)
                other.training.appendSet(session, SetWrite("set_other_phone1", "incline-dumbbell-press", 20.0, 8, room.now - 1_000))
                other.sync(server)
            }

            assertTrue(room.store.workoutProposals.apply("wp000000000000001") is ProposalOutcome.Decided)
            assertEquals("dumbbell-bench-press", room.store.workout.order[2])

            room.sync(server); room.store.refreshEngine()

            assertEquals(pushA, room.store.workout.session!!.plan!!.entries.map { it.exerciseId })
            assertEquals(pushA, room.store.workout.order)
            assertEquals("You logged Incline Dumbbell Press since this suggestion. Nothing was applied.",
                room.store.workoutProposals.held.getValue("wp000000000000001").staleWhy.spelled())
            assertEquals(listOf(mapOf("target" to "workout", "action" to "apply", "outcome" to "failed")), telling.outcomes())
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

            assertEquals("This workout has finished. Nothing was applied.", room.store.workoutProposals.held.getValue("wp000000000000001").staleWhy.spelled())
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
            assertEquals("that proposal is no longer on the log", (room.store.workoutProposals.apply("wp000000000000009") as ProposalOutcome.Gone).words.spelled())
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

            assertEquals("Sign in to review this proposal.",
                ((room.store.workoutProposals.apply("wp000000000000001") as ProposalOutcome.Failed).why as WriteFailure.Refused).words.spelled())

            assertEquals(pushA, room.store.workout.session!!.plan!!.entries.map { it.exerciseId })
            assertEquals(ProposalState.Pending, room.store.workoutProposals.held.getValue("wp000000000000001").state)
            assertEquals(listOf(mapOf("target" to "workout", "action" to "apply", "outcome" to "failed")), telling.outcomes())
            assertEquals(emptyList<String>(), telling.failures)
            finishing()
        }
    }

    // A session that lapsed is a door this phone has already used, and it keeps saying so.
    @Test
    fun aLapsedSessionAsksToSignInAgainAndNothingMoves() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            open(room, server)
            coachProposes(room, swapped)
            room.store.refreshEngine()
            room.push(Reply.Answer(SyncResponse(401, null)))
            assertTrue(room.engine.status.state.value.authPaused)

            assertEquals("Sign in again to decide this proposal.",
                ((room.store.workoutProposals.apply("wp000000000000001") as ProposalOutcome.Failed).why as WriteFailure.Refused).words.spelled())
            assertEquals(pushA, room.store.workout.session!!.plan!!.entries.map { it.exerciseId })
            finishing()
        }
    }

    // A pure reorder changes no line, and its count rests on the plan it moved: the card, the receipt before the log answers and the receipt after say one number.
    @Test
    fun aReorderSaysTheSameCountBeforeAndAfterItsApply() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            open(room, server)
            coachProposes(room, listOf(entry("cable-fly"), entry("bench-press"), entry("overhead-press"), entry("incline-dumbbell-press"), entry("triceps-pushdown")))
            room.store.refreshEngine()
            val pending = room.store.workoutProposals.held.getValue("wp000000000000001")
            assertEquals("1 change", pending.counting.spelled())
            assertEquals("Apply", pending.applying.spelled())

            val decided = room.store.workoutProposals.apply("wp000000000000001") as ProposalOutcome.Decided
            assertEquals(listOf("cable-fly", "bench-press", "overhead-press", "incline-dumbbell-press", "triceps-pushdown"), room.store.workout.session!!.plan!!.entries.map { it.exerciseId })
            assertEquals("Applied · this workout · 1 change", decided.proposal.settledReceipt?.words.spelled())

            room.sync(server)
            room.store.refreshEngine()
            assertEquals("Applied · this workout · 1 change", room.store.workoutProposals.held.getValue("wp000000000000001").settledReceipt?.words.spelled())
            finishing()
        }
    }

    // A workout gone by its empty finish and its discard takes the offer with it: the card says so instead of waiting for good, and a late tap answers that it is gone.
    @Test
    fun aProposalWhoseWorkoutIsGoneIsNoLongerAnOffer() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            open(room, server)
            coachProposes(room, swapped)
            room.store.refreshEngine()
            val finished = room.store.workout.finish() as FinishOutcome.Closed
            room.store.refreshEngine()
            assertTrue(room.store.workout.discardWorkout(finished.detail.session.id) == null)
            room.store.refreshEngine()

            val gone = room.store.workoutProposals.held.getValue("wp000000000000001")
            assertEquals(ProposalState.Pending, gone.state)
            assertEquals("This workout changed after this suggestion. Nothing was applied.", gone.staleWhy.spelled())
            assertEquals("that proposal is no longer on the log", (room.store.workoutProposals.apply("wp000000000000001") as ProposalOutcome.Gone).words.spelled())
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
