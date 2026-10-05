package works.windmill.gym.net

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.gym.domain.*
import works.windmill.gym.store.EngineTraining
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.Command
import works.windmill.sync.core.RecordID
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineClock
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

class ProgressWireTests {
    @Test
    fun readsTheCompleteOptInProjectionWithTheExactQueryAndTypedFacts() = runBlocking {
        Engine.memory(SyncSchema.registry, clock = object : EngineClock { override fun now() = 99L }).use { engine ->
            val scope = ScopeRef(Gym.scope)
            engine.commit(scope, Gesture(emptyList(), command = Command(Gym.Commands.start,
                Json.objectOf("id" to Json.of("session1"), "startedAt" to Json.of(10L))), predict = listOf(
                Change.create(Gym.Types.session, NewID.Given(RecordID("session1")), mapOf("startedAt" to Json.of(10L), "finishedAt" to Json.of(90L))),
            )))
            engine.commit(scope, Gesture(listOf(
                Change.create(Gym.Types.set, NewID.Given(RecordID("heavyset")), mapOf("sessionId" to Json.of("session1"), "exerciseId" to Json.of("bench-press"), "weightKg" to Json.of(100), "reps" to Json.of(12), "rpe" to Json.of(6), "kind" to Json.of("working"), "note" to Json.of(""), "completedAt" to Json.of(20L))),
                Change.create(Gym.Types.set, NewID.Given(RecordID("estimate")), mapOf("sessionId" to Json.of("session1"), "exerciseId" to Json.of("bench-press"), "weightKg" to Json.of(80), "reps" to Json.of(1), "rpe" to Json.Null, "kind" to Json.of("working"), "note" to Json.of(""), "completedAt" to Json.of(30L))),
            )))
            val api = EngineTraining(engine) { error("Progress is an engine projection.") }
            assertEquals(StatsProgress(99, listOf(ProgressSession("session1", 10, listOf(MovementSessionFact("bench-press", 2,
                PerformedFact("heavyset", 100.0, 12, 6.0), EstimatedFact("estimate", 80.0, 1, null, 80.0)))))), api.progress())
        }
    }
}
