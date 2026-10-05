package works.windmill.domain.testing

import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.api.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.RefusalCode

class VectorSupportTests {
    private val empty = VectorRecords(emptyList(), emptyList())
    private val registry get() = probeRegistry()
    @Test fun scopeReaderRefusesForeignTypeInEveryOverloadEvenWhenEmpty() {
        val source = VectorReader(empty, 0, scope = Probe.scope, registry = registry)
        val id = RecordID("mark0001")
        for (read in listOf<() -> Any?>(
            { source.drawn("mark", id) }, { source.stored("mark", id) },
            { source.drawn("mark") }, { source.stored("mark") },
            { source.drawn("mark", "done", id) }, { source.stored("mark", "done", id) },
            { source.confirmed("mark", id) },
        )) assertEquals(CommitFailure.Kind.malformed, assertThrows(CommitFailure::class.java) { read() }.kind)
        assertNull(source.drawn("card", RecordID("c_00000001")))
    }
    @Test fun finiteIdentitySourceExhaustsAndHasNoOpaqueIdentity() {
        val source = VectorReader(empty, 0, listOf(RecordID("first"), RecordID("second")))
        assertEquals(RecordID("first"), source.mintID("card"))
        assertEquals(RecordID("second"), source.mintID("card"))
        assertThrows(CommitFailure::class.java) { source.mintID("card") }
        assertThrows(CommitFailure::class.java) { source.opaqueID() }
    }
    @Test fun failedBodyAndDiskFailureAppendNothingAndFailureIsConsumed() {
        val replica = VectorReplica(empty, 0, registry)
        assertThrows(IllegalArgumentException::class.java) { replica.commit<Unit>(Probe.scope) { throw IllegalArgumentException("body") } }
        assertTrue(replica.gestures.isEmpty())
        replica.failNextCommit()
        assertEquals(CommitFailure.Kind.storeFailure, assertThrows(CommitFailure::class.java) { replica.commit(Probe.scope) { Gesture(emptyList()) to Unit } }.kind)
        assertTrue(replica.gestures.isEmpty())
        val committed = replica.commit(Probe.scope) { Gesture(emptyList()) to "value" }
        assertEquals("value", committed.second)
        assertEquals("g1", (committed.first as CommitOutcome.Committed).receipt.gestureId)
    }
    @Test fun failureAlsoAppliesToNoGestureAndRefusalAnswerIsRetained() {
        val replica = VectorReplica(empty, 0, registry, CommitOutcome.Refused(RefusalCode("stale"), null))
        replica.failNextCommit()
        assertThrows(CommitFailure::class.java) { replica.commit(Probe.scope) { null to Unit } }
        assertNull(replica.commit(Probe.scope) { null to "unchanged" }.first)
        assertEquals(RefusalCode("stale"), (replica.commit(Probe.scope) { Gesture(emptyList()) to Unit }.first as CommitOutcome.Refused).code)
    }
    @Test fun concurrentCommitReceiptsAreDistinctAndFailuresDoNotPublishGestures() {
        val replica = VectorReplica(empty, 0, registry)
        val pool = Executors.newFixedThreadPool(4)
        try {
            val futures = (0 until 40).map { pool.submit<String> { (replica.commit(Probe.scope) { Gesture(emptyList()) to Unit }.first as CommitOutcome.Committed).receipt.gestureId } }
            assertEquals(40, futures.map { it.get(5, TimeUnit.SECONDS) }.toSet().size)
            assertEquals(40, replica.gestures.size)
        } finally { pool.shutdownNow(); assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS)) }
    }
    @Test fun contractRejectsDuplicateNamesUnexpectedKeysAndMalformedJson() {
        val file = File.createTempFile("domain-kit-vector-", ".json")
        try {
            val vector = "{\"name\":\"same\",\"input\":null,\"expect\":null}"
            file.writeText("[$vector,$vector]")
            assertThrows(IllegalArgumentException::class.java) { Contract.vectors(file.absolutePath) }
            file.writeText("[{\"name\":\"one\",\"input\":null,\"expect\":null,\"extra\":true}]")
            assertThrows(IllegalArgumentException::class.java) { Contract.vectors(file.absolutePath) }
            file.writeText("[")
            assertThrows(IllegalArgumentException::class.java) { Contract.vectors(file.absolutePath) }
        } finally { file.delete() }
        assertThrows(java.io.FileNotFoundException::class.java) { Contract.json(file.absolutePath) }
    }
}
