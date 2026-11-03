package works.windmill.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.sync.core.Json

class TurnWireTests {
    private fun data(text: String) = Json.parse(text)
    private fun frames(text: String) = TurnSse().consume(text.encodeToByteArray())
    private fun fault(work: () -> Unit) = assertThrows(TurnWireFault::class.java) { work() }.kind

    @Test fun everyFrameDecodes() {
        val batch = TurnBatch(2, listOf(ToolCall("toolu_1", "list_things", data("""{"a":1}"""))))
        assertEquals(TurnEvent.Text("Hi"), TurnEvent.of("text", data("""{"delta":"Hi"}""")))
        assertEquals(TurnEvent.Calls(batch), TurnEvent.of("calls", data("""{"batch":2,"calls":[{"callId":"toolu_1","name":"list_things","input":{"a":1}}]}""")))
        assertEquals(TurnEvent.Snapshot("So far", TurnState.running, batch),
            TurnEvent.of("snapshot", data("""{"text":"So far","state":"running","calls":{"batch":2,"calls":[{"callId":"toolu_1","name":"list_things","input":{"a":1}}]}}""")))
        assertEquals(TurnEvent.Snapshot("So far", TurnState.completed, null), TurnEvent.of("snapshot", data("""{"text":"So far","state":"completed"}""")))
        assertEquals(TurnEvent.Snapshot("So far", TurnState.running, null), TurnEvent.of("snapshot", data("""{"text":"So far","state":"running","calls":null}""")))
        assertEquals(TurnEvent.Done(TurnState.completed, true), TurnEvent.of("done", data("""{"state":"completed","truncated":true,"allowance":{"code":"ok"}}""")))
        assertEquals(TurnEvent.Done(TurnState.stopped, false), TurnEvent.of("done", data("""{"state":"stopped"}""")))
        assertEquals(TurnEvent.Error("coach-vendor-error", null), TurnEvent.of("error", data("""{"code":"coach-vendor-error"}""")))
        assertEquals(TurnEvent.Error("free_month_exhausted", 1_793_491_200_000), TurnEvent.of("error", data("""{"code":"free_month_exhausted","budgetResetsAtMs":1793491200000}""")))
        assertEquals(TurnEvent.Error("free_month_exhausted", null), TurnEvent.of("error", data("""{"code":"free_month_exhausted","budgetResetsAtMs":null}""")))
        assertEquals(TurnEvent.Error("free_month_exhausted", null), TurnEvent.of("error", data("""{"code":"free_month_exhausted","budgetResetsAtMs":1.5}""")))
    }

    @Test fun aFrameThatCannotBeReadIsAFault() {
        assertEquals(TurnWireFault.unknownEvent, fault { TurnEvent.of("gift", data("{}")) })
        assertEquals(TurnWireFault.unknownState, fault { TurnEvent.of("done", data("""{"state":"resting"}""")) })
        assertEquals(TurnWireFault.unknownState, fault { TurnEvent.of("done", data("""{"state":"running"}""")) })
        assertEquals(TurnWireFault.unreadable, fault { TurnEvent.of("text", data("{}")) })
        assertEquals(TurnWireFault.unreadable, fault { TurnEvent.of("text", data("""{"delta":1}""")) })
        assertEquals(TurnWireFault.unreadable, fault { TurnEvent.of("calls", data("""{"batch":0,"calls":[]}""")) })
        assertEquals(TurnWireFault.unreadable, fault { TurnEvent.of("calls", data("""{"batch":1.5,"calls":[]}""")) })
    }

    @Test fun onlyAClosingFrameCloses() {
        assertEquals(listOf(true, true, false, false, false, false), listOf(
            TurnEvent.Done(TurnState.completed, false), TurnEvent.Error("coach-busy", null), TurnEvent.Snapshot("", TurnState.failed, null),
            TurnEvent.Snapshot("", TurnState.running, null), TurnEvent.Text(""), TurnEvent.Calls(TurnBatch(1, emptyList())),
        ).map { it.closing })
    }

    @Test fun theStreamToleratesCommentsCrlfMultilineDataAndOtherFields() {
        val text = ": heartbeat\n\n: another\nid: 7\nretry: 100\nevent: text\r\ndata: {\"delta\":\r\ndata:   \"Hi\"}\r\n\r\nevent:done\ndata:{\"state\":\"completed\"}\n\n"
        assertEquals(listOf(TurnEvent.Text("Hi"), TurnEvent.Done(TurnState.completed, false)), frames(text))
    }

    @Test fun aFrameCanArriveInPiecesOfAnySize() {
        val bytes = "event: text\ndata: {\"delta\":\"Жим 100 кг 💪\"}\n\nevent: done\ndata: {\"state\":\"completed\"}\n\n".encodeToByteArray()
        val whole = listOf(TurnEvent.Text("Жим 100 кг 💪"), TurnEvent.Done(TurnState.completed, false))
        for (split in bytes.indices) {
            val parser = TurnSse()
            val pieces = parser.consume(bytes.copyOfRange(0, split)) + parser.consume(bytes.copyOfRange(split, bytes.size))
            assertEquals("split at $split", whole, pieces)
        }
        val parser = TurnSse()
        assertEquals(whole, bytes.flatMap { parser.consume(byteArrayOf(it)) })
        assertEquals(whole, TurnSse().consume(bytes + "trailing".encodeToByteArray(), bytes.size))
    }

    @Test fun aFrameWithoutDataIsNoFrameAndForgetsItsName() {
        assertEquals(emptyList<TurnEvent>(), frames("event: done\n\n\n\n"))
        assertEquals(listOf(TurnEvent.Text("Hi")), frames("event: done\n\nevent: text\ndata: {\"delta\":\"Hi\"}\n\n"))
        assertEquals(TurnWireFault.unknownEvent, fault { frames("event: done\n\ndata: {\"state\":\"completed\"}\n\n") })
    }

    @Test fun theLineBoundHoldsToTheByte() {
        val room = TurnSse.maxLineBytes - "data: {\"delta\":\"\"}".length
        val atTheBound = "event: text\ndata: {\"delta\":\"${"x".repeat(room)}\"}\n\n"
        assertEquals(listOf(TurnEvent.Text("x".repeat(room))), frames(atTheBound))
        assertEquals(TurnWireFault.lineTooLong, fault { frames("event: text\ndata: {\"delta\":\"${"x".repeat(room + 1)}\"}\n\n") })
        assertEquals(TurnWireFault.lineTooLong, fault { frames(": ${"x".repeat(TurnSse.maxLineBytes)}\n") })
    }

    @Test fun theDataOfOneFrameIsBoundToo() {
        val line = "data: ${" ".repeat(TurnSse.maxLineBytes / 2)}\n"
        assertEquals(TurnWireFault.lineTooLong, fault { frames(line + line + line) })
    }

    @Test fun bytesOrDataThatCannotBeReadAreAFault() {
        assertEquals(TurnWireFault.unreadable, fault { frames("data: {not json}\n\n") })
        assertEquals(TurnWireFault.unreadable, fault { TurnSse().consume(byteArrayOf(0xC3.toByte(), 0x28, 10)) })
    }

    @Test fun aRefusalReadsItsCodeAndItsReset() {
        fun refusal(body: String, status: Int = 429) = TurnRefusal.of(status, body.encodeToByteArray())
        assertEquals(TurnRefusal(429, "free_day_exhausted", 1_793_000_000_000), refusal("""{"error":"Paused","code":"free_day_exhausted","allowance":{"budgetResetsAtMs":1793000000000}}"""))
        assertEquals(TurnRefusal(429, "subject_exhausted", null), refusal("""{"code":"subject_exhausted","allowance":{"budgetResetsAtMs":null}}"""))
        assertEquals(TurnRefusal(429, "subject_exhausted", null), refusal("""{"code":"subject_exhausted","allowance":{"budgetResetsAtMs":1.5}}"""))
        assertEquals(TurnRefusal(429, "subject_exhausted", null), refusal("""{"code":"subject_exhausted","allowance":"none"}"""))
        assertEquals(TurnRefusal(502, TurnRefusal.vendorError, null), refusal("<html>Bad gateway</html>", 502))
        assertEquals(TurnRefusal(500, TurnRefusal.vendorError, null), refusal("""{"code":""}""", 500))
        assertEquals(TurnRefusal(500, TurnRefusal.vendorError, null), refusal("""{"code":7}""", 500))
    }

    @Test fun aRefusalBodyOfAnyShapeIsARefusal() {
        val bodies = listOf(byteArrayOf(0xC3.toByte(), 0x28, 0xFF.toByte())) + listOf("[1,2]", "\"oops\"", "null", """{"code":"x","allowance":null}""", """{"code":"x","allowance":7}""",
            """{"code":"x","allowance":{"budgetResetsAtMs":1e300}}""", "[".repeat(5000), """{"code":"\ud800"}""", """{"code":"a","code":"b"}""").map { it.encodeToByteArray() }
        for (body in bodies) assertEquals(500, TurnRefusal.of(500, body).status)
    }

    @Test fun anyPrefixOfABodyOrFrameFaultsOnlyAsAWireFault() {
        val whole = """{"error":"éé\n","code":"free_month_exhausted","allowance":{"budgetResetsAtMs":1793491200000,"x":[1,2.5e3,true,null]}}"""
        for (end in whole.indices) {
            assertEquals(429, TurnRefusal.of(429, whole.substring(0, end).encodeToByteArray()).status)
            val failure = runCatching { frames("event: error\ndata: ${whole.substring(0, end)}\n\n") }.exceptionOrNull()
            assertTrue("$end → $failure", failure == null || failure is TurnWireFault)
        }
    }

    @Test fun capsAreTheCodesTheServerRefills() {
        fun capped(code: String) = TurnRefusal(503, code, null).capped
        assertEquals(listOf(true, true, true, true, true, true, true),
            listOf("subject_exhausted", "free_month_exhausted", "free_day_exhausted", "concurrency_exhausted", "funding_required", "debt_outstanding", "coach-rate-limited").map(::capped))
        assertEquals(listOf(false, false, false, false), listOf("device_bound", "invalid_installation", "coach-busy", "coach-vendor-error").map(::capped))
    }

    @Test fun theBodiesAreTheWireShapeInCanonicalForm() {
        val open = TurnOpen("tn_1", "catalog/2", "Hi", listOf(TurnPicture("p1", "image/jpeg", byteArrayOf(1, 2, 3))), listOf(TurnLine("lifter", "Before")),
            listOf(ContextRead("list_things", Json.objectOf(), data("""{"things":[]}"""))), emptyList())
        assertEquals("""{"catalog":"catalog/2","context":[{"input":{},"name":"list_things","result":{"things":[]}}],"history":[{"role":"lifter","text":"Before"}],"pictures":[{"data":"AQID","id":"p1","mediaType":"image/jpeg"}],"question":"Hi","turnId":"tn_1"}""",
            open.json.jcs)
        assertEquals("""{"batch":2,"results":[{"callId":"a","ok":true,"result":{"n":1}},{"callId":"b","code":"record-dead","ok":false}]}""",
            turnAnswer(2, listOf(ToolOutcome.Ok("a", "one", data("""{"n":1}""")), ToolOutcome.Refused("b", "two", "record-dead"))).jcs)
    }

    @Test fun aLabelHoldsAWordAndACodeIsBoundToTheKnownSet() {
        assertEquals(listOf("list_things", "record-dead", "other", "other", "other", "other"),
            listOf("list_things", "record-dead", "How is my squat going?", "Bearer abc", "", "x".repeat(65)).map { TurnLabel.of(it).value })
        assertEquals(listOf("coach-turn-order", "subject_exhausted", "storage", "transport", "decode", "refusal", "other", "other"),
            listOf("coach-turn-order", "subject_exhausted", "storage", "transport", "decode", "refusal", "http", "something-new").map { TurnLabel.code(it).value })
    }

    @Test fun aSeatPrintsWithoutItsCredential() {
        assertEquals(listOf("TurnSeat.Bound", "TurnSeat.Anon"), listOf(TurnSeat.Bound("secret").toString(), TurnSeat.Anon("secret").toString()))
    }
}
