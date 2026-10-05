package works.windmill.domain.testing

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.sync.api.CommitContext
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.api.CommitOutcome
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.Replica
import works.windmill.sync.core.ScopeRef

class ActionContextTests {
    @Test fun elementFollowsSuspensionDispatcherHopsAndNestedChildren() = runBlocking {
        withActionContext { context ->
            assertSame(context, kotlin.coroutines.coroutineContext[ActionContextElement])
            context.insideRun = true
            try {
                yield()
                withContext(Dispatchers.Default) {
                    withActionContext { inherited ->
                        assertSame(context, inherited)
                        assertTrue(inherited.insideRun)
                    }
                }
                coroutineScope {
                    async { withActionContext { assertNotSame(context, it); assertTrue(it.insideRun) } }.await()
                }
            } finally { context.insideRun = false }
        }
        assertNull(coroutineContext[ActionContextElement])
    }

    @Test fun independentEntriesFromOneParentHaveIsolatedElements() = runBlocking {
        withActionContext { parent ->
            coroutineScope {
                val entered = CompletableDeferred<Unit>()
                val release = CompletableDeferred<Unit>()
                val first = async {
                    withActionContext { context ->
                        assertNotSame(parent, context)
                        context.insideRun = true
                        try { entered.complete(Unit); release.await() }
                        finally { context.insideRun = false }
                    }
                }
                entered.await()
                try {
                    async {
                        withActionContext { context ->
                            assertNotSame(parent, context)
                            assertFalse(context.insideRun)
                        }
                    }.await()
                    assertFalse(parent.insideRun)
                } finally { release.complete(Unit) }
                first.await()
            }
        }
    }

    @Test fun failedEntryDoesNotLeaveAContextInItsCaller() = runBlocking {
        val failure = CommitFailure(CommitFailure.Kind.storeFailure, "failed body")
        try {
            withActionContext { context ->
                assertSame(context, kotlin.coroutines.coroutineContext[ActionContextElement])
                yield()
                throw failure
            }
            fail("expected failure")
        } catch (caught: Exception) { assertSame(failure, caught) }
        assertNull(coroutineContext[ActionContextElement])
        withActionContext { assertFalse(it.insideRun) }
    }

    @Test fun childRetainsTheActiveMarkerAfterItsParentRunReturns() = runBlocking {
        val registry = probeRegistry()
        val replica = VectorReplica(VectorRecords(emptyList(), emptyList()), 5000, registry)
        var innerCommits = 0
        val innerPort = object : Replica by replica {
            override fun <T> commit(scope: ScopeRef, body: (CommitContext) -> Pair<Gesture?, T>): Pair<CommitOutcome?, T> {
                innerCommits++
                return replica.commit(scope, body)
            }
        }
        fun action(load: () -> Unit = {}) = object : Action<Unit, String, ProbeRefusal> {
            override val scope = Probe.scope
            override val refusals = ProbeRefusals
            override fun load(read: Reader) = load()
            override fun decide(loaded: Unit, ids: IDSource) = Decision.Unchanged("done")
        }
        withActionContext { parent ->
            coroutineScope {
                val resume = CompletableDeferred<Unit>()
                var child: kotlinx.coroutines.Deferred<IllegalStateException>? = null
                val runner = ActionRunner(replica, registry, FixedZone(0), parent)
                assertEquals(Outcome.Unchanged("done"), runner.run(action {
                    child = async {
                        resume.await()
                        withActionContext { inherited ->
                            assertNotSame(parent, inherited)
                            assertTrue(inherited.insideRun)
                            assertThrows(IllegalStateException::class.java) {
                                ActionRunner(innerPort, registry, FixedZone(0), inherited).run(action())
                            }
                        }
                    }
                }))
                assertFalse(parent.insideRun)
                resume.complete(Unit)
                requireNotNull(child).await()
                assertEquals(0, innerCommits)
                assertFalse(parent.insideRun)
                assertEquals(Outcome.Unchanged("done"), runner.run(action()))
            }
        }
    }
}
