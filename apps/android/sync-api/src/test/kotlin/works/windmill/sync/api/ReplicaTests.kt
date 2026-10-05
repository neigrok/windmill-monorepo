package works.windmill.sync.api

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.Registry
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.Stamp

class ReplicaTests {
    val scope = ScopeRef.product("probe")
    val context = object : CommitContext {
        override val isAnonymous = true
        override val now = 117L
        override val replica = "r_aaaaaaaaaaaa"
        override val actor = "r_bbbbbbbbbbbb"
        override fun drawn(type: String, id: RecordID): Record? = null
        override fun stored(type: String, id: RecordID): Record? = null
        override fun drawn(type: String): List<Record> = emptyList()
        override fun stored(type: String): List<Record> = emptyList()
        override fun drawn(type: String, field: String, id: RecordID): List<Record> = emptyList()
        override fun stored(type: String, field: String, id: RecordID): List<Record> = emptyList()
        override fun device(key: String): Json? = null
        override fun firstPullComplete() = true
        override fun confirmed(type: String, id: RecordID): Record? = null
        override fun checkpoint() = ScopeCheckpoint("epoch", 7)
        override fun devices(prefix: String): Map<String, Json> = emptyMap()
        override fun commands() = listOf(QueuedCommand("g1", Command("probe.run", Json.objectOf()), true))
        override fun opaqueID() = "opaque"
        override fun mintID(type: String) = RecordID("minted")
    }
    fun replica(outcome: CommitOutcome?, failure: Exception? = null): Replica = object : Replica {
        override fun <T> commit(scope: ScopeRef, body: (CommitContext) -> Pair<Gesture?, T>): Pair<CommitOutcome?, T> {
            assertEquals(this@ReplicaTests.scope, scope)
            failure?.let { throw it }
            val (gesture, value) = body(context)
            return (if (gesture == null) null else outcome) to value
        }
        override fun undo(gestureId: String) = true
        override fun <T> read(scope: ScopeRef, body: (ScopeReader) -> T): T = body(context)
        override fun mintID(type: String) = context.mintID(type)
        override fun physNow() = context.now
        override fun dismissNotice(id: String) = Unit
    }

    @Test fun nullableGestureAndGenericBodyValueAreIndependent() {
        val replica = replica(CommitOutcome.Refused(RefusalCode.cap, null))
        val (outcome, value) = replica.commit(scope) { reader ->
            assertEquals(117L, reader.now); assertEquals("r_aaaaaaaaaaaa", reader.replica)
            assertEquals("r_bbbbbbbbbbbb", reader.actor)
            assertEquals(ScopeCheckpoint("epoch", 7), reader.checkpoint())
            assertTrue(reader.firstPullComplete()); assertTrue(reader.commands().single().canSupersede)
            null to listOf("typed", "value")
        }
        assertNull(outcome); assertEquals(listOf("typed", "value"), value)
        assertEquals(117L, replica.read(scope) { (it as CommitContext).now })
    }

    @Test fun gestureConvenienceForwardsBothOutcomesAndRequiresAnOutcome() {
        val gesture = Gesture(emptyList())
        val committed = CommitOutcome.Committed(CommitReceipt("g1", Stamp("1:0:a"), emptyList(), emptyList(), null, emptyList()))
        val refused = CommitOutcome.Refused(RefusalCode.tooLarge, null, "notice:g1/0")
        assertEquals(committed, replica(committed).commit(scope, gesture))
        assertEquals(refused, replica(refused).commit(scope, gesture))
        assertThrows(IllegalStateException::class.java) { replica(null).commit(scope, gesture) }
    }

    @Test fun convenienceNeverConvertsFailuresIntoRefusals() {
        for (kind in CommitFailure.Kind.entries) {
            val failure = CommitFailure(kind, "failure")
            assertSame(failure, assertThrows(CommitFailure::class.java) { replica(null, failure).commit(scope, Gesture(emptyList())) })
        }
        val error = IllegalArgumentException("body failed")
        assertSame(error, assertThrows(IllegalArgumentException::class.java) { replica(null).commit<Unit>(scope) { throw error } })
    }

    @Test fun registryExposesTheMetadataTheKitRequires() {
        val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "probe.registry.json").readBytes()))
        val card = registry.type("card")!!
        assertEquals("minted", card.identity); assertTrue(card.life)
        val parent = registry.type("lap")!!.fields.getValue("runId")
        assertTrue(parent.parent)
        assertEquals("run", parent.ref)
        assertEquals("client", card.fields.getValue("size").writer)
        assertEquals("lww", card.fields.getValue("size").kind)
        assertEquals(0.01, card.fields.getValue("size").quantum!!.step, 0.0)
        for (raw in registry.commands) {
            val definition = registry.command(raw.member("name").str())!!
            assertEquals(raw, definition.json)
            assertEquals(raw.member("args").obj().keys, definition.args.keys)
            assertEquals(raw["predicts"]?.arr()?.map { it.str() } ?: emptyList<String>(), definition.predicts)
        }
        assertNull(registry.command("missing.command"))
    }
}
