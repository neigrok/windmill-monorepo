package works.windmill.sync.engine

import android.database.sqlite.SQLiteDatabase
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class AndroidSqliteTests {
    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
    private val scope = ScopeRef.product("probe")
    private val initial = Json.objectOf("active" to Json.of("replica"), "replicas" to Json.array(freshReplica("replica").json()))
    private val clock = object : EngineClock { override fun now() = 5_000L }
    private val ids = object : IdentitySource { override fun opaqueID() = "g1"; override fun draw(bound: Int) = 0 }
    private fun open(file: File) = AndroidSqlite.open(file, registry, initial, clock, ids, "actor")
    private fun <T> database(body: (File) -> T): T {
        val file = File.createTempFile("windmill-sync-", ".sqlite").also { it.delete() }
        try { return body(file) } finally { file.delete(); File(file.path + "-wal").delete(); File(file.path + "-shm").delete() }
    }
    @Test fun heldIntentClockAndDeviceWriteSurviveReopenAtomically() = database { file ->
        val snapshot = open(file).use { engine ->
            engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0001")), mapOf("title" to Json.of("One")))),
                hold = true, local = listOf(DeviceWrite("rack", Json.of(12)))))
            engine.snapshot()
        }
        open(file).use { engine ->
            assertEquals(snapshot, engine.snapshot())
            assertEquals(Json.of(12), engine.read(scope) { it.device("rack") })
            assertTrue(engine.read(scope) { it.drawn("card", RecordID("card0001"))!!.isHeld })
            assertNull(engine.read(scope) { it.stored("card", RecordID("card0001")) })
            assertEquals(listOf("g1/0"), engine.releaseHeld(true))
        }
        open(file).use { assertFalse(it.read(scope) { reader -> reader.drawn("card", RecordID("card0001"))!!.isHeld }) }
    }
    @Test fun failingMetadataCommitRollsBackTheWriterAndReopenShowsNoPartialIntent() = database { file ->
        open(file).use { engine ->
            val before = engine.snapshot()
            SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
                db.execSQL("CREATE TRIGGER fail_metadata BEFORE INSERT ON device BEGIN SELECT RAISE(ABORT,'injected'); END")
            }
            val failure = assertThrows(CommitFailure::class.java) { engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0001")))))) }
            assertEquals(CommitFailure.Kind.storeFailure, failure.kind)
            assertEquals(before, engine.snapshot())
        }
        open(file).use { engine -> assertTrue(engine.read(scope) { it.drawn("card").isEmpty() }); assertEquals(Stamp.UNSET.json, engine.snapshot().member("replicas").arr().single().member("meta").member("hlcHigh")) }
    }
    @Test fun failedBatchRollsBackRowsAndReferenceIndexesTogether() = database { file ->
        open(file).use { engine ->
            val store = engine.store
            val replica = engine.device.current().id
            val key = RecordKey("lap", RecordID("lap00001"))
            val stamp = Stamp("1:0:a")
            val row = Row(key, Lattice(fields = mapOf("runId" to Register(Json.of("run00001"), stamp))), seq = 1)
            store.transaction { store.put(replica, scope, row) }
            SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
                db.execSQL("CREATE TRIGGER fail_metadata BEFORE INSERT ON device BEGIN SELECT RAISE(ABORT,'injected'); END")
            }
            assertThrows(StoreFailure::class.java) { store.transaction {
                store.put(replica, scope, row.copy(lattice = Lattice(fields = mapOf("runId" to Register(Json.of("run00002"), stamp)))))
                store.metadata(initial)
            } }
            assertEquals(row, store.row(replica, scope, key))
            assertEquals(listOf(row), store.matching(replica, scope, "lap", "runId", RecordID("run00001")))
            assertTrue(store.matching(replica, scope, "lap", "runId", RecordID("run00002")).isEmpty())
        }
    }

    @Test fun joinedCommandAndDependentDeleteKeepTheirIdentityThroughSqliteReopen() = database { file ->
        val timing = RequestTiming(ClockReading(5_000, 5_000, "boot"), ClockReading(5_000, 5_000, "boot"))
        val targets = Json.parse("""[{"t":"run","from":"run00001","id":"run00002","born":"5000:0:srv"}]""")
        open(file).use { engine ->
            engine.write { it.meta = it.meta.with("state" to Json.of("bound"), "account" to Json.of("A")) }
            engine.commit(scope, Gesture(emptyList(), command = works.windmill.sync.core.Command("probe.start",
                Json.parse("""{"id":"run00001","startedAt":5000,"join":true}""")),
                predict = listOf(Change.create("run", NewID.Given(RecordID("run00001")), mapOf("label" to Json.of("Run"))))))
            val request = engine.nextPush()!!
            engine.onPushResponse(request, SyncResponse(200, Json.parse("""{"serverTime":5000,"epoch":"ep-1","as":"A","lastN":1,"results":[{"n":1,"s":"ok","seq":1,"write":[{"t":"run","from":"run00001","id":"run00002","born":"5000:0:srv"}]}]}""")), timing)
            val deletion = Gesture(listOf(Change.delete("run", RecordID("run00002")))).also { it.gestureId = "delete" }
            engine.commit(scope, deletion)
            engine.epochChange("ep-2")
        }
        open(file).use { engine ->
            assertEquals(targets, engine.device.current().entries().first().json["writeTargets"])
            val request = engine.nextPush()!!
            engine.onPushResponse(request, SyncResponse(200, Json.parse("""{"serverTime":5000,"epoch":"ep-2","as":"A","lastN":1,"results":[{"n":1,"s":"ok","seq":1,"write":[{"t":"run","id":"run00001","born":"5001:0:srv"}]}]}""")), timing)
        }
        open(file).use { engine ->
            assertEquals(Json.parse("""[{"t":"run","from":"run00001","id":"run00001","born":"5001:0:srv"}]"""), engine.device.current().entries().first().json["writeTargets"])
            val deletion = engine.nextPush()!!.items("intents").single().items("d").single()
            assertEquals(Json.of("run00001"), deletion["id"])
            assertEquals(Json.of("5001:0:srv"), deletion["born"])
            assertTrue(engine.device.current().notices.isEmpty())
        }
    }
}
