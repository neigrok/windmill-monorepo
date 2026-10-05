package works.windmill.gym.domain.sync

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.domain.testing.withActionContext
import works.windmill.sync.api.Record
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID
import works.windmill.sync.modelserver.*
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.testing.SteppedEngine

class PredictionLifecycleTests {
    private val now = testMoment.now.ms
    private val exercise = Exercise(Id("exercise1", Exercise), "Squat", "squat", "barbell", 2.5)
    private fun committed(outcome: Outcome<*, *>) = assertTrue("$outcome", outcome is Outcome.Committed)
    private fun record(step: SteppedEngine, type: String, id: RecordID): Record =
        step.engine.read(Routine.scope) { it.drawn(type, id)!! }
    private fun removed(step: SteppedEngine, before: Record) {
        val drawn = record(step, before.type, before.id)
        assertFalse(drawn.isVisible)
        assertEquals("dead", drawn.life!!.state)
        assertTrue(drawn.life!!.stamp > before.life!!.stamp)
        assertEquals(before.born, drawn.born)
        assertFalse(step.drawn(Routine.scope, before.type).any { it.id == before.id })
    }
    private fun settle(step: SteppedEngine, before: Record, refused: Boolean) {
        if (refused) step.server.refuse(code = "invalid")
        assertTrue(step.senderStep())
        // The result alone must retain an accepted removal or roll a refused prediction back.
        if (refused) assertEquals(before, record(step, before.type, before.id)) else removed(step, before)
        step.sync()
        val after = step.engine.read(Routine.scope) { it.drawn(before.type, before.id) }
        if (refused) {
            assertEquals(before, after)
            assertEquals(RefusalCode.invalid, step.notices("gym").single().code)
        } else {
            // Settling evicts confirmed dead rows; the server retains their spent identity.
            assertNull(after)
            assertFalse(step.drawn(Routine.scope, before.type).any { it.id == before.id })
            val spent = ServerState(step.server.snapshot()).spent.values.mapNotNull { it[RecordKey(before.type, before.id)] }.single()
            assertTrue(Stamp(spent.member("lifeStamp").str()) > before.life!!.stamp)
            assertEquals(before.born?.json, spent["born"])
        }
    }

    @Test fun applyingARemovalProposalHidesTheRoutineOfflineAndAcceptsOrRollsBack() = runBlocking<Unit> {
        for (refused in listOf(false, true)) SteppedEngine(SyncSchema.registry, now, rules = GymServerRules()).use { step ->
            withActionContext { context ->
                val runner = ActionRunner(step.replica, SyncSchema.registry, FixedZone(0), context)
                committed(runner.run(CreateExercise(exercise)))
                step.sync()
                assertTrue(runner.save(Draft.new(routine.copy(entries = listOf(entry.copy(exerciseId = exercise.id)))), Routine, GymRefusal) {} is SaveResult.Saved)
                step.sync()
                assertTrue("routine setup: ${step.notices("gym")}; ${step.engine.snapshot()}", step.drawn(Routine.scope, Routine.type).isNotEmpty())
                committed(runner.run(ProposeRoutine(proposalId, routineId, "", emptyList(), "Remove", removing = true)))
                step.sync()
                val before = record(step, Routine.type, routineId.record)
                committed(runner.run(ApplyProposal(proposalId)))
                removed(step, before)
                settle(step, before, refused)
            }
        }
    }

    @Test fun correctingASessionHidesOmittedSetsOfflineAndAcceptsOrRollsBack() = runBlocking<Unit> {
        for (refused in listOf(false, true)) SteppedEngine(SyncSchema.registry, now, rules = GymServerRules()).use { step ->
            withActionContext { context ->
                val runner = ActionRunner(step.replica, SyncSchema.registry, FixedZone(0), context)
                committed(runner.run(CreateExercise(exercise)))
                step.sync()
                val start = Instant(now - 60_000)
                val finish = Instant(now)
                val kept = ImportedSet(setId, exercise.id, 80.0, 5, Instant(now - 1_000))
                val omitted = kept.copy(id = Id("set00002", TrainingSet))
                committed(runner.run(ImportSession(sessionId, start, finish, listOf(kept, omitted))))
                step.sync()
                assertTrue("session setup: ${step.notices("gym")}; ${step.engine.snapshot()}", step.drawn(Session.scope, TrainingSet.type).size == 2)
                val before = record(step, TrainingSet.type, omitted.id.record)
                val correction = CorrectedSet(kept.id, exercise.id, 1, 80.0, 5, kept.completedAt)
                committed(runner.run(CorrectSession(sessionId, "request1", start, finish, null, listOf(correction))))
                removed(step, before)
                assertEquals(listOf(setId.record), step.drawn(Session.scope, TrainingSet.type).map { it.id })
                settle(step, before, refused)
            }
        }
    }

    @Test fun aKeyedRemovalPredictionHasNoBornAndAcceptsOrRollsBack() = runBlocking<Unit> {
        // Gym currently has no command predicting a keyed type; exercise the kit's existing mapping with a test binding.
        val name = "gym.removeWeight"
        val declaration = Json.objectOf("name" to Json.of(name), "scope" to Json.of("product:gym"),
            "origins" to Json.array(Json.of("replica")), "serverInternal" to Json.of(false),
            "args" to Json.objectOf("id" to Json.objectOf("type" to Json.of("ref<${WeighIn.type}>"))),
            "predicts" to Json.array(Json.of(WeighIn.type)))
        val registry = Registry(SyncSchema.registry.json.with("commands" to Json.Arr(SyncSchema.registry.commands + declaration),
            "types" to Json.Arr(SyncSchema.registry.types.map { if (it.name == WeighIn.type) it.json.with("wholePut" to null) else it.json })))
        val rules = object : ServerRules by GymServerRules() {
            override fun run(command: CheckedCommand, context: RuleContext): CommandOutcome =
                if (command.name == name) CommandOutcome(listOf(PlannedDelta.delete(
                    RecordKey(WeighIn.type, RecordID(command.args.getValue("id"))), null)), product = context.product)
                else GymServerRules().run(command, context)
        }
        for (refused in listOf(false, true)) SteppedEngine(registry, now, rules = rules).use { step ->
            withActionContext { context ->
                val runner = ActionRunner(step.replica, registry, FixedZone(0), context)
                val weight = WeighIn(LocalDay.parse("2026-01-01")!!, 80.0)
                assertTrue(runner.save(Draft.new(WeighIn(weight.day!!)).edit { weight }, WeighIn, GymRefusal) {} is SaveResult.Saved)
                step.sync()
                assertTrue("weight setup: ${step.notices("gym")}; ${step.engine.snapshot()}", step.drawn(WeighIn.scope, WeighIn.type).isNotEmpty())
                val before = record(step, WeighIn.type, weight.id.record)
                assertNull(before.born)
                val action = object : Action<Unit, Unit, GymRefusal> {
                    override val scope = WeighIn.scope
                    override val refusals = GymRefusal
                    override fun load(read: Reader) = Unit
                    override fun decide(loaded: Unit, ids: IDSource): Decision<Unit, GymRefusal> {
                        val command = object : ServerCommand {
                            override val name = name
                            override val args = mapOf("id" to weight.id.json)
                            override val specs = emptyList<ValueSpec>()
                        }
                        return Decision.Write(Plan(command, listOf(Prediction.remove(WeighIn, weight.id))), Unit)
                    }
                }
                committed(runner.run(action))
                removed(step, before)
                settle(step, before, refused)
            }
        }
    }
}
