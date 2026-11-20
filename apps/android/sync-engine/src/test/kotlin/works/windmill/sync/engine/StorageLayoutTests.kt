package works.windmill.sync.engine

import android.database.sqlite.SQLiteDatabase
import android.os.Build
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import works.windmill.sync.core.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class StorageLayoutTests {
    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
    private val scope = ScopeRef.product("probe")
    private val initial = Json.objectOf("active" to Json.of("replica"), "replicas" to Json.array(freshReplica("replica").json()))
    private fun row(id: String, ref: String = "run00001") = Row(RecordKey("lap", RecordID(id)), Lattice(fields = mapOf("runId" to Register(Json.of(ref), Stamp("1:0:a")))), seq = 1)
    private fun <T> stores(body: (EngineStore) -> T) {
        MemoryStore(registry, initial).use(body)
        val file = File.createTempFile("windmill-layout-", ".sqlite").also { it.delete() }
        try {
            SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
                db.enableWriteAheadLogging()
                AndroidSqliteStore(db, registry).use { store -> store.transaction { store.metadata(initial) }; body(store) }
            }
        } finally { file.delete(); File(file.path + "-wal").delete(); File(file.path + "-shm").delete() }
    }
    @Test fun swapChangesRolesWithoutReadingOrCopyingRowsAndSweepIsBounded() = stores { store ->
        store.transaction {
            repeat(1_000) { store.put("replica", scope, row("old${it.toString().padStart(5, '0')}")) }
            store.beginStaging("replica", scope)
            repeat(500) { store.putStaging("replica", scope, row("new${it.toString().padStart(5, '0')}", "run00002")) }
        }
        val reads = (store as? MemoryStore)?.rowsRead
        store.transaction { store.swapStaging("replica", scope) }
        if (reads != null) assertEquals(reads, (store as MemoryStore).rowsRead)
        assertEquals(1_000, store.releasedRows())
        assertEquals(500, store.rows("replica", scope).size)
        assertTrue(store.matching("replica", scope, "lap", "runId", RecordID("run00001")).isEmpty())
        assertEquals(500, store.matching("replica", scope, "lap", "runId", RecordID("run00002")).size)
        assertTrue(store.transaction { store.sweepReleased(128) })
        assertEquals(872, store.releasedRows())
        repeat(7) { store.transaction { store.sweepReleased(128) } }
        assertEquals(0, store.releasedRows())
        assertFalse(store.transaction { store.sweepReleased(128) })
    }
    @Test fun failedSwapAndFailedSweepRestoreRolesRowsAndReferences() = stores { store ->
        val old = row("lap00001")
        val fresh = row("lap00002", "run00002")
        store.transaction { store.put("replica", scope, old); store.beginStaging("replica", scope); store.putStaging("replica", scope, fresh) }
        assertThrows(IllegalStateException::class.java) { store.transaction { store.swapStaging("replica", scope); error("abort") } }
        assertEquals(listOf(old), store.rows("replica", scope))
        assertEquals(listOf(fresh), store.stagingRows("replica", scope))
        assertEquals(0, store.releasedRows())
        store.transaction { store.swapStaging("replica", scope) }
        assertThrows(IllegalStateException::class.java) { store.transaction { store.sweepReleased(1); error("abort") } }
        assertEquals(1, store.releasedRows())
        assertEquals(listOf(fresh), store.matching("replica", scope, "lap", "runId", RecordID("run00002")))
    }
    @Test fun stagingMetadataNeverLoadsRowsAndExactLookupIncludesTheRecordType() = stores { store ->
        val staged = initial.with("replicas" to Json.array(freshReplica("replica").json().with(
            "staging" to Json.objectOf(scope.text to Json.objectOf("cursor" to Json.Null, "digest" to Json.of(ScopeDigest.ZERO.hex))))))
        val lap = row("record01")
        val card = Row(RecordKey("card", lap.key.id), seq = 2)
        store.transaction {
            store.beginStaging("replica", scope); store.metadata(staged)
            store.putStaging("replica", scope, lap); store.putStaging("replica", scope, card)
        }
        val before = (store as? MemoryStore)?.rowsRead
        assertEquals(staged, store.metadata())
        assertFalse(store.hasRows("replica", scope))
        assertEquals(lap, store.stagingRow("replica", scope, lap.key))
        assertEquals(card, store.stagingRow("replica", scope, card.key))
        assertNull(store.stagingRow("replica", scope, RecordKey("lap", RecordID("missing1"))))
        if (before != null) assertEquals(before + 3, (store as MemoryStore).rowsRead)
        assertTrue(store.rows("replica", scope).isEmpty())
        assertThrows(IllegalStateException::class.java) { store.transaction { store.removeStaging("replica", scope, lap.key); error("abort") } }
        assertEquals(lap, store.stagingRow("replica", scope, lap.key))
    }
    @Test fun reidentificationKeepsBothRowSetsAndRollbackRestoresThePriorIdentity() = stores { store ->
        val old = row("lap00001")
        val staged = row("lap00002")
        store.transaction { store.put("replica", scope, old); store.beginStaging("replica", scope); store.putStaging("replica", scope, staged) }
        assertThrows(IllegalStateException::class.java) { store.transaction { store.reidentify("replica", "next"); error("abort") } }
        assertEquals(listOf(old), store.rows("replica", scope))
        store.transaction {
            store.reidentify("replica", "next")
            store.metadata(initial.with("active" to Json.of("next"), "replicas" to Json.array(freshReplica("next").json())))
        }
        assertEquals(listOf(old), store.rows("next", scope))
        // Metadata with no staging deliberately drops the outstanding boot.
        store.transaction { store.beginStaging("next", scope); store.putStaging("next", scope, staged) }
        assertEquals(listOf(staged), store.stagingRows("next", scope))
    }
    @Test fun forgetAndPurgeHideRowsBeforeAnySweepAndRollbackIsAtomic() = stores { store ->
        val row = row("lap00001")
        store.transaction { store.put("replica", scope, row) }
        assertThrows(IllegalStateException::class.java) { store.transaction { store.forgetScope("replica", scope); error("abort") } }
        assertEquals(row, store.row("replica", scope, row.key))
        store.transaction { store.forgetScope("replica", scope) }
        assertNull(store.row("replica", scope, row.key))
        assertTrue(store.scopes("replica").isEmpty())
        assertEquals(1, store.releasedRows())
        store.transaction { store.put("replica", scope, row); store.purgeReplica("replica") }
        assertNull(store.row("replica", scope, row.key))
        assertEquals(2, store.releasedRows())
    }
    @Test @Config(sdk = [26, 27, 28, 29, 35]) fun schemaHasNormalizedTablesForeignKeysDurablePragmasAndStableHandle() {
        val file = File.createTempFile("windmill-schema-", ".sqlite").also { it.delete() }
        try {
            val db = if (Build.VERSION.SDK_INT >= 28) SQLiteDatabase.openDatabase(file, SQLiteDatabase.OpenParams.Builder()
                .addOpenFlags(SQLiteDatabase.CREATE_IF_NECESSARY).setSynchronousMode("FULL").setJournalMode("WAL").build())
            else SQLiteDatabase.openOrCreateDatabase(file, null)
            db.use {
                AndroidSqliteStore(db, registry).use { store ->
                    store.transaction { store.metadata(initial) }
                    val tables = db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'android_metadata'", null).use { rows ->
                        buildSet { while (rows.moveToNext()) add(rows.getString(0)) }
                    }
                    assertEquals(setOf("device", "replica", "row_set", "set_row", "set_ref", "spent", "cursor", "known_scope", "outbox", "outbox_touch", "notice", "device_row",
                        "reversible_act", "inverse_request", "cancellation"), tables)
                    for ((pragma, expected) in listOf("foreign_keys" to "1", "synchronous" to "2", "journal_mode" to if (Build.VERSION.SDK_INT >= 28) "wal" else "delete", "user_version" to "2")) {
                        assertEquals(expected, db.rawQuery("PRAGMA $pragma", null).use { it.moveToFirst(); it.getString(0) })
                    }
                    val before = db.rawQuery("SELECT handle FROM replica", null).use { it.moveToFirst(); it.getLong(0) }
                    store.transaction { store.reidentify("replica", "next") }
                    val after = db.rawQuery("SELECT handle FROM replica WHERE id='next'", null).use { it.moveToFirst(); it.getLong(0) }
                    assertEquals(before, after)
                    assertEquals(initial.with("active" to Json.of("next"), "replicas" to Json.array(freshReplica("next").json())), store.metadata())
                }
            }
        } finally { file.delete(); File(file.path + "-wal").delete(); File(file.path + "-shm").delete() }
    }
    @Test fun roleSwapAndReleasedSweepSurviveCloseAndReopen() {
        val file = File.createTempFile("windmill-reopen-", ".sqlite").also { it.delete() }
        try {
            fun open() = AndroidSqliteStore(SQLiteDatabase.openOrCreateDatabase(file, null), registry)
            open().use { store -> store.transaction {
                store.metadata(initial); store.put("replica", scope, row("lap00001")); store.beginStaging("replica", scope)
                store.putStaging("replica", scope, row("lap00002")); store.swapStaging("replica", scope)
            } }
            open().use { store ->
                assertEquals(listOf(row("lap00002")), store.rows("replica", scope))
                assertEquals(1, store.releasedRows())
                store.transaction { assertFalse(store.sweepReleased(1)) }
            }
            open().use { store -> assertEquals(0, store.releasedRows()); assertEquals(listOf(row("lap00002")), store.rows("replica", scope)) }
        } finally { file.delete(); File(file.path + "-wal").delete(); File(file.path + "-shm").delete() }
    }
    @Test fun incompleteBootSurvivesCloseWithoutEmbeddingRowsInMetadata() {
        val file = File.createTempFile("windmill-boot-", ".sqlite").also { it.delete() }
        val staged = initial.with("replicas" to Json.array(freshReplica("replica").json().with(
            "staging" to Json.objectOf(scope.text to Json.objectOf("cursor" to Json.Null, "digest" to Json.of(ScopeDigest.ZERO.hex))))))
        val old = row("lap00001")
        val next = row("lap00002")
        try {
            fun open() = AndroidSqliteStore(SQLiteDatabase.openOrCreateDatabase(file, null), registry)
            open().use { store -> store.transaction {
                store.metadata(staged); store.put("replica", scope, old); store.putStaging("replica", scope, next)
            } }
            open().use { store ->
                assertEquals(staged, store.metadata())
                assertEquals(listOf(old), store.rows("replica", scope))
                assertEquals(next, store.stagingRow("replica", scope, next.key))
                assertNull(store.row("replica", scope, next.key))
                assertEquals(0, store.releasedRows())
            }
        } finally { file.delete(); File(file.path + "-wal").delete(); File(file.path + "-shm").delete() }
    }
    @Test fun everyMetadataTableRoundTripsAndNoticeOrderSurvivesUpdates() = stores { store ->
        fun entry(id: String, order: Long) = Json.objectOf("localId" to Json.of("$id/0"), "gestureId" to Json.of(id), "lineage" to Json.of("anon"),
            "scope" to Json.of(scope.text), "state" to Json.of("held"), "stamp" to Json.of("1:0:a"), "commitOrder" to Json.of(order), "releaseAt" to Json.of(9_000),
            "intent" to Intent(scope, deltas = listOf(Delta(RecordKey("card", RecordID("card0001")), Lattice(Life("alive", Stamp("1:0:a")), Stamp("1:0:a"))))).json)
        fun notice(id: String) = Json.objectOf("id" to Json.of(id), "scope" to Json.of(scope.text), "code" to Json.of("cap"),
            "at" to Json.of(1_000), "content" to Json.objectOf("d" to Json.array()))
        val next = initial.with("meta" to Json.objectOf("forkGuard" to Json.of("guard"), "pendingSignIn" to Json.objectOf("account" to Json.of("acct"))),
            "replicas" to Json.array(freshReplica("replica").json().with(
                "outbox" to Json.array(entry("z", 0), entry("a", 1)), "notices" to Json.array(notice("notice:z/0"), notice("notice:a/0")),
                "known" to Json.objectOf("tree/b_00000000" to Json.of("not-found")),
                "spentIds" to Json.objectOf(scope.text to Json.array(Json.objectOf("t" to Json.of("tag"), "id" to Json.of("spent"), "born" to Json.of("1:0:a")),
                    Json.objectOf("t" to Json.of("tag"), "id" to Json.of("spent-seq"), "born" to Json.of("1:0:a"), "seq" to Json.of(3)))),
                "cursors" to Json.objectOf(scope.text to Json.objectOf("cursor" to Json.Null, "digest" to Json.of(ScopeDigest.ZERO.hex), "booted" to Json.of(false))),
                "device" to Json.objectOf("probe" to Json.objectOf("rack" to Json.array(Json.of(1), Json.of(2)))),
                "journal" to Json.array(act("a", retained = true), act("z", retained = true)), "inverses" to Json.array(request("r1")), "cancellations" to Json.array(cancellation("c1")))))
        store.transaction { store.metadata(next) }
        assertEquals(next, store.metadata())
        val updated = next.with("replicas" to Json.array(next.member("replicas").arr().single().with("notices" to Json.array(notice("notice:z/0").with("dismissed" to Json.of(true)), notice("notice:a/0")),
            "journal" to Json.array(act("a", retained = false)), "cancellations" to null)))
        store.transaction { store.metadata(updated) }
        assertEquals(updated, store.metadata())
    }
    private fun target() = Json.objectOf("scope" to Json.of(scope.text), "t" to Json.of("card"), "id" to Json.of("card0001"), "slot" to Json.objectOf("kind" to Json.of("field"), "name" to Json.of("title")))
    private fun act(id: String, retained: Boolean) = ReversibleAct(Json.objectOf("version" to Json.of(1), "actId" to Json.of(id), "retained" to Json.of(retained),
        "sourceEntries" to Json.array(Json.objectOf("localId" to Json.of("$id/0"), "originScope" to Json.of(scope.text),
            "recipes" to Json.array(Json.objectOf("kind" to Json.of("fields"), "restoreCommand" to Json.of("probe.restore"), "targets" to Json.array(Json.objectOf("target" to target())))),
            "preimages" to Json.array(Json.objectOf("target" to target(), "value" to Json.of("Old"))), "attempts" to Json.array())))).json
    private fun request(id: String) = InverseRequest(Json.objectOf("version" to Json.of(1), "requestId" to Json.of(id), "sourceActId" to Json.of("a"), "inverseActId" to Json.of("i1"),
        "state" to Json.of("waiting"), "requestedAt" to Json.of(9_000), "localChanged" to Json.of(true), "slots" to Json.array(Json.objectOf("localId" to Json.of("i1/0"),
            "commitOrder" to Json.of(2), "originScope" to Json.of(scope.text),
            "recipe" to Json.objectOf("kind" to Json.of("restore"), "command" to Json.of("probe.restore"),
                "operations" to Json.array(Json.objectOf("kind" to Json.of("field"), "target" to target(), "before" to Json.of("Old")))), "state" to Json.of("waiting"))))).json
    private fun cancellation(id: String) = CancellationReceipt(Json.objectOf("version" to Json.of(1), "inverseActId" to Json.of(id), "cancelledActId" to Json.of("z"),
        "units" to Json.array(Json.objectOf("kind" to Json.of("field"), "ownerLocalId" to Json.of("z/0"), "target" to target(), "redoValue" to Json.of("New"),
            "restored" to Json.objectOf("kind" to Json.of("accepted"), "epoch" to Json.Null, "version" to Json.objectOf("kind" to Json.of("stamp"), "stamp" to Json.of("1:0:a"))))))).json
    @Test fun aVersionOneStoreGainsTheJournalTablesAndKeepsItsContent() {
        val file = File.createTempFile("windmill-upgrade-", ".sqlite").also { it.delete() }
        val stored = initial.with("replicas" to Json.array(freshReplica("replica").json().with("device" to Json.objectOf("probe" to Json.objectOf("rack" to Json.of(1))))))
        try {
            AndroidSqliteStore(SQLiteDatabase.openOrCreateDatabase(file, null), registry).use { store -> store.transaction { store.metadata(stored) } }
            SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
                for (table in listOf("reversible_act", "inverse_request", "cancellation")) db.execSQL("DROP TABLE $table")
                db.version = 1
            }
            SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
                AndroidSqliteStore(db, registry).use { store ->
                    assertEquals(2, db.version)
                    assertEquals(stored, store.metadata())
                    val journaled = stored.with("replicas" to Json.array(stored.member("replicas").arr().single().with("journal" to Json.array(act("a", retained = true)))))
                    store.transaction { store.metadata(journaled) }
                    assertEquals(journaled, store.metadata())
                }
            }
        } finally { file.delete(); File(file.path + "-wal").delete(); File(file.path + "-shm").delete() }
    }
    @Test fun unsupportedVersionAndForeignUnversionedSchemaFailWithoutChangingTheFile() {
        val file = File.createTempFile("windmill-foreign-", ".sqlite").also { it.delete() }
        try {
            SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
                db.execSQL("CREATE TABLE todays_store(value TEXT NOT NULL)"); db.execSQL("INSERT INTO todays_store VALUES('preserved')")
                assertThrows(StoreFailure::class.java) { AndroidSqliteStore(db, registry) }
                assertEquals("preserved", db.rawQuery("SELECT value FROM todays_store", null).use { it.moveToFirst(); it.getString(0) })
                assertEquals(0, db.version)
                db.version = 3
                assertThrows(StoreFailure::class.java) { AndroidSqliteStore(db, registry) }
                assertEquals(3, db.version)
            }
        } finally { file.delete(); File(file.path + "-wal").delete(); File(file.path + "-shm").delete() }
    }
    @Test fun corruptOpenFailsWithoutDeletingTheDatabaseAndReportsStaticStorageFailure() {
        val file = File.createTempFile("windmill-corrupt-", ".sqlite")
        val bytes = ByteArray(4_096) { (it % 128).toByte() }
        file.writeBytes(bytes)
        val delivered = kotlinx.coroutines.CompletableDeferred<EngineEvent>()
        try {
            val failure = assertThrows(works.windmill.sync.api.CommitFailure::class.java) {
                AndroidSqlite.open(file, registry, initial, object : EngineClock { override fun now() = 0L }, object : IdentitySource {
                    override fun opaqueID() = "g1"; override fun draw(bound: Int) = 0
                }, "actor", EngineTelemetry { delivered.complete(it) })
            }
            assertEquals(works.windmill.sync.api.CommitFailure.Kind.storeFailure, failure.kind)
            assertArrayEquals(bytes, file.readBytes())
            kotlinx.coroutines.runBlocking {
                assertEquals(EngineEvent(EngineOperation.storage, EngineOutcome.failure, "store-failure"), kotlinx.coroutines.withTimeout(5_000) { delivered.await() })
            }
        } finally { file.delete(); File(file.path + "-wal").delete(); File(file.path + "-shm").delete() }
    }

}
