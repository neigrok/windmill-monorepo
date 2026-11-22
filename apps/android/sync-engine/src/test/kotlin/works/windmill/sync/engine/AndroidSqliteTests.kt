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
import works.windmill.sync.schema.SyncSchema

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
    @Test fun laterActSegmentFailureAndRefusalRollBackSQLiteOnReopen() = database { file ->
        val before = open(file).use { it.snapshot() }
        val board = ScopedGesture(scope, Gesture(listOf(Change.create("board", NewID.Given(RecordID("b_00000001")))),
            local = listOf(DeviceWrite("rack", Json.of(7)))))
        open(file).use { engine ->
            assertThrows(IllegalStateException::class.java) { engine.commitAct({ ActRequest(listOf(scope, ScopeRef.tree("b_00000001"))) to Unit },
                { _, index, _ -> if (index == 0) board.gesture else throw IllegalStateException("late-storage-failure") }) }
        }
        open(file).use { engine ->
            assertEquals(before, engine.snapshot())
            val cards = (1..4).map { ScopedGesture(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card000$it")), mapOf("title" to Json.of("Card")))))) }
            val result = engine.commitAct(listOf(board) + cards) as ActCommitOutcome.Refused
            assertEquals(4, result.segment); assertEquals(RefusalCode.cap, result.code)
        }
        open(file).use { assertEquals(before, it.snapshot()) }
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
    // Opening parses every entry and notice under MAX_DEPTH, so a value the store could not read back would stop the app opening. The deepest a commit admits reads back as an entry, and as a dependent of a notice, the deepest form; one level more is refused and writes nothing.
    @Test fun nothingACommitAdmitsIsTooDeepToReadBack() = database { file ->
        val gym = SyncSchema.registry
        val scope = ScopeRef.product("gym")
        val replica = "rp_00000000000000000000000000000001"
        val initial = Json.objectOf("active" to Json.of(replica), "replicas" to Json.array(freshReplica(replica).json()))
        val message = RecordID("turnAAAAAAAAAAA1")
        fun deep(depth: Int): Json = (0 until depth).fold(Json.of(1)) { inner, _ -> Json.objectOf("a" to inner) }
        fun calls(depth: Int) = Gesture(listOf(Change.update("message", message, mapOf("calls" to deep(depth)))))
        val deepest = Json.MAX_DEPTH - 8
        AndroidSqlite.open(file, gym, initial, clock, ids, "actor").use { engine ->
            engine.commit(scope, Gesture(listOf(Change.create("thread", NewID.Given(RecordID("thrdAAAAAAAAAAA1")), mapOf("title" to Json.of("q"))),
                Change.create("message", NewID.Given(message), mapOf("threadId" to Json.of("thrdAAAAAAAAAAA1"), "role" to Json.of("coach"), "at" to Json.of(1), "text" to Json.of(""), "replica" to Json.of(replica)))),
                atomic = true, gestureId = "open"))
            val before = engine.snapshot()
            assertEquals(CommitFailure.Kind.malformed, assertThrows(CommitFailure::class.java) { engine.commit(scope, calls(deepest + 1)) }.kind)
            assertEquals(CommitFailure.Kind.malformed, assertThrows(CommitFailure::class.java) {
                engine.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("runningTurn", deep(Json.MAX_DEPTH + 1)))))
            }.kind)
            assertEquals(before, engine.snapshot())
            assertTrue(engine.commit(scope, calls(deepest).copy(gestureId = "deep", local = listOf(DeviceWrite("runningTurn", deep(Json.MAX_DEPTH))))) is CommitOutcome.Committed)
        }
        AndroidSqlite.open(file, gym, initial, clock, ids, "actor").use { engine ->
            assertEquals(Json.MAX_DEPTH, engine.read(scope) { it.device("runningTurn") }!!.depth)
            engine.write { held ->
                val opening = held.entries().first { it.gestureId == "open" }
                opening.state = "sent"
                engine.refuse(held, opening, "refuse", "invalid")
            }
            assertEquals(1, engine.device.current().notices.single().member("content").items("dependents").size)
            assertEquals(Json.MAX_DEPTH, engine.device.current().notices.single().depth)
        }
        AndroidSqlite.open(file, gym, initial, clock, ids, "actor").use { engine ->
            assertEquals(1, engine.device.current().notices.size)
        }
    }
    // A Coach turn's round sits in `runningRound` beside `runningTurn`. A build whose registry declares no `runningRound` opens the same store, reads and clears
    // `runningTurn`, keeps the round's row untouched, and cannot write one.
    @Test fun aBuildThatKnowsNoRunningRoundStillReadsAndClearsTheRunningTurnOfAStoreHoldingOne() = database { file ->
        val scope = ScopeRef.product("gym")
        val replica = "rp_00000000000000000000000000000001"
        val initial = Json.objectOf("active" to Json.of(replica), "replicas" to Json.array(freshReplica(replica).json()))
        val source = Json.parse(File(System.getProperty("windmill.contract"), "sync/gym.registry.json").readBytes())
        val gym = source.member("products").member("gym")
        val older = Registry(source.with("products" to source.member("products").with("gym" to gym.with("device" to gym.member("device").with("runningRound" to null)))))
        val round = Json.objectOf("message" to Json.of("coach0000000001"), "callId" to Json.of("AAAAAAAAAAAAAAAAAAAAAA"), "bytesBefore" to Json.of(17))
        AndroidSqlite.open(file, SyncSchema.registry, initial, clock, ids, "actor").use { engine ->
            engine.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("runningTurn", Json.of("coach0000000001")), DeviceWrite("runningRound", round))))
            assertEquals(listOf(Json.of("coach0000000001"), round), engine.read(scope) { listOf(it.device("runningTurn"), it.device("runningRound")) })
        }
        AndroidSqlite.open(file, older, initial, clock, ids, "actor").use { engine ->
            assertEquals(listOf(Json.of("coach0000000001"), round), engine.read(scope) { listOf(it.device("runningTurn"), it.device("runningRound")) })
            val before = engine.snapshot()
            assertEquals(CommitFailure.Kind.malformed, assertThrows(CommitFailure::class.java) {
                engine.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("runningRound", null))))
            }.kind)
            assertEquals(before, engine.snapshot())
            engine.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("runningTurn", null))))
        }
        AndroidSqlite.open(file, SyncSchema.registry, initial, clock, ids, "actor").use { engine ->
            assertEquals(listOf(null, round), engine.read(scope) { listOf(it.device("runningTurn"), it.device("runningRound")) })
        }
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

    @Test fun aReservedUndoKeepsItsBarrierAcrossReopenAndStartKeepsOnlyTheActItInverts() = database { file ->
        val vector = Json.parse(File(System.getProperty("windmill.contract"), "sync/corpus/undo/restore.json").readBytes()).arr()
            .single { it.member("name").str().startsWith("an inverse slot whose source is still held stops numbering") }
        val steps = vector.member("input").member("steps").arr()
        var gestures = 0
        val counted = object : IdentitySource { override fun opaqueID() = "g${++gestures}"; override fun draw(bound: Int) = 0 }
        fun reopen() = AndroidSqlite.open(file, registry, vector.member("input").member("device"), clock, counted, "r_aaaaaaaaaaaa")
        val held = reopen().use { engine ->
            val undo = steps[0].member("opts").member("undo").member("segments").arr().map { segment ->
                UndoSegment(segment.member("index").long().toInt(), segment.member("recipes").arr().map(UndoRecipe::read)) }
            val segments = listOf(Gesture(listOf(Change.update("card", RecordID("cardAAAA0001"), mapOf("title" to Json.of("New"))))),
                Gesture(listOf(Change.write("meta", RecordID("meta"), mapOf("title" to Json.of("Grown"))))))
            engine.commitAct({ ActRequest(listOf(scope, ScopeRef.tree("b_00000001")), hold = true, undo = undo) to segments }, { values, index, _ -> values[index] })
            assertTrue(engine.release("g1/0"))
            val pushed = engine.nextPush()!!
            val response = steps[3].member("response")
            engine.onPushResponse(pushed, SyncResponse(response.member("status").long().toInt(), response["body"]),
                RequestTiming(ClockReading(6_000, 6_000, "boot"), ClockReading(6_000, 6_000, "boot")))
            assertEquals(works.windmill.sync.api.InverseResult.Pending("g3", "g2", true), engine.requestInverse("g1"))
            assertNull(engine.nextPush())
            engine.snapshot()
        }
        reopen().use { engine ->
            assertEquals(held, engine.snapshot())
            assertEquals(listOf("g1", "g2"), engine.snapshot().member("replicas").arr().single().member("journal").arr().map { it.member("actId").str() })
            assertNull(engine.nextPush())
            engine.start()
            assertEquals(listOf("g1"), engine.snapshot().member("replicas").arr().single().member("journal").arr().map { it.member("actId").str() })
            assertEquals(listOf(ScopeRef.tree("b_00000001").json), engine.nextPush()!!.member("intents").arr().map { it.member("scope") })
        }
        SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            val stored = listOf("reversible_act", "inverse_request").map { table -> db.rawQuery("SELECT COUNT(*) FROM $table", null).use { it.moveToFirst(); it.getInt(0) } }
            assertEquals(listOf(1, 1), stored)
        }
    }
    @Test fun anAcknowledgedScopedCommandKeepsEachProjectionAndReceiptAcrossReopenAndSettlesOneTargetAtATime() = database { file ->
        val vector = Json.parse(File(System.getProperty("windmill.contract"), "sync/corpus/write/scoped-predictions.json").readBytes()).arr()
            .single { it.member("name").str() == "after restart a covering newer text deactivates only that target and reset does not revive it" }
        val device = vector.member("input").member("device")
        val origin = ScopeRef.overlay("b_00000001"); val target = ScopeRef.overlay("b_00000002")
        fun reopen() = AndroidSqlite.open(file, registry, device, clock, ids, "actor")
        fun memo(engine: Engine, scope: ScopeRef) = engine.read(scope) { it.drawn("mark", RecordID("oak"))!!.texts.getValue("memo").text }
        reopen().use { engine ->
            assertEquals(device, engine.snapshot())
            assertEquals(listOf("mine origin", "mine target"), listOf(memo(engine, origin), memo(engine, target)))
        }
        SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            val touched = db.rawQuery("SELECT scope FROM outbox_touch WHERE local_id='g1/0' ORDER BY scope", null).use { rows -> buildList { while (rows.moveToNext()) add(rows.getString(0)) } }
            assertEquals(listOf(origin.text, target.text), touched)
        }
        reopen().use { engine ->
            val timing = RequestTiming(ClockReading(6_000, 6_000, "boot"), ClockReading(6_000, 6_000, "boot"))
            val page = vector.member("input").member("steps").arr()[1].member("response")
            engine.onPullResponse(engine.pullRequest(listOf(target))!!, SyncResponse(page.member("status").long().toInt(), page.member("body")), timing)
        }
        reopen().use { engine ->
            val projections = engine.snapshot().member("replicas").arr().single().member("outbox").arr().single().member("predictions").arr()
            assertEquals(listOf(Json.Null, Json.of(true)), projections.map { it["covered"] ?: Json.Null })
            assertEquals(listOf("mine origin", "newer target"), listOf(memo(engine, origin), memo(engine, target)))
        }
    }
}
