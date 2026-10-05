package works.windmill.sync.engine

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import kotlin.concurrent.withLock
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID

class PullConcurrencyTests {
    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
    private val scope = ScopeRef.tree("b_00000001")
    private val clock = object : EngineClock { override fun now() = 100L }
    private val timing = RequestTiming(ClockReading(100, 100, "boot"), ClockReading(100, 100, "boot"))
    private val oldCursor = Json.of(WireCursor("ep-1", "live", 0).text)
    private val rows = (1L..2L).map { seq ->
        val stamp = Stamp("100:0:srv")
        Row(RecordKey("tag", RecordID("tag$seq")), Lattice(Life("alive", stamp), stamp,
            mapOf("label" to Register(Json.of("Tag $seq"), stamp))), seq = seq)
    }
    private fun response(page: Json) = SyncResponse(200, Json.objectOf("serverTime" to Json.of(100),
        "epoch" to Json.of("ep-1"), "as" to Json.of("A"), "pages" to Json.array(page)))
    private fun page(kind: String) = Json.objectOf("scope" to Json.of(scope.text), "kind" to Json.of(kind))

    private class BoundaryStore(private val delegate: EngineStore, private val first: RecordKey) : EngineStore by delegate {
        val committed = CountDownLatch(1)
        val resume = CountDownLatch(1)
        private var inserted = false
        private var paused = false
        override fun put(replica: String, scope: ScopeRef, row: Row) {
            delegate.put(replica, scope, row)
            if (row.key == first) inserted = true
        }
        override fun <T> transaction(body: () -> T): T {
            val result = delegate.transaction(body)
            if (inserted && !paused) {
                paused = true; committed.countDown()
                check(resume.await(5, TimeUnit.SECONDS)) { "chunk-boundary-timeout" }
            }
            return result
        }
    }

    private fun betweenChunks(expected: String, change: (Engine, Json) -> Unit, verify: (Engine) -> Unit) {
        val seed = Engine.memory(registry, clock = clock, actor = "r_aaaaaaaaaaaa")
        val identities = seed.identities
        val initial = seed.use { it.signIn("A", mapOf("probe" to false)); it.snapshot() }
        val store = BoundaryStore(MemoryStore(registry, initial), rows.first().key)
        Engine(registry, store, clock, identities, "r_aaaaaaaaaaaa").use { engine ->
            engine.reconcile(setOf(scope))
            engine.write { replica -> replica.cursors[scope.text] = replica.cursorOf(scope).with("cursor" to oldCursor) }
            val request = engine.pullRequest(listOf(scope))!!
            val answer = response(page("rows").with("rows" to Json.Arr(rows.map(Row::json)),
                "cursor" to Json.of(WireCursor("ep-1", "live", 2).text), "more" to Json.of(false),
                "seq" to Json.of(2), "digest" to Json.of(ScopeDigest.rows(rows.map(Row::json)).hex)))
            val pull = FutureTask { engine.onPullResponse(request, answer, timing, PullSlicing(chunkRows = 1)) }
            val mutation = FutureTask { engine.lock.withLock { change(engine, request) } }
            val pulling = Thread(pull, "pull-chunks")
            val mutating = Thread(mutation, "between-chunks")
            try {
                pulling.start()
                assertTrue("first chunk committed", store.committed.await(5, TimeUnit.SECONDS))
                mutating.start()
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (!engine.lock.hasQueuedThread(mutating) && mutating.isAlive && System.nanoTime() < deadline) Thread.yield()
                assertTrue("mutation queued behind first chunk", engine.lock.hasQueuedThread(mutating))
                store.resume.countDown()
                mutation.get(5, TimeUnit.SECONDS)
                assertEquals(listOf(Json.objectOf("scope" to Json.of(scope.text), "outcome" to Json.of(expected))), pull.get(5, TimeUnit.SECONDS))
                verify(engine)
            } finally {
                store.resume.countDown()
                pulling.join(5_000); mutating.join(5_000)
                assertFalse("pull completed", pulling.isAlive)
                assertFalse("mutation completed", mutating.isAlive)
            }
        }
    }

    private fun forgotten(engine: Engine) {
        val replica = engine.device.current()
        assertEquals(emptyList<Row>(), engine.store.rows(replica.id, scope))
        assertNull(replica.cursors[scope.text])
        assertNull(replica.staging[scope.text])
        assertFalse(engine.store.hasRows(replica.id, scope))
    }

    @Test fun unsubscribeBetweenChunksCannotRecreateTheScope() = betweenChunks("outside", { engine, _ ->
        engine.unsubscribe(scope)
    }, { engine ->
        forgotten(engine)
        assertFalse(scope in engine.selectedScopes.orEmpty())
    })

    @Test fun reconcileBetweenChunksCannotRecreateTheScope() = betweenChunks("outside", { engine, _ ->
        engine.reconcile(emptySet())
    }, { engine ->
        forgotten(engine)
        assertEquals(emptySet<ScopeRef>(), engine.selectedScopes)
    })

    @Test fun cursorResetBetweenChunksDropsTheRestOfThePageAsStale() = betweenChunks("stale", { engine, request ->
        assertEquals(listOf(Json.objectOf("scope" to Json.of(scope.text), "outcome" to Json.of("reset"))),
            engine.onPullResponse(request, response(page("reset")), timing))
    }, { engine ->
        val replica = engine.device.current()
        assertEquals(listOf(rows.first()), engine.store.rows(replica.id, scope))
        assertEquals(Json.Null, replica.cursorOf(scope).member("cursor"))
        assertEquals(Json.of(true), replica.cursorOf(scope)["behind"])
        assertEquals(Json.of(ScopeDigest.row(rows.first().json).hex), replica.cursorOf(scope).member("digest"))
        assertFalse(replica.cursorOf(scope).flag("booted"))
        assertNull(replica.staging[scope.text])
    })

    @Test fun knownEndBetweenChunksCannotRecreateTheScope() = betweenChunks("outside", { engine, request ->
        assertEquals(listOf(Json.objectOf("scope" to Json.of(scope.text), "outcome" to Json.of("gone"))),
            engine.onPullResponse(request, response(page("gone")), timing))
    }, { engine ->
        forgotten(engine)
        assertEquals(Json.of("gone"), engine.device.current().known[scope.text])
        assertTrue(scope in engine.selectedScopes.orEmpty())
    })
}
