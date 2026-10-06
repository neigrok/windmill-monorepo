package works.windmill.sync.engine

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.Command
import works.windmill.sync.core.RecordID

class EngineHooksTests {
    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
    private val scope = ScopeRef.product("probe")
    private val timing = RequestTiming(ClockReading(5_000, 5_000, "boot"), ClockReading(5_000, 5_000, "boot"))
    private fun engine(writes: CommandResultDeviceWrites = { _, _, _, _ -> emptyList() },
        rewrite: DeviceValueRewrite = { _, _, value, _, _, _ -> value }) = Engine.memory(registry,
        clock = object : EngineClock { override fun now() = 5_000L }, actor = "r_aaaaaaaaaaaa",
        commandResultWrites = writes, rewriteDeviceValue = rewrite).also { it.signIn("A", mapOf("probe" to false)) }
    private fun number(engine: Engine): Json {
        engine.commit(scope, Gesture(emptyList(), command = Command("probe.start", Json.objectOf(
            "id" to Json.of("run00001"), "startedAt" to Json.of(5_000), "join" to Json.of(false))),
            predict = listOf(Change.create("run", NewID.Given(RecordID("run00001")), mapOf("label" to Json.of("Run")))),
            local = listOf(DeviceWrite("rack", Json.objectOf("run" to Json.of("run00001"))))))
        return engine.nextPush()!!
    }
    private fun response(request: Json, refused: Boolean = false, write: Boolean = false): SyncResponse {
        val n = request.member("intents").arr().single().member("n")
        val result = if (refused) Json.objectOf("n" to n, "s" to Json.of("refused"), "code" to Json.of("invalid"))
        else Json.objectOf("n" to n, "s" to Json.of("ok"), "seq" to Json.of(1)).with("write" to if (write)
            Json.array(Json.objectOf("t" to Json.of("run"), "id" to Json.of("run00002"), "from" to Json.of("run00001"), "f" to Json.objectOf())) else null)
        return SyncResponse(200, Json.objectOf("epoch" to Json.of("ep-1"), "as" to Json.of("A"), "lastN" to n, "results" to Json.array(result)))
    }

    @Test fun aBornOnlyPrerequisiteThatExceedsTheFinalPushLimitRollsBackTheCommandAndJournal() {
        engine().use { normal ->
            normal.commit(scope, Gesture(listOf(Change.create("run", NewID.Given(RecordID("run00001")), mapOf("label" to Json.of("Run"))))))
            val source = normal.snapshot()
            val gesture = Gesture(listOf(Change.update("run", RecordID("run00001"))),
                command = Command("probe.start", Json.objectOf("id" to Json.of("run00002"), "startedAt" to Json.of(5_000), "join" to Json.of(false))),
                local = listOf(DeviceWrite("rack", Json.of("original source"))))
            normal.commit(scope, gesture)
            val cap = widestBytes(normal.device.current(), normal.device.current().entries().last().intent)
            Engine.memory(registry, source, clock = object : EngineClock { override fun now() = 5_000L },
                actor = "r_aaaaaaaaaaaa", pushMaxBytes = cap).use { limited ->
                val before = limited.snapshot()
                val failure = assertThrows(CommitFailure::class.java) { limited.commitWithPrerequisites(scope) { gesture to Unit } }
                assertEquals("too-large", failure.description); assertEquals(before, limited.snapshot())
                assertNull(limited.read(scope) { it.device("rack") })
            }
        }
    }

    @Test fun packagingNeverRetiresAGestureWithAnotherWorkoutsAuthoredRecords() {
        Engine.memory(registry, clock = object : EngineClock { override fun now() = 5_000L }, actor = "r_aaaaaaaaaaaa").use { e ->
            e.commit(scope, Gesture(listOf(
                Change.create("run", NewID.Given(RecordID("run00001")), mapOf("label" to Json.of("First"))),
                Change.create("run", NewID.Given(RecordID("run00002")), mapOf("label" to Json.of("Second")))), atomic = true))
            val before = e.snapshot()
            val failure = assertThrows(CommitFailure::class.java) { e.commitWithPrerequisites(scope) { context ->
                val selected = e.unsubmittedGestures(context, scope, setOf(RecordKey("run", RecordID("run00001"))))
                Gesture(emptyList(), supersede = selected, local = listOf(DeviceWrite("rack", Json.of("original source")))) to Unit
            } }
            assertEquals("supersede-mixed", failure.description); assertEquals(before, e.snapshot())
            assertNull(e.read(scope) { it.device("rack") })
        }
    }

    @Test fun commandResultReceivesDeviceSnapshotAndCommitsItsWritesWithTheVerdict() {
        var calls = 0
        engine(writes = { command, result, epoch, rows ->
            calls++
            assertEquals("probe.start", command.name)
            assertEquals(1L, result.n)
            assertEquals("ep-1", epoch)
            assertEquals(mapOf("rack" to Json.objectOf("run" to Json.of("run00001"))), rows)
            listOf(DeviceWrite("rack", Json.objectOf("saved" to Json.of(true))))
        }).use { engine ->
            val request = number(engine)
            engine.onPushResponse(request, response(request), timing)
            assertEquals(1, calls)
            assertEquals("acked", engine.device.current().entries().single().state)
            assertEquals(Json.objectOf("saved" to Json.of(true)), engine.read(scope) { it.device("rack") })
            assertEquals(1L, engine.device.current().meta.member("ackThrough").long())
        }
    }

    @Test fun refusedCommandMayDeleteItsDeviceStateInTheSameResultTransaction() {
        engine(writes = { _, result, _, _ ->
            assertTrue(result.verdict is PushResult.Verdict.Refused)
            listOf(DeviceWrite("rack", null))
        }).use { engine ->
            val request = number(engine)
            engine.onPushResponse(request, response(request, refused = true), timing)
            assertNull(engine.read(scope) { it.device("rack") })
            assertTrue(engine.device.current().entries().isEmpty())
            assertEquals("invalid", engine.device.current().notices.single().member("code").str())
        }
    }

    @Test fun undeclaredDeviceKeyRollsBackTheResultAndEveryEarlierHookWrite() {
        engine(writes = { _, _, _, _ -> listOf(DeviceWrite("rack", Json.of("changed")), DeviceWrite("private-key", Json.of(true))) }).use { engine ->
            val request = number(engine)
            val before = engine.snapshot()
            val failure = assertThrows(CommitFailure::class.java) { engine.onPushResponse(request, response(request), timing) }
            assertEquals(CommitFailure.Kind.malformed, failure.kind)
            assertEquals(before, engine.snapshot())
        }
    }

    @Test fun failedResultCommitRollsBackDeviceWritesAndCanRetryTheSameSentCommand() {
        var calls = 0
        lateinit var instance: Engine
        instance = engine(writes = { _, _, _, _ ->
            if (++calls == 1) (instance.store as MemoryStore).failNextCommit = true
            listOf(DeviceWrite("rack", Json.objectOf("saved" to Json.of(true))))
        })
        instance.use { engine ->
            val request = number(engine)
            val before = engine.snapshot()
            val failure = assertThrows(CommitFailure::class.java) { engine.onPushResponse(request, response(request), timing) }
            assertEquals(CommitFailure.Kind.storeFailure, failure.kind)
            assertEquals(before, engine.snapshot())
            engine.onPushResponse(request, response(request), timing)
            assertEquals(2, calls)
            assertEquals("acked", engine.device.current().entries().single().state)
            assertEquals(Json.objectOf("saved" to Json.of(true)), engine.read(scope) { it.device("rack") })
        }
    }

    @Test fun throwingFoldedCommandHookRollsBackSourceRefusalDependentsAndDeviceJournal() {
        val failure = IllegalStateException("journal unavailable")
        var fail = true
        engine(writes = { command, result, _, rows ->
            assertEquals("probe.end", command.name)
            assertEquals(0L, result.n)
            assertEquals(RefusalCode.parentDead, (result.verdict as PushResult.Verdict.Refused).code)
            assertEquals(Json.of(true), rows.getValue("rack").member("pending"))
            if (fail) throw failure
            listOf(DeviceWrite("rack", Json.objectOf("refused" to Json.of("parent-dead"))))
        }).use { engine ->
            assertTrue(engine.commit(scope, Gesture(listOf(Change.create("run", NewID.Given(RecordID("run00001")), mapOf("label" to Json.of("Run")))),
                local = listOf(DeviceWrite("rack", Json.objectOf("pending" to Json.of(true)))))) is CommitOutcome.Committed)
            assertTrue(engine.commit(scope, Gesture(emptyList(), command = Command("probe.end", Json.objectOf(
                "runId" to Json.of("run00001"), "endedAt" to Json.of(5_000))))) is CommitOutcome.Committed)
            val request = engine.nextPush(1)!!
            val before = engine.snapshot()
            assertSame(failure, assertThrows(IllegalStateException::class.java) { engine.onPushResponse(request, response(request, refused = true), timing) })
            assertEquals(before, engine.snapshot())
            assertEquals(listOf("sent", "ready"), engine.device.current().entries().map { it.state })
            fail = false
            engine.onPushResponse(request, response(request, refused = true), timing)
            assertTrue(engine.device.current().entries().isEmpty())
            assertEquals(Json.objectOf("refused" to Json.of("parent-dead")), engine.read(scope) { it.device("rack") })
        }
    }

    @Test fun writeMapRewritesTheDeviceValueAfterApplyingCommandResultWrites() {
        var calls = 0
        engine(writes = { _, _, _, _ -> listOf(DeviceWrite("rack", Json.objectOf("run" to Json.of("run00001"), "saved" to Json.of(true)))) },
            rewrite = { product, key, value, type, from, to ->
                calls++
                assertEquals("probe", product); assertEquals("rack", key); assertEquals("run", type)
                assertEquals(RecordID("run00001"), from); assertEquals(RecordID("run00002"), to)
                assertEquals(Json.of(true), value.member("saved"))
                value.with("run" to to.json)
            }).use { engine ->
            val request = number(engine)
            engine.onPushResponse(request, response(request, write = true), timing)
            assertEquals(1, calls)
            assertEquals(Json.objectOf("run" to Json.of("run00002"), "saved" to Json.of(true)), engine.read(scope) { it.device("rack") })
            assertEquals(RecordID("run00002"), engine.device.current().entries().single().predict.single().key.id)
        }
    }

    @Test fun throwingDeviceRewriteRollsBackPredictionVerdictAndCommandResultWrites() {
        val failure = IllegalStateException("private device contents")
        engine(writes = { _, _, _, _ -> listOf(DeviceWrite("rack", Json.of("changed"))) }, rewrite = { _, _, _, _, _, _ -> throw failure }).use { engine ->
            val request = number(engine)
            val before = engine.snapshot()
            assertSame(failure, assertThrows(IllegalStateException::class.java) { engine.onPushResponse(request, response(request, write = true), timing) })
            assertEquals(before, engine.snapshot())
            assertEquals("sent", engine.device.current().entries().single().state)
        }
    }

    @Test fun pendingDeviceWorkCountsOnlyDistinctKeysWhoseRowsStillExist() {
        engine().use { engine ->
            engine.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("rack", Json.objectOf("pending" to Json.of(true))))))
            val question = engine.signOut(pendingDeviceWork = { product, rows ->
                assertEquals("probe", product)
                assertEquals(mapOf("rack" to Json.objectOf("pending" to Json.of(true))), rows)
                listOf("rack", "rack", "missing")
            })
            assertFalse(question.member("complete").bool())
            assertEquals(1L, question.member("pending").long())
            assertEquals(1L, question.member("unsent").long())
            assertEquals(listOf("device:probe:rack:${Sha256.hex(Json.objectOf("pending" to Json.of(true)).jcs.encodeToByteArray())}"),
                question.member("counted").arr().map(Json::str))
        }
    }

    private fun anonymousPending() = Engine.memory(registry,
        clock = object : EngineClock { override fun now() = 5_000L }, actor = "r_aaaaaaaaaaaa",
        pendingDeviceWork = { _, rows -> rows.keys.toList() + "missing" }).also {
        it.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("rack", Json.objectOf("pending" to Json.of(true))))))
    }

    @Test fun deviceOnlyAnonymousWorkRequiresPinnedAddAndSurvivesKeepAndReopen() {
        anonymousPending().use { engine ->
            val source = engine.activeReplica()
            val question = engine.signIn("A", mapOf("probe" to true))
            assertFalse(question.member("complete").bool())
            assertEquals(source, engine.activeReplica())
            assertEquals(Json.objectOf("pending" to Json.of(1)), question.member("due").arr().single().member("count"))
            val counted = question.member("due").arr().single().member("counted").arr().map(Json::str)
            assertTrue(engine.signIn("A", mapOf("probe" to true), mapOf("probe" to "add"), mapOf("probe" to counted)).flag("complete"))
            assertEquals(source, engine.activeReplica())
            assertEquals(Json.objectOf("pending" to Json.of(true)), engine.read(scope) { it.device("rack") })
            assertTrue(engine.signOut("keep").flag("complete"))
            Engine.memory(registry, engine.snapshot(), pendingDeviceWork = { _, rows -> rows.keys.toList() }).use { reopened ->
                assertTrue(reopened.signIn("A", mapOf("probe" to true)).flag("complete"))
                assertEquals(Json.objectOf("pending" to Json.of(true)), reopened.read(scope) { it.device("rack") })
            }
        }
    }

    @Test fun changedDeviceOnlyWorkCannotBeDiscardedByAnEarlierAnswer() {
        anonymousPending().use { engine ->
            val question = engine.signIn("A", mapOf("probe" to true))
            val counted = question.member("due").arr().single().member("counted").arr().map(Json::str)
            val corrected = Json.objectOf("pending" to Json.of(true), "revision" to Json.of(2))
            engine.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("rack", corrected))))
            assertFalse(engine.signIn("A", mapOf("probe" to true), mapOf("probe" to "discard"), mapOf("probe" to counted)).flag("complete"))
            assertEquals(corrected, engine.read(scope) { it.device("rack") })
            val current = engine.signIn("A", mapOf("probe" to true)).member("due").arr().single().member("counted").arr().map(Json::str)
            assertTrue(engine.signIn("A", mapOf("probe" to true), mapOf("probe" to "discard"), mapOf("probe" to current)).flag("complete"))
            assertNull(engine.read(scope) { it.device("rack") })
        }
    }

    @Test fun deviceOnlyWorkAddsToEmptyOrDormantAccountsWithoutBeingLost() {
        anonymousPending().use { engine ->
            assertTrue(engine.signIn("A", mapOf("probe" to false)).flag("complete"))
            assertEquals(Json.objectOf("pending" to Json.of(true)), engine.read(scope) { it.device("rack") })
            engine.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("rack", null))))
            engine.signOut("keep")
            engine.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("rack", Json.of("new")))))
            val question = engine.signIn("A", mapOf("probe" to true))
            val counted = question.member("due").arr().single().member("counted").arr().map(Json::str)
            assertTrue(engine.signIn("A", mapOf("probe" to true), mapOf("probe" to "add"), mapOf("probe" to counted)).flag("complete"))
            assertEquals(Json.of("new"), engine.read(scope) { it.device("rack") })
        }
    }

    @Test fun pendingJournalCountsItsRecordsAndRejectsMalformedCounts() {
        anonymousPending().use { engine ->
            engine.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("rack", Json.objectOf(
                "count" to Json.objectOf("run" to Json.of(2), "lap" to Json.of(7)))))))
            val question = engine.signIn("A", mapOf("probe" to true))
            assertEquals(Json.objectOf("run" to Json.of(2), "lap" to Json.of(7)), question.member("due").arr().single().member("count"))
            engine.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("rack", Json.objectOf(
                "count" to Json.objectOf("run" to Json.of(-1)))))))
            val before = engine.snapshot()
            assertThrows(IllegalArgumentException::class.java) { engine.signIn("A", mapOf("probe" to true)) }
            assertEquals(before, engine.snapshot())
        }
    }

    @Test fun failedAddRollsBackSelectionAndRetainsDeviceOnlySource() {
        anonymousPending().use { engine ->
            val before = engine.snapshot()
            (engine.store as MemoryStore).failNextCommit = true
            assertEquals(CommitFailure.Kind.storeFailure,
                assertThrows(CommitFailure::class.java) { engine.signIn("A", mapOf("probe" to false)) }.kind)
            assertEquals(before, engine.snapshot())
            assertTrue(engine.signIn("A", mapOf("probe" to false)).flag("complete"))
            assertEquals(Json.objectOf("pending" to Json.of(true)), engine.read(scope) { it.device("rack") })
        }
    }
}
