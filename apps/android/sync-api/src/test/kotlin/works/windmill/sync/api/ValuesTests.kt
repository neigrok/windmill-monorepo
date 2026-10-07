package works.windmill.sync.api

import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.Delta
import works.windmill.sync.core.Guard
import works.windmill.sync.core.Intent
import works.windmill.sync.core.Json
import works.windmill.sync.core.JsonError
import works.windmill.sync.core.Lattice
import works.windmill.sync.core.Life
import works.windmill.sync.core.PushResult
import works.windmill.sync.core.RecordKey
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.Row
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.Stamp
import works.windmill.sync.core.TextBase
import works.windmill.sync.core.TextState
import works.windmill.sync.core.TextWrite

class ValuesTests {
    val stamp = Stamp("1:0:r_aaaaaaaaaaaa")
    val id = RecordID("r1")
    val scope = ScopeRef.product("probe")

    @Test fun canonicalEquivalenceNeverCollapsesProductValues() {
        val names = listOf("é", "e\u0301")
        val pairs: List<List<Any>> = listOf(
            names.map { RecordRef(it, id) }, names.map { RegisterRef("card", id, it) }, names.map { OrderAnchor(it, null) },
            names.map { NewID.Seeded(it, 1) }, names.map { NewID.Derived(it) }, names.map { NewID.Given(RecordID(it)) },
            names.map { TextEdit(it, it) }, names.map { Change.update(it, id) }, names.map { DeviceWrite(it, null) },
            names.map { Gesture(emptyList(), gestureId = it) },
            names.map { CommitReceipt(it, stamp, listOf(it), emptyList(), null, listOf(it)) },
            names.map { TextValue(it, false, false) },
            names.map { Record(it, id, null, null, emptyMap(), emptyMap(), emptyMap(), null, null, true, false, false) },
            names.map { Notice(it, it, scope, RefusalCode.cap, null, NoticeContent(), 1) },
            names.map { UndoOffer(it, scope, 1) }, names.map { Command(it, Json.objectOf()) },
            names.map { CommitFailure(CommitFailure.Kind.malformed, it) },
        )
        for (pair in pairs) assertEquals(pair.toString(), 2, pair.toSet().size)
    }

    @Test fun recordIdsAreJcsIdentityAndUtf8Ordered() {
        assertEquals(RecordID.pair("a", "b"), RecordID.fromText("[\"a\",\"b\"]"))
        assertNotEquals(RecordID("[\"a\",\"b\"]"), RecordID.pair("a", "b"))
        assertEquals(listOf("a", "b"), RecordID.pair("a", "b").parts)
        assertNull(RecordID.pair("a", "b").string)
        assertNull(RecordID("a").parts)
        assertEquals("\"a\"", RecordID("a").text)
        assertTrue(RecordID("\uE000") < RecordID("😀"))
        assertTrue(RecordKey("a", RecordID("z")) < RecordKey("b", RecordID("a")))
        for (invalid in listOf("[]", "1", "null", "[\"a\",1]")) assertThrows(JsonError::class.java) { RecordID.fromText(invalid) }
    }

    @Test fun scopeDecodingHasExactlyTheFourWireShapes() {
        for (value in listOf(scope, ScopeRef.tree("t1"), ScopeRef.overlay("t1"), ScopeRef.device("probe"))) {
            assertEquals(value, ScopeRef(value.text)); assertEquals(value, ScopeRef(value.json))
        }
        assertEquals("t1", ScopeRef.overlay("t1").tree)
        assertNull(scope.tree)
        assertEquals(ScopeRef.product("overlay/t1"), ScopeRef.overlay("t1"))
        for (invalid in listOf("self/", "tree/a/b", "self/other/a", "device/a/b", "self/é", "self/a\n")) {
            assertThrows(JsonError::class.java) { ScopeRef(invalid) }
        }
    }

    @Test fun allChangeOperationsRetainTheirIdentityAndAnchor() {
        val anchor = OrderAnchor("order", id)
        val changes = listOf(Change.create("card", NewID.Given(id), anchor = anchor), Change.update("card", id),
            Change.delete("card", id), Change.revive("card", id), Change.put("card", id, null),
            Change.write("card", id), Change.move("card", id, anchor))
        assertTrue(changes.all { it.id == id })
        assertEquals(anchor, changes.first().anchor); assertEquals(anchor, changes.last().anchor)
        assertNull(Change.create("card").id)
        assertNull(Change.create("card", NewID.Seeded("seed", 2)).id)
        assertNull(Change.create("card", NewID.Derived("label")).id)
        assertEquals(7, changes.map { it.operation.javaClass }.toSet().size)
    }

    @Test fun gestureCarriesExactRegistersRetirementAndDeviceDeletion() {
        val guard = RegisterRef("card", id, "title")
        val retired = RecordRef("card", id)
        val gesture = Gesture(listOf(Change.delete("card", id)), atomic = true, hold = true, guards = listOf(guard),
            retire = listOf(retired), supersede = listOf("older"), command = Command("probe.run", Json.objectOf()),
            predict = listOf(Change.update("card", id)), local = listOf(DeviceWrite("draft", null)), gestureId = "g1")
        assertEquals(listOf(guard), gesture.guards); assertEquals(RecordKey("card", id), guard.key)
        assertEquals(listOf(retired), gesture.retire); assertEquals(guard.key, retired.key)
        assertEquals(listOf("older"), gesture.supersede); assertNull(gesture.local.single().value)
        assertEquals(gesture, gesture.copy())
    }

    @Test fun receiptAndRefusalPreserveEveryPublicMember() {
        val receipt = CommitReceipt("g1", stamp, listOf("i1"), listOf(id, null), 9001, listOf("retired"), listOf("superseded"))
        assertEquals(receipt, (CommitOutcome.Committed(receipt)).receipt)
        val detail = Json.objectOf("type" to Json.of("card"), "cap" to Json.of(200))
        assertEquals(detail, CommitOutcome.Refused(RefusalCode.cap, detail).detail)
        assertNull(CommitOutcome.Refused(RefusalCode.scopeDead, null).notice)
        assertEquals("notice:g1/0", CommitOutcome.Refused(RefusalCode.tooLarge, null, "notice:g1/0").notice)
        assertEquals("new-product-code", RefusalCode("new-product-code").text)
        assertEquals(18, RefusalCode.engine.size)
    }

    @Test fun wireValuesRoundTripWithoutEmptyOptionalMaps() {
        val key = RecordKey("card", id)
        val row = Row(key, Lattice(life = Life("alive", stamp), born = stamp), mapOf("body" to TextState("é", 2, true)),
            mapOf("serial" to Json.of(7)), 3, 10, 11)
        assertEquals(row, Row(row.json))
        val delta = Delta(key, row.lattice, mapOf("body" to TextWrite("new", TextBase.Text("old"))))
        assertEquals(delta, Delta(delta.json)); assertTrue(delta.creates); assertFalse(delta.removes)
        val intent = Intent(scope, 4, listOf(delta), listOf(Guard(key, "title", null)), Command("probe.run", Json.objectOf()), "g1")
        assertEquals(intent, Intent(intent.json))
        assertEquals("{\"scope\":\"self/probe\"}", Intent(scope).json.jcs)
        assertEquals("{\"id\":\"r1\",\"seq\":0,\"t\":\"card\"}", Row(key, seq = 0).json.jcs)
        assertThrows(JsonError::class.java) { Row(Json.parse("{\"t\":\"card\",\"id\":\"r1\",\"seq\":0,\"x\":{\"é\":{\"text\":\"\",\"rev\":0,\"merged\":false}}}")) }
    }

    @Test fun allFailureKindsHaveTheNormativeLabelsAndValueEquality() {
        assertEquals(listOf("not-writable", "malformed", "store-failure"), CommitFailure.Kind.entries.map { it.wire })
        for (kind in CommitFailure.Kind.entries) {
            val failure = CommitFailure(kind, "bounded description")
            assertEquals(failure, CommitFailure(kind, "bounded description"))
            assertEquals(failure.hashCode(), CommitFailure(kind, "bounded description").hashCode())
            assertEquals("bounded description", failure.message)
        }
        assertEquals(CommitFailure.Kind.malformed, CommitFailure.malformed("misuse").kind)
    }

    @Test fun resultCallbacksRetainIntentResultGestureAndProductDeviceRows() {
        val command = Command("probe.run", Json.objectOf())
        val intent = Intent(ScopeRef.product("probe"), n = 3, command = command)
        val result = PushResult(Json.parse("{\"n\":3,\"s\":\"refused\",\"code\":\"stale\",\"detail\":{\"reason\":\"newer\"}}"))
        val rows = mapOf("draft" to Json.of("present"))
        val writes: IntentResultDeviceWrites = { submitted, response, epoch, gestureId, device ->
            assertEquals(intent, submitted); assertEquals(result, response); assertEquals("ep-1", epoch)
            assertEquals("gesture-1", gestureId); assertEquals(rows, device)
            listOf(DeviceWrite("draft", null))
        }
        val pending: PendingDeviceWork = { product, device -> assertEquals("probe", product); device.keys.toList() }
        assertEquals(listOf(DeviceWrite("draft", null)), writes(intent, result, "ep-1", "gesture-1", rows))
        assertEquals(listOf("draft"), pending("probe", rows))
        assertEquals(PushResult.Verdict.Refused(RefusalCode.stale), result.verdict)
    }
}
