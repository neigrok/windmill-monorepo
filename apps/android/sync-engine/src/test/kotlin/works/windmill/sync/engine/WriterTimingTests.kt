package works.windmill.sync.engine

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID

class WriterTimingTests {
    @Test fun observersRunAfterUnlockAndCannotChangeSuccessOrRollback() {
        val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
        val samples = mutableListOf<WriterTiming>()
        lateinit var engine: Engine
        engine = Engine.memory(registry, writerObserver = WriterObserver { timing ->
            assertFalse(engine.lock.isHeldByCurrentThread)
            samples.add(timing)
            throw IllegalStateException("observer failed")
        })
        engine.use {
            val scope = ScopeRef.product("probe")
            val created = engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0001")),
                mapOf("title" to Json.of("One"))))))
            assertTrue(created is CommitOutcome.Committed)
            val before = engine.snapshot()
            engine.failNextCommit()
            try {
                engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0002")),
                    mapOf("title" to Json.of("Two"))))))
                fail("the persistence failure was swallowed")
            } catch (failure: CommitFailure) {
                assertEquals(CommitFailure.Kind.storeFailure, failure.kind)
            }
            assertEquals(before, engine.snapshot())
            val original = IllegalArgumentException("original body failure")
            try {
                engine.write(EngineOperation.lifecycle) { replica ->
                    replica.meta = replica.meta.with("serverOffsetMs" to Json.of(25L))
                    throw original
                }
                fail("the body failure was swallowed")
            } catch (failure: IllegalArgumentException) {
                assertSame(original, failure)
            }
            assertEquals(before, engine.snapshot())
            assertEquals(listOf(EngineOperation.commit to WriterTiming.Outcome.success,
                EngineOperation.commit to WriterTiming.Outcome.failure,
                EngineOperation.lifecycle to WriterTiming.Outcome.failure), samples.map { it.operation to it.outcome })
            assertTrue(samples.all { it.queueMs >= 0 && it.heldMs >= 0 })
        }
    }
}
