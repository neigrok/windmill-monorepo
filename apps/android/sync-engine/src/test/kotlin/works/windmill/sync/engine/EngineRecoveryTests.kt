package works.windmill.sync.engine

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.api.Change
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.NewID
import works.windmill.sync.core.*

class EngineRecoveryTests {
    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
    private fun engine() = Engine.memory(registry, clock = object : EngineClock { override fun now() = 100L }, actor = "recovering")
    private fun json(value: String) = Json.parse(value)
    private fun entry(id: String, order: Long, state: String, stamp: String, intent: Json, prediction: Json? = null): Entry =
        Entry(Json.objectOf("localId" to Json.of("$id/0"), "gestureId" to Json.of(id), "scope" to intent.member("scope"),
            "lineage" to Json.of("A"), "commitOrder" to Json.of(order), "state" to Json.of(state), "stamp" to Json.of(stamp), "intent" to intent)
            .with("predict" to prediction, "n" to if (state == "sent") Json.of(order + 1) else null))
    private fun intent(deltas: String = "[]", extras: String = "") = json("""{"scope":"self/probe","d":$deltas$extras}""")
    private fun replica(engine: Engine, entries: List<Entry>): ReplicaState = engine.device.current().apply {
        outbox.addAll(entries)
        meta = meta.with("state" to Json.of("bound"), "account" to Json.of("A"), "hlc" to Hlc(9000, 0).json,
            "hlcHigh" to Json.of("9000:0:previous"), "nextN" to Json.of(9))
    }

    @Test fun clockSkewRestampsOwnWritesAndLaterSentBornsCarriedLivesAndGuards() {
        engine().use { engine ->
            val create = entry("create", 0, "sent", "9000:0:previous", intent("""[{"t":"run","id":"run00001","born":"9000:0:previous","life":["alive","9000:0:previous"],"f":{"label":["Run","9000:0:previous"]}}]"""))
            val later = entry("later", 1, "sent", "9001:0:previous", intent("""[{"t":"run","id":"run00001","born":"9000:0:previous","life":["dead","9001:0:previous"]}]""",
                """, "guard":[{"t":"run","id":"run00001","field":"label","stamp":"9000:0:previous"}]"""))
            engine.write { replica(engine, listOf(create, later)).let { r -> engine.onRefused(r, create, json("""{"code":"clock-skew"}"""), json("""{"lastN":2}""")) } }
            val entries = engine.device.current().entries()
            assertEquals(listOf("ready", "sent"), entries.map { it.state })
            assertEquals("100:1:recovering", entries[0].stamp.text)
            assertEquals(Json.of("100:1:recovering"), entries[1].json.member("intent").items("d")[0].member("born"))
            assertEquals(Json.of("100:1:recovering"), entries[1].json.member("intent").items("guard")[0].member("stamp"))
            assertEquals(Json.of("9001:0:previous"), entries[1].json.member("intent").items("d")[0].member("life").arr()[1])
            assertEquals(Json.of(3), engine.device.current().meta.member("nextN"))
        }
    }

    @Test fun recoveryReturnsUnprocessedSentEntriesAndSkipsPredictionsAndAckedEntries() {
        engine().use { engine ->
            val first = entry("first", 0, "sent", "9000:0:old", intent("""[{"t":"run","id":"run00001","born":"1:0:server","f":{"label":["A","9000:0:old"]}}]"""),
                json("""[{"t":"run","id":"run00002","born":"9000:0:old","life":["alive","9000:0:old"]}]"""))
            val later = entry("later", 1, "sent", "9001:0:old", intent("""[{"t":"run","id":"run00001","born":"1:0:server","f":{"label":["B","9001:0:old"]}}]"""))
            val acked = entry("acked", 2, "acked", "9002:0:old", intent("""[{"t":"run","id":"run00001","born":"1:0:server","f":{"label":["C","9002:0:old"]}}]"""))
            val ackedBefore = acked.json
            engine.write { r -> replica(engine, listOf(first, later, acked)); engine.onRefused(r, first, json("""{"code":"clock-skew"}"""), json("""{"lastN":1}""")) }
            assertEquals(listOf("ready", "ready", "acked"), engine.device.current().entries().map { it.state })
            assertEquals(listOf("100:1:recovering", "100:2:recovering", "9002:0:old"), engine.device.current().entries().map { it.stamp.text })
            assertEquals(first.json.items("predict"), engine.device.current().entries()[0].json.items("predict"))
            assertEquals(Json.of("9000:0:old"), engine.device.current().entries()[0].json.items("predict")[0].member("born"))
            assertEquals(ackedBefore, engine.device.current().entries()[2].json)
            assertNull(engine.device.current().entries()[1].json["n"])
        }
    }

    @Test fun recoveryLowersUnsourcedBornAndCarriedLifeButPreservesPredictionSource() {
        engine().use { engine ->
            val refused = entry("bad", 0, "sent", "9000:1:old", intent("""[{"t":"run","id":"run00001","born":"9000:0:old","life":["dead","9000:1:old"]}]"""))
            val carried = entry("carried", 1, "held", "9002:0:old", intent("""[{"t":"day","id":"2026-10-04","life":["alive","9001:0:old"],"f":{"score":[2,"9002:0:old"]}}]"""))
            val command = entry("command", 2, "sent", "9003:0:old", intent(extras = """, "cmd":{"name":"probe.start","args":{"id":"run00002"}}"""),
                json("""[{"t":"run","id":"run00002","born":"9003:0:old","life":["alive","9003:0:old"]}]"""))
            val sourced = entry("sourced", 3, "ready", "9004:0:old", intent("""[{"t":"run","id":"run00002","born":"9003:0:old","f":{"label":["B","9004:0:old"]}}]"""))
            engine.write { r -> replica(engine, listOf(refused, carried, command, sourced)); engine.onRefused(r, refused, json("""{"code":"clock-skew"}"""), json("""{"lastN":3}""")) }
            val entries = engine.device.current().entries()
            assertEquals(Json.of("100:0:recovering"), entries[0].json.member("intent").items("d")[0].member("born"))
            assertEquals(Json.of("100:0:recovering"), entries[1].json.member("intent").items("d")[0].member("life").arr()[1])
            assertEquals(Json.of("9003:0:old"), entries[3].json.member("intent").items("d")[0].member("born"))
        }
    }

    @Test fun recoveryStartsAtAdmittedHighAndCarriesOlderLifeWithoutRestampingIt() {
        engine().use { engine ->
            val refused = entry("bad", 0, "sent", "9000:0:old", intent("""[{"t":"day","id":"2026-10-04","life":["alive","1000:0:server"],"f":{"score":[2,"9000:0:old"]}}]"""))
            engine.write { r -> replica(engine, listOf(refused)); r.meta = r.meta.with("admittedHigh" to Json.of("1000:0:server")); engine.onRefused(r, refused, json("""{"code":"clock-skew"}"""), json("""{"lastN":1}""")) }
            val actual = engine.device.current().entries().single()
            assertEquals("1000:1:recovering", actual.stamp.text)
            assertEquals(Json.of("1000:0:server"), actual.json.member("intent").items("d")[0].member("life").arr()[1])
        }
    }

    @Test fun refusalFoldsQueuedDependentsTransitivelyAndSentOrphansWaitForTheirOwnRefusal() {
        engine().use { engine ->
            val source = entry("source", 0, "sent", "101:0:old", intent("""[{"t":"run","id":"run00001","born":"101:0:old","life":["alive","101:0:old"]}]"""))
            val orphan = entry("orphan", 1, "sent", "102:0:old", intent("""[{"t":"lap","id":"lap00001","born":"102:0:old","life":["alive","102:0:old"],"f":{"runId":["run00001","102:0:old"]}}]"""))
            val child = entry("child", 2, "ready", "103:0:old", intent("""[{"t":"lap","id":"lap00001","born":"102:0:old","f":{"weight":[20,"103:0:old"]}}]"""))
            val dependent = entry("dependent", 3, "ready", "104:0:old", intent("""[{"t":"run","id":"run00001","born":"101:0:old","f":{"label":["Gone","104:0:old"]}},{"t":"card","id":"card0001","born":"1:0:server","f":{"title":["Kept","104:0:old"]}}]"""))
            engine.write { r -> replica(engine, listOf(source, orphan, child, dependent)); engine.refuse(r, source, "refuse", "invalid", json("""{"kind":"source"}""")) }
            assertEquals(listOf("orphan/0", "child/0", "dependent/0"), engine.device.current().entries().map { it.id })
            assertEquals(Json.of("source/0"), engine.device.current().entries()[0].json.member("orphanOf"))
            val firstNotice = engine.device.current().notices.single()
            assertEquals(2, firstNotice.member("content").items("dependents").size)
            assertEquals("card", engine.device.current().entries()[2].intent.deltas.single().key.type)
            engine.dismissNotice("notice:source/0")
            engine.write { r -> engine.onRefused(r, r.entries()[0], json("""{"code":"clock-skew"}"""), json("""{"lastN":2}""")) }
            assertEquals(listOf("dependent/0"), engine.device.current().entries().map { it.id })
            val notice = engine.device.current().notices.single()
            assertNull(notice["dismissed"])
            assertEquals(3, notice.member("content").items("dependents").size)
            assertEquals(firstNotice.member("content").items("dependents")[0], notice.member("content").items("dependents")[0])
            assertEquals(listOf("refuse", "refuse", "fold"), engine.ended().map { it.member("event").str() })
            assertEquals(listOf(Json.of("source/0"), Json.of("source/0")), engine.ended().drop(1).map { it.member("orphanOf") })
            engine.dismissNotice("notice:source/0")
            val scope = ScopeRef.product("probe")
            val sourceKey = RecordKey("run", RecordID("run00001"))
            val childKey = RecordKey("lap", RecordID("lap00001"))
            assertNull(engine.read(scope) { it.drawn(sourceKey.type, sourceKey.id) })
            assertNull(engine.read(scope) { it.drawn(childKey.type, childKey.id) })
            assertTrue(engine.retainsRecord(scope, sourceKey))
            assertTrue(engine.retainsRecord(scope, childKey))
            assertFalse(engine.retainsRecord(scope, RecordKey("run", RecordID("run00002"))))
            Engine.memory(registry, engine.snapshot()).use { restarted ->
                assertTrue(restarted.retainsRecord(scope, sourceKey))
                assertTrue(restarted.retainsRecord(scope, childKey))
                restarted.signOut("keep")
                assertFalse(restarted.retainsRecord(scope, sourceKey))
                assertFalse(restarted.retainsRecord(scope, childKey))
            }
        }
    }

    @Test fun baseUnknownFallsBackEveryTextAndMalformedBaseRollsBackTransaction() {
        engine().use { engine ->
            val text = entry("text", 0, "sent", "101:0:old", json("""{"scope":"self/overlay/b_00000001","d":[{"t":"mark","id":"tag","x":{"memo":{"text":"New","base":{"rev":3}}}}]}"""))
            text.json = text.json.with("baseTexts" to Json.objectOf("[\"mark\",\"tag\",\"memo\"]" to Json.of("From")))
            engine.write { r -> replica(engine, listOf(text)); engine.onRefused(r, text, json("""{"code":"base-unknown"}"""), Json.objectOf()) }
            assertEquals(json("""{"text":"From"}"""), engine.device.current().entries()[0].json.member("intent").items("d")[0].member("x").member("memo").member("base"))
            assertEquals("ready", engine.device.current().entries()[0].state)
            val before = engine.snapshot()
            assertThrows(TransitionError::class.java) { engine.write { r ->
                val malformed = r.entries()[0]; malformed.state = "sent"; malformed.json = malformed.json.with("baseTexts" to Json.objectOf())
                engine.onRefused(r, malformed, json("""{"code":"base-unknown"}"""), Json.objectOf())
            } }
            assertEquals(before, engine.snapshot())
        }
    }

    @Test fun refusalRemovesOnlyDependentPartWhenTwoDeltasNameTheSameRecord() {
        engine().use { engine ->
            val source = entry("source", 0, "sent", "101:0:old", intent("""[{"t":"day","id":"2026-10-04","life":["dead","101:0:old"]}]"""))
            val mixed = entry("mixed", 1, "ready", "102:0:old", intent("""[{"t":"day","id":"2026-10-04","life":["dead","101:0:old"],"f":{"score":[1,"102:0:old"]}},{"t":"day","id":"2026-10-04","f":{"score":[2,"102:0:old"]}}]"""))
            engine.write { r -> replica(engine, listOf(source, mixed)); engine.refuse(r, source, "refuse", "stale") }
            val remaining = engine.device.current().entries().single().intent.deltas.single()
            assertNull(remaining.lattice.life)
            assertEquals(Json.of(2), remaining.lattice.fields.getValue("score").value)
            assertEquals(1, engine.device.current().notices.single().member("content").items("dependents").single().items("d").size)
        }
    }

    @Test fun writeMapRewritesRefsCommandsGuardsAndPredictionThenTicksMappedQueuedRegisters() {
        engine().use { engine ->
            val command = entry("command", 0, "acked", "101:0:old", intent(extras = """, "cmd":{"name":"probe.start","args":{"id":"run00001"}}"""),
                json("""[{"t":"run","id":"run00001","born":"101:0:old","life":["alive","101:0:old"],"f":{"label":["Go","101:0:old"]}}]"""))
            val write = entry("write", 1, "ready", "102:0:other", intent("""[{"t":"run","id":"run00001","born":"101:0:old","f":{"label":["Edit","102:0:other"]}},{"t":"lap","id":"lap00001","born":"102:0:other","life":["alive","102:0:other"],"f":{"runId":["run00001","102:0:other"]}}]""",
                """, "guard":[{"t":"run","id":"run00001","field":"label","stamp":"101:0:old"}],"cmd":{"name":"probe.end","args":{"runId":"run00001","endedAt":100}}"""))
            val removed = entry("delete", 2, "held", "103:0:old", intent("""[{"t":"run","id":"run00001","born":"101:0:old","life":["dead","103:0:old"]}]"""))
            engine.write { r -> replica(engine, listOf(command, write, removed)); r.meta = r.meta.with("hlc" to Hlc(100, 0).json, "hlcHigh" to Json.of("100:0:old")); engine.applyWriteMap(r, command, listOf(json("""{"t":"run","from":"run00001","id":"run00002","born":"200:0:server","f":{"label":"200:1:server"}}"""))) }
            val entries = engine.device.current().entries()
            assertEquals(listOf("command/0", "write/0"), entries.map { it.id })
            val prediction = entries[0].json.items("predict")[0]
            assertEquals(Json.of("run00002"), prediction.member("id")); assertEquals(Json.of("200:0:server"), prediction.member("born"))
            val rewritten = entries[1].json.member("intent")
            assertEquals(Json.of("run00002"), rewritten.items("d")[0].member("id"))
            assertEquals(Json.of("200:2:recovering"), rewritten.items("d")[0].member("f").member("label").arr()[1])
            assertEquals(Json.of("run00002"), rewritten.items("d")[1].member("f").member("runId").arr()[0])
            assertEquals(Json.of("run00002"), rewritten.member("cmd").member("args").member("runId"))
            assertEquals(Json.of("run00002"), rewritten.items("guard")[0].member("id"))
            assertEquals(Json.of("200:1:server"), rewritten.items("guard")[0].member("stamp"))
            assertEquals("102:0:other", entries[1].stamp.text)
            assertEquals("target-merged", engine.device.current().notices.single().member("code").str())
            assertEquals(Json.of("200:1:server"), engine.device.current().meta.member("admittedHigh"))
        }
    }

    @Test fun writeMapRekeysTupleKeysKeyedGuardsAndBaseTextFallback() {
        engine().use { engine ->
            val command = entry("command", 0, "acked", "101:0:old", intent())
            val text = entry("text", 1, "ready", "102:0:old", json("""{"scope":"self/overlay/b_00000001","d":[{"t":"mark","id":"old","x":{"memo":{"text":"New","base":{"rev":3}}}}],"guard":[{"t":"mark","id":"old","field":"done","stamp":null}]}"""))
            text.json = text.json.with("baseTexts" to Json.objectOf("[\"mark\",\"old\",\"memo\"]" to Json.of("From")))
            val link = entry("link", 2, "ready", "103:0:old", json("""{"scope":"tree/b_00000001","d":[{"t":"link","id":["old","other"],"life":["alive","103:0:old"]}]}"""))
            engine.write { r -> replica(engine, listOf(command, text, link)); engine.applyWriteMap(r, command, listOf(json("""{"t":"tag","id":"joined","from":"old"}"""))) }
            val entries = engine.device.current().entries()
            assertEquals(Json.of("joined"), entries[1].json.member("intent").items("d")[0].member("id"))
            assertEquals(Json.of("joined"), entries[1].json.member("intent").items("guard")[0].member("id"))
            assertEquals(Json.of("From"), entries[1].json.member("baseTexts").member("[\"mark\",\"joined\",\"memo\"]"))
            assertEquals(json("""["joined","other"]"""), entries[2].json.member("intent").items("d")[0].member("id"))
            engine.write { r -> val next = r.entries()[1]; next.state = "sent"; engine.onRefused(r, next, json("""{"code":"base-unknown"}"""), Json.objectOf()) }
            assertEquals(json("""{"text":"From"}"""), engine.device.current().entries()[1].json.member("intent").items("d")[0].member("x").member("memo").member("base"))
        }
    }

    @Test fun replayedCommandRetainsItsJoinedIdentityAndMovesLaterDeletesAfterRestart() {
        for (legacy in listOf(false, true)) {
            val snapshot = engine().use { engine ->
                val command = entry("command", 0, "acked", "101:0:old", intent(extras = """, "cmd":{"name":"probe.start","args":{"id":"run00001","startedAt":100,"join":true}}"""),
                    json("""[{"t":"run","id":"run00001","born":"101:0:old","life":["alive","101:0:old"]}]"""))
                engine.write { r ->
                    replica(engine, listOf(command))
                    engine.applyWriteMap(r, command, listOf(json("""{"t":"run","from":"run00001","id":"run00002","born":"200:0:srv"}""")))
                    assertEquals(json("""[{"t":"run","from":"run00001","id":"run00002","born":"200:0:srv"}]"""), command.json["writeTargets"])
                    engine.applyWriteMap(r, command, emptyList())
                    if (legacy) command.json = command.json.with("writeTargets" to null)
                    r.outbox.add(entry("delete", 1, "ready", "300:0:old", intent("""[{"t":"run","id":"run00002","born":"200:0:srv","life":["dead","300:0:old"]}]""")))
                    val later = entry("later", 2, "ready", "301:0:old", intent(extras = """, "cmd":{"name":"probe.end","args":{"runId":"run00002","endedAt":300}}"""))
                    later.json = later.json.with("writeTargets" to json("""[{"t":"run","from":"run00002","id":"run00002","born":"200:0:srv"}]"""))
                    r.outbox.add(later)
                    engine.epochChange(r, "ep-2")
                }
                engine.snapshot()
            }
            Engine.memory(registry, snapshot).use { reopened ->
                val request = reopened.nextPush()!!
                val response = SyncResponse(200, json("""{"serverTime":400,"epoch":"ep-2","as":"A","lastN":1,"results":[{"n":1,"s":"ok","seq":1,"write":[{"t":"run","id":"run00001","born":"400:0:srv"}]}]}"""))
                val timing = RequestTiming(ClockReading(400, 400, "boot"), ClockReading(400, 400, "boot"))
                reopened.crashAfterTransactions(2)
                assertThrows(EngineCrash::class.java) { reopened.onPushResponse(request, response, timing) }
                Engine.memory(registry, reopened.snapshot()).use { recovered ->
                    val entries = recovered.device.current().entries()
                    assertEquals(json("""[{"t":"run","from":"run00001","id":"run00001","born":"400:0:srv"}]"""), entries[0].json["writeTargets"])
                    assertEquals(RecordKey("run", RecordID("run00001")), entries[1].intent.deltas.single().key)
                    assertEquals(Stamp("400:0:srv"), entries[1].intent.deltas.single().lattice.born)
                    assertTrue(entries[1].intent.deltas.single().lattice.life!!.stamp > Stamp("400:0:srv"))
                    assertEquals(Json.of("run00001"), entries[2].intent.command!!.args["runId"])
                    assertEquals(json("""[{"t":"run","from":"run00001","id":"run00001","born":"200:0:srv"}]"""), entries[2].json["writeTargets"])
                    assertTrue(recovered.device.current().notices.isEmpty())
                    val before = entries.map { it.json }
                    recovered.onPushResponse(request, response, timing)
                    assertEquals(before, recovered.device.current().entries().map { it.json })
                }
            }
        }
    }

    @Test fun legacyCommandWithNoRecoverableTargetRetainsTheUnmappedDeleteInANotice() {
        engine().use { engine ->
            val command = entry("command", 0, "acked", "101:0:old", intent(extras = """, "cmd":{"name":"probe.start","args":{"id":"run00001","startedAt":100,"join":true}}"""))
            val deletion = entry("delete", 1, "ready", "300:0:old", intent("""[{"t":"run","id":"run00002","born":"200:0:srv","life":["dead","300:0:old"]}]"""))
            engine.write { r ->
                replica(engine, listOf(command, deletion)); engine.epochChange(r, "ep-2")
                assertEquals(Json.array(), command.json["writeTargets"])
                command.state = "acked"
                engine.applyWriteMap(r, command, listOf(json("""{"t":"run","id":"run00001","born":"400:0:srv"}""")))
            }
            val replica = engine.device.current()
            assertEquals(listOf("command/0"), replica.entries().map { it.id })
            assertEquals("target-merged", replica.notices.single().member("code").str())
            assertEquals(deletion.intent.json.member("d"), replica.notices.single().member("content").member("d"))
        }
    }

    @Test fun replayBindsLaterCommandAliasesEvenWhenTheResolvedIdStaysTheSame() {
        for (target in listOf("run00001", "run00002")) engine().use { engine ->
            val prediction = json("""[{"t":"run","id":"run00002","born":"200:0:srv","life":["alive","200:0:srv"]}]""")
            val first = entry("first", 0, "acked", "100:0:old", intent(extras = """, "cmd":{"name":"probe.start","args":{"id":"run00001","startedAt":100,"join":true}}"""), prediction)
            first.json = first.json.with("writeTargets" to json("""[{"t":"run","from":"run00001","id":"run00002","born":"200:0:srv"}]"""))
            val later = entry("later", 1, "ready", "101:0:old", intent(extras = """, "cmd":{"name":"probe.start","args":{"id":"run00003","startedAt":101,"join":true}}"""), prediction)
            later.json = later.json.with("writeTargets" to json("""[{"t":"run","from":"run00003","id":"run00002","born":"200:0:srv"}]"""))
            val deletion = entry("delete", 2, "ready", "300:0:old", intent("""[{"t":"run","id":"run00002","born":"200:0:srv","life":["dead","300:0:old"]}]"""))
            engine.write { replica(engine, listOf(first, later, deletion)) }
            val map = Json.objectOf("t" to Json.of("run"), "id" to Json.of(target), "born" to Json.of("400:0:srv"))
                .with("from" to if (target == "run00002") Json.of("run00001") else null)
            val before = engine.snapshot()
            engine.failNextCommit()
            assertThrows(CommitFailure::class.java) { engine.write { r -> engine.applyWriteMap(r, r.entries().first(), listOf(map)) } }
            assertEquals(before, engine.snapshot())
            engine.crashAfterTransactions(1)
            assertThrows(EngineCrash::class.java) { engine.write { r -> engine.applyWriteMap(r, r.entries().first(), listOf(map)) } }
            Engine.memory(registry, engine.snapshot()).use { reopened ->
                val rebound = reopened.device.current().entries()[1]
                assertEquals(Json.of(target), rebound.intent.command!!.args["id"])
                assertEquals(Json.of(target), rebound.json.items("writeTargets").single()["from"])
                assertEquals(Json.of(target), rebound.json.items("writeTargets").single()["id"])
                val command = reopened.nextPush()!!.items("intents").single().member("cmd")
                assertEquals(Json.of(target), command.member("args")["id"])
                assertTrue(reopened.device.current().notices.isEmpty())
            }
        }
    }

    @Test fun storageFailureRollsBackNoticeFoldRestampAndEndingsTogether() {
        engine().use { engine ->
            engine.write { replica(engine, listOf(entry("source", 0, "sent", "101:0:old", intent("""[{"t":"run","id":"run00001","born":"101:0:old","life":["alive","101:0:old"]}]""")),
                entry("later", 1, "held", "102:0:old", intent("""[{"t":"run","id":"run00001","born":"101:0:old","f":{"label":["Edit","102:0:old"]}}]""")))) }
            val before = engine.snapshot()
            engine.failNextCommit()
            assertEquals(CommitFailure.Kind.storeFailure, assertThrows(CommitFailure::class.java) { engine.write { r -> engine.refuse(r, r.entries()[0], "refuse", "invalid") } }.kind)
            assertEquals(before, engine.snapshot()); assertTrue(engine.ended().isEmpty())
            engine.failNextCommit()
            assertThrows(CommitFailure::class.java) { engine.write { r -> engine.onRefused(r, r.entries()[0], json("""{"code":"clock-skew"}"""), json("""{"lastN":1}""")) } }
            assertEquals(before, engine.snapshot()); assertTrue(engine.ended().isEmpty())
        }
    }

    @Test fun changedEpochPushRequeuesOwedWorkAtomicallyBeforeAnyResultAndSurvivesRestart() {
        for (status in listOf(200, 409)) engine().use { engine ->
            val scope = ScopeRef.product("probe")
            val id = RecordID("card0001")
            val timing = RequestTiming(ClockReading(100, 100, "boot"), ClockReading(100, 100, "boot"))
            engine.signIn("A", mapOf("probe" to false))
            engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(id), mapOf("title" to Json.of("Created"))))))
            val create = engine.nextPush()!!
            engine.onPushResponse(create, SyncResponse(200, json("""{"serverTime":100,"epoch":"ep-1","as":"A","lastN":1,"results":[{"n":1,"s":"ok","seq":1}]}""")), timing)
            engine.commit(scope, Gesture(listOf(Change.delete("card", id))))
            val request = engine.nextPush()!!
            engine.write { replica ->
                replica.cursors[scope.text] = replica.cursorOf(scope).with("cursor" to Json.of(WireCursor("ep-1", "live", 0).text))
            }
            val body = if (status == 409) json("""{"serverTime":100,"epoch":"ep-2","as":"A","error":"gap"}""")
                else json("""{"serverTime":100,"epoch":"ep-2","as":"A","lastN":2,"results":[{"n":2,"s":"refused","code":"unknown-record"}]}""")
            val response = SyncResponse(status, body)
            val before = engine.snapshot()
            val ids = engine.device.current().entries().map { it.id }
            engine.failNextCommit()
            assertEquals(CommitFailure.Kind.storeFailure,
                assertThrows(CommitFailure::class.java) { engine.onPushResponse(request, response, timing) }.kind)
            assertEquals(before, engine.snapshot())
            engine.crashAfterTransactions(1)
            assertThrows(EngineCrash::class.java) { engine.onPushResponse(request, response, timing) }
            Engine.memory(registry, engine.snapshot()).use { reopened ->
                val replica = reopened.device.current()
                assertEquals(Json.of("ep-2"), replica.meta["serverEpoch"])
                assertEquals(Json.of(0), replica.meta["ackThrough"])
                assertEquals(Json.of(1), replica.meta["nextN"])
                assertEquals(Json.Null, replica.cursorOf(scope)["cursor"])
                assertEquals(ids, replica.entries().map { it.id })
                assertEquals(listOf("ready", "ready"), replica.entries().map { it.state })
                assertTrue(replica.notices.isEmpty())
                val recovered = reopened.snapshot()
                reopened.onPushResponse(request, response, timing)
                assertEquals(recovered, reopened.snapshot())
                val replay = reopened.nextPush()!!
                assertNotEquals(request.member("replica"), replay.member("replica"))
                assertEquals(listOf(Json.of(1), Json.of(2)), replay.items("intents").map { it.member("n") })
                assertEquals(listOf("alive", "dead"), replay.items("intents").map { it.items("d").single().member("life").arr()[0].str() })
            }
        }
    }
}
