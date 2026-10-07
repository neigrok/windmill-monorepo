package works.windmill.sync.testing

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import works.windmill.sync.core.*
import works.windmill.sync.schema.SyncSchema

@RunWith(Parameterized::class)
class CorpusTests(private val vector: Vector) {
    @Test fun vector() { Corpus.assertVector(vector, handlers.getValue(vector.file)) }
    companion object {
        val root = File(System.getProperty("windmill.contract"))
        val corpus = Corpus(File(root, "sync/corpus"))
        val probe = Registry(Json.parse(File(root, "sync/probe.registry.json").readBytes()))
        val handlers = CoreCorpus.handlers(probe) + ClientCorpus.handlers(probe) + NetworkCorpus.handlers(probe) + JournalCorpus.handlers(root) + ProtocolCorpus.handlers(probe)
        @JvmStatic @Parameterized.Parameters(name = "{0}")
        fun vectors(): List<Array<Any>> = handlers.keys.sorted().flatMap { corpus.vectors(it) }.map { arrayOf(it) }
    }
}

class CoverageTests {
    val corpus = Corpus(File(System.getProperty("windmill.contract"), "sync/corpus"))
    val handlers = CorpusTests.handlers
    @Test fun everyFileHasAnExplicitRole() {
        for (path in corpus.paths) Corpus.role(path)
        assertEquals(CorpusRole.SERVER, Corpus.role("gym/admit.json"))
        assertThrows(IllegalStateException::class.java) { Corpus.role("journal/new-unclassified.json") }
        check(handlers.keys.all { it in corpus.clientPaths })
        println("client corpus: ${handlers.size}/${corpus.clientPaths.size} files, ${handlers.keys.sumOf { corpus.vectors(it).size }}/${corpus.clientPaths.sumOf { corpus.vectors(it).size }} vectors")
    }
    @Test fun fullGateClaimsEveryClientFile() {
        assertEquals(emptyList<String>(), corpus.unclaimed(handlers, corpus.clientPaths))
        corpus.requireCoverage(handlers, corpus.clientPaths)
        assertEquals(52, handlers.size)
        assertEquals(740, handlers.keys.sumOf { corpus.vectors(it).size })
    }
    @Test fun supportedFileWithoutHandlerFails() {
        assertThrows(IllegalStateException::class.java) { corpus.requireCoverage(emptyMap(), listOf("stamp/order.json")) }
    }
    @Test fun generatedSchemaMatchesCompositionLosslessly() {
        val contract = File(System.getProperty("windmill.contract"), "sync")
        val composition = Json.parse(File(contract, "composition.json").readBytes())
        val registries = composition.member("registries").arr().map { Registry(Json.parse(File(contract, it.str()).readBytes())) }
        assertEquals(Registry.compose(composition.member("composition").str(), registries).json, SyncSchema.registry.json)
        assertEquals(5L, SyncSchema.version)
        assertEquals(4L, SyncSchema.registry.minVersion)
        assertEquals(setOf("gym", "journal"), SyncSchema.registry.products.keys)
    }
    @Test fun confirmedRecordsHaveRegistryVisibilityAndNoPendingState() {
        val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
        val stamp = Stamp("1:0:a")
        val row = Row(RecordKey("card", RecordID("record01")), Lattice(Life("alive", stamp), stamp,
            mapOf("title" to Register(Json.of("title"), stamp))), mapOf("body" to TextState("body", 1, true)), seq = 1, rc = 2, ru = 3)
        val record = Record(confirmed = row, registry = registry)
        assertTrue(record.isVisible); assertFalse(record.isPending); assertFalse(record.isHeld)
        assertEquals(Json.of("title"), record.values["title"])
        assertEquals(works.windmill.sync.api.TextValue("body", true, false), record.texts["body"])
        assertEquals(2L, record.rc); assertEquals(3L, record.ru)
        assertFalse(Record(row.copy(lattice = Lattice(Life("dead", stamp))), registry).isVisible)
        assertFalse(Record(Row(RecordKey("unknown", row.key.id), seq = 1), registry).isVisible)
    }
    @Test fun malformedJsonIsRejectedAndUnicodeIsByteExact() {
        for (text in listOf("01", "+1", "1.", "[1,]", "{\"x\":1,}", "{\"x\":1,\"x\":2}", "1e400", "1e-400", "\"\uD800\"")) {
            assertThrows("$text", JsonError::class.java) { Json.parse(text) }
        }
        assertThrows(IllegalArgumentException::class.java) { Json.parse(byteArrayOf(34, 0xC0.toByte(), 0xAF.toByte(), 34)) }
        assertThrows(JsonError::class.java) { Json.parse("[".repeat(129) + "0" + "]".repeat(129)) }
        assertNotEquals(Json.of("é"), Json.of("e\u0301"))
        assertEquals("0", Json.parse("-0e-5000").jcs)
    }
    @Test fun cursorCodecRequiresCanonicalJcsAndUnpaddedBase64url() {
        val examples = listOf(WireCursor("ep-1", "live", 4), WireCursor("ep-1", "boot", 4, RecordKey("link", RecordID.pair("a", "b")), 6),
            WireCursor("é", "live", Json.MAX_SAFE_INTEGER, RecordKey("node", RecordID("e\u0301"))))
        for (cursor in examples) assertEquals(cursor, WireCursor.decode(cursor.text))
        assertEquals("eyJlIjoiZXAtMSIsIm0iOiJsaXZlIiwicyI6NH0", examples.first().text)
        val malformed = listOf("", "a", "+", "/", "AA", "e30", examples.first().text + "=", WireCursor.encode("{\"m\":\"live\",\"e\":\"ep-1\",\"s\":4}".encodeToByteArray()),
            WireCursor.encode("{\"e\":\"ep-1\",\"m\":\"live\",\"s\":4,\"a\":4}".encodeToByteArray()), WireCursor.encode("{\"e\":\"ep-1\",\"m\":\"boot\",\"s\":4,\"a\":3}".encodeToByteArray()))
        for (text in malformed) assertThrows(IllegalArgumentException::class.java) { WireCursor.decode(text) }
    }
}

class ProtocolCorpusFailureTests {
    private val corpus = Corpus(File(System.getProperty("windmill.contract"), "sync/corpus"))
    private val path = "protocol/push.jsonl"
    private val handler = CorpusTests.handlers.getValue(path)
    private fun replacing(json: Json, key: String, value: Json) = Json.Obj((json.obj() + (key to value)).toList())
    private fun changedExchange(change: (Json) -> Json): Json {
        val lines = corpus.vectors(path).single().input.arr()
        val index = lines.indexOfFirst { it["http"] == Json.of("push") }
        return Json.Arr(lines.mapIndexed { at, line -> if (at == index) change(line) else line })
    }
    @Test fun generatedRequestCannotBeReplacedByTranscriptRequest() {
        val changed = changedExchange { line -> replacing(line, "request", replacing(line.member("request"), "replica", Json.of("rp_changed"))) }
        assertThrows(AssertionError::class.java) { handler(changed) }
    }
    @Test fun responseComesFromModelServer() {
        val changed = changedExchange { line -> replacing(line, "response", replacing(line.member("response"), "status", Json.of(503))) }
        assertThrows(AssertionError::class.java) { handler(changed) }
    }
    @Test fun clientActionReturnMustMatch() {
        val lines = corpus.vectors(path).single().input.arr()
        val index = lines.indexOfFirst { it["do"] == Json.of("commit") }
        val changed = Json.Arr(lines.mapIndexed { at, line -> if (at == index) replacing(line, "returns", Json.Null) else line })
        assertThrows(AssertionError::class.java) { handler(changed) }
    }
}
