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
    private fun abilityFile(zone: String = "UTC", copies: Int = 1): String {
        val case = """{"case":"a note lands","seat":"anon","now":1790000000000,"zone":"$zone","given":{"appBaseUrl":"https://w","records":[{"t":"note"}]},"call":{"name":"save_note","input":{"id":"n"}},"expect":{"refused":"refused"}}"""
        return File.createTempFile("ability", ".json").apply { deleteOnExit(); writeText(List(copies) { case }.joinToString(",", "[", "]")) }.absolutePath
    }

    @Test fun anAbilityFileReadsAsItsCasesAndRefusesWhatItCannotPlace() {
        val path = abilityFile()
        assertEquals(listOf(AbilityCase(path, "a note lands", works.windmill.domain.kit.Seat.anon, 1_790_000_000_000, listOf(Json.parse("""{"t":"note"}""")), "https://w",
            "save_note", Json.parse("""{"id":"n"}"""), Json.parse("""{"refused":"refused"}"""))), Contract.abilityCases(path))
        assertThrows(ContractError::class.java) { Contract.abilityCases(abilityFile(zone = "Europe/Paris")) }
        assertThrows(IllegalArgumentException::class.java) { Contract.abilityCases(abilityFile(copies = 2)) }
    }

    @Test fun anAbilityAnswerListsWhatItsGestureWroteLessTheCallsOwnRecord() {
        val note = Json.parse("""{"t":"note","id":"n1","f":{"ord":["a0","1:0:r_aaaaaaaaaaaa"]}}""")
        val case = AbilityCase("file", "case", works.windmill.domain.kit.Seat.bound, 1, listOf(note), null, "save_note", Json.objectOf(), Json.Null)
        fun decision(below: String) = Json.parse("""{"decision":{"write":{"result":{"result":{"a":1},"sha256":"x"},"gesture":{"changes":[
            {"op":"update","t":"message","id":"m","f":{"calls":[]}},
            {"op":"delete","t":"set","id":"s1"},
            {"op":"create","t":"note","id":"n2","f":{"title":"T"},"anchor":{"field":"ord","below":$below}}]}}}}""")
        assertEquals(Json.parse("""{"result":{"a":1},"sha256":"x","writes":[
            {"f":{"ord":"a1","title":"T"},"id":"n2","life":"alive","t":"note"},
            {"f":{},"id":"s1","life":"dead","t":"set"}]}"""), case.answer(decision("\"n1\""), "message"))
        assertEquals("a0", case.answer(decision("null"), "message").member("writes").arr()[0].member("f").member("ord").str())
        assertThrows(ContractError::class.java) { case.answer(decision("\"absent\""), "message") }
        assertThrows(ContractError::class.java) { case.answer(Json.parse("""{"decision":{"refuse":{}}}"""), "message") }
    }

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
