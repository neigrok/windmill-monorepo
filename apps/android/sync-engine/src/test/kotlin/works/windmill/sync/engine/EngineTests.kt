package works.windmill.sync.engine

import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.Command
import works.windmill.sync.core.RecordID

class EngineTests {
    @Test fun gymDefaultsDoNotSubscribeOrPullAnUnsupportedProductsOwnedTrees() = runBlocking<Unit> {
        val leaves = listOf("gym", "journal").map { name -> Registry(Json.parse("""{
            "registry":"$name","version":3,"minVersion":2,"products":{"$name":{}},
            "types":[{"type":"$name","scope":"product:$name","identity":"singleton","singletonId":"$name",
            "idPattern":"^$name$","life":false,"origins":["replica"],"fields":{}}],"commands":[]
        }""")) }
        val third = Registry(Json.parse("""{
            "registry":"third","version":3,"minVersion":2,"products":{"third":{}},"commands":[],
            "types":[{"type":"board","scope":"product:third","identity":"minted","idSpace":"global",
            "idPattern":"^b[0-9]+$","mint":{"prefix":"b","alphabet":"0123456789","length":4},
            "life":true,"revivable":false,"deadRows":"spent","governs":"tree","origins":["replica"],"fields":{}},
            {"type":"meta","scope":"tree","identity":"singleton","singletonId":"meta","idPattern":"^meta$",
            "life":false,"origins":["replica"],"fields":{}}]
        }"""))
        val composed = Registry.compose("three", leaves + third)
        Engine.memory(composed, identities = identities, actor = "actor").use { engine ->
            engine.signIn("A", emptyMap())
            val stamp = Stamp("1:0:a")
            engine.store.transaction { engine.store.put(engine.device.current().id, ScopeRef.product("third"),
                Row(RecordKey("board", RecordID("b0001")), Lattice(Life("alive", stamp), stamp), seq = 1)) }
            assertEquals(setOf(ScopeRef.product("gym")), engine.subscriptions())
            assertEquals(Json.parse("""{"scopes":[{"scope":"self/gym","cursor":null}]}"""), engine.pullRequest(engine.subscriptions()))
            val pulled = CompletableDeferred<Json>()
            val subscribed = CompletableDeferred<Json>()
            val connection = object : LiveConnection {
                override suspend fun send(request: Json) { subscribed.complete(request) }
                override suspend fun receive(): Json? = awaitCancellation()
                override fun close() {}
            }
            val transport = object : SyncTransport {
                override suspend fun hello(token: String?) = Reply.Answer(SyncResponse(200, Json.parse("""{
                    "serverTime":5000,"epoch":"ep-1","as":"A","schema":3,"minSchema":2,"holdsRecords":{}}
                """)))
                override suspend fun push(request: Json, token: String): Reply<SyncResponse> = Reply.Unreachable
                override suspend fun pull(request: Json, token: String?): Reply<SyncResponse> {
                    pulled.complete(request)
                    awaitCancellation()
                }
                override suspend fun openLive(token: String): Reply<LiveConnection> = Reply.Answer(connection)
            }
            val tokens = object : SessionTokens {
                override fun token(account: String) = "token"
                override fun accounts() = setOf("A")
                override fun save(account: String, token: String) {}
                override fun delete(account: String) {}
            }
            val sleeper = object : EngineSleeper { override suspend fun sleep(ms: Long) = awaitCancellation() }
            SyncRuntime(engine, transport, tokens, "1", sleeper).use { runtime ->
                runtime.enter()
                assertEquals(Json.parse("""{"op":"sub","scopes":["self/gym"]}"""), withTimeout(2_000) { subscribed.await() })
                assertEquals(Json.parse("""{"scopes":[{"scope":"self/gym","cursor":null}]}"""), withTimeout(2_000) { pulled.await() })
            }
            val tree = ScopeRef.tree("b0001")
            val overlay = ScopeRef.overlay("b0001")
            assertEquals(setOf(ScopeRef.product("third"), tree, overlay), engine.subscriptions(listOf("third")))
            assertNull(engine.subscribe(tree))
            assertEquals(setOf(ScopeRef.product("gym"), tree, overlay), engine.subscriptions())
            assertEquals(Json.parse("""{"scopes":[{"scope":"self/gym","cursor":null},{"scope":"self/overlay/b0001","cursor":null},{"scope":"tree/b0001","cursor":null}]}"""),
                engine.pullRequest(engine.subscriptions().sortedBy { it.text }))
        }
    }

    // E-6 over the shipped composition: the account's roadmaps are rows the app holds, never scopes it follows.
    @Test fun theShippedCompositionSubscribesAndPullsGymOnlyWhileTheAccountHoldsRoadmaps() {
        Engine.memory(works.windmill.sync.schema.SyncSchema.registry, identities = identities, actor = "actor").use { engine ->
            engine.signIn("A", emptyMap())
            val stamp = Stamp("1:0:a")
            val roadmap = "t_0123456789abcdef"
            engine.store.transaction { engine.store.put(engine.device.current().id, ScopeRef.product("roadmap"),
                Row(RecordKey("tree", RecordID(roadmap)), Lattice(Life("alive", stamp), stamp), seq = 1)) }
            assertEquals(setOf(ScopeRef.product("gym")), engine.subscriptions())
            assertEquals(Json.parse("""{"scopes":[{"scope":"self/gym","cursor":null}]}"""), engine.pullRequest(engine.subscriptions()))
            assertEquals(setOf(ScopeRef.product("roadmap"), ScopeRef.tree(roadmap), ScopeRef.overlay(roadmap)), engine.subscriptions(listOf("roadmap")))
        }
    }

    @Test fun readerTreesPairTheBoundAccountsOverlayAndReopenBothScopes() {
        val tree = ScopeRef.tree("b_00000001")
        val overlay = ScopeRef.overlay("b_00000001")
        engine().use { engine ->
            engine.subscribe(tree)
            assertEquals(setOf(tree), engine.subscriptions(listOf("probe")))
            assertTrue(engine.read(overlay) { it.firstPullComplete() })
            engine.signIn("B", emptyMap())
            assertEquals(setOf(scope, tree, overlay), engine.subscriptions(listOf("probe")))
            engine.reconcile(engine.subscriptions(listOf("probe")))
            assertFalse(engine.read(overlay) { it.firstPullComplete() })
            engine.write { replica ->
                replica.known[tree.text] = Json.of("not-found")
                replica.known[overlay.text] = Json.of("not-found")
            }
            assertEquals(setOf(scope), engine.subscriptions(listOf("probe")))
            assertTrue(engine.read(overlay) { it.firstPullComplete() })
            assertNull(engine.subscribe(tree))
            assertTrue(engine.device.current().known.isEmpty())
            assertEquals(setOf(scope, tree, overlay), engine.subscriptions(listOf("probe")))
            engine.write { replica ->
                replica.known[tree.text] = Json.of("gone")
                replica.known[overlay.text] = Json.of("not-found")
            }
            assertEquals("gone", engine.subscribe(tree))
            assertEquals(mapOf(tree.text to Json.of("gone"), overlay.text to Json.of("not-found")), engine.device.current().known)
        }
    }

    @Test fun closingATreeRetainsSeparatelyOpenedAndOwnedOverlays() {
        val tree = ScopeRef.tree("b_00000001")
        val overlay = ScopeRef.overlay("b_00000001")
        engine().use { engine ->
            engine.signIn("B", emptyMap())
            engine.subscribe(tree); engine.subscribe(overlay)
            engine.reconcile(engine.subscriptions(listOf("probe")))
            engine.write { replica -> replica.cursors[overlay.text] = Json.objectOf("booted" to Json.of(true), "cursor" to Json.Null) }
            engine.unsubscribe(tree)
            assertEquals(setOf(scope, overlay), engine.subscriptions(listOf("probe")))
            assertNotNull(engine.device.current().cursors[overlay.text])
            engine.unsubscribe(overlay)
            assertEquals(setOf(scope), engine.subscriptions(listOf("probe")))
            assertNull(engine.device.current().cursors[overlay.text])
            engine.commit(scope, Gesture(listOf(Change.create("board", NewID.Given(RecordID("b_00000001"))))))
            engine.subscribe(tree); engine.unsubscribe(tree)
            engine.reconcile(engine.subscriptions(listOf("probe")))
            assertEquals(setOf(scope, tree, overlay), engine.subscriptions(listOf("probe")))
            assertFalse(engine.read(overlay) { it.firstPullComplete() })
            engine.signOut("keep")
            assertEquals(emptySet<ScopeRef>(), engine.subscriptions(listOf("probe")))
        }
    }

    @Test fun actReadersKeepOneInitialSnapshotAndSegmentsSeeEarlierWrites() {
        engine().use { engine ->
            var loads = 0
            var loan: ScopeReader? = null
            val result = engine.commitAct({ context ->
                loads++
                context.inScope(scope) { reader -> loan = reader; assertTrue(reader.drawn("card").isEmpty()) }
                ActRequest(listOf(scope, scope), hold = true) to context.now
            }, { now, index, reader ->
                assertEquals(now, reader.now)
                if (index == 0) create("card0001") else {
                    assertNotNull(reader.drawn("card", RecordID("card0001")))
                    Gesture(listOf(Change.update("card", RecordID("card0001"), mapOf("title" to Json.of("Next")))))
                }
            })
            val receipt = (result.first as ActCommitOutcome.Committed).receipt
            assertThrows(CommitFailure::class.java) { loan!!.drawn("card") }
            assertEquals(1, loads)
            assertEquals(listOf("${receipt.gestureId}/0", "${receipt.gestureId}/1"), receipt.localIds)
            assertEquals(listOf(scope, scope), receipt.segments.map { it.scope })
            assertTrue(receipt.segments[0].stamp!! < receipt.segments[1].stamp!!)
            assertTrue(engine.cancelHeld(receipt.gestureId))
            assertTrue(engine.read(scope) { it.drawn("card").isEmpty() })
        }
    }

    @Test fun newGovernedScopeMintsBeforeItsEarlierGoverningCreate() {
        engine().use { engine ->
            val tree = ScopeRef.tree("b_00000001")
            val result = engine.commitAct({ context -> ActRequest(listOf(scope, tree)) to context.mintID("tag", tree) },
                { id, index, _ -> if (index == 0) Gesture(listOf(Change.create("board", NewID.Given(RecordID("b_00000001")))))
                    else Gesture(listOf(Change.create("tag", NewID.Given(id), mapOf("label" to Json.of("New"))))) })
            assertTrue(result.first is ActCommitOutcome.Committed)
            assertEquals(Json.of("New"), engine.read(tree) { it.drawn("tag", result.second) }!!.values["label"])
        }
    }

    @Test fun laterActStorageReadFailureKeepsItsBoundaryKindAndRollsBack() {
        val initial = Json.objectOf("active" to Json.of("replica"), "replicas" to Json.array(freshReplica("replica").json()))
        val delegate = MemoryStore(registry, initial)
        val tree = ScopeRef.tree("b_00000001")
        val store = object : EngineStore by delegate {
            override fun rows(replica: String, scope: ScopeRef, type: String?): List<Row> {
                if (scope == tree) throw StoreFailure()
                return delegate.rows(replica, scope, type)
            }
        }
        Engine(registry, store, object : EngineClock { override fun now() = 5000L }, identities, "actor").use { engine ->
            val before = engine.snapshot()
            val failure = assertThrows(CommitFailure::class.java) { engine.commitAct({ ActRequest(listOf(scope, tree)) to Unit },
                { _, index, reader -> if (index == 0) create("card0001") else { reader.drawn("meta"); Gesture(emptyList()) } }) }
            assertEquals(CommitFailure.Kind.storeFailure, failure.kind)
            assertEquals(before, engine.snapshot())
        }
    }

    @Test fun partialActReleaseRemovesItsUndoOffer() {
        engine().use { engine ->
            val result = engine.commitAct(listOf(
                ScopedGesture(scope, Gesture(listOf(Change.create("board", NewID.Given(RecordID("b_00000001")))), hold = true)),
                ScopedGesture(ScopeRef.tree("b_00000001"), Gesture(listOf(Change.write("meta", RecordID("meta"), mapOf("title" to Json.of("First"))))))
            )) as ActCommitOutcome.Committed
            assertTrue(engine.release(result.receipt.localIds[0]))
            assertTrue(engine.undoOffers().isEmpty())
            assertFalse(engine.cancelHeld(result.receipt.gestureId))
        }
    }

    @Test fun caughtActLoadFailureAndLateReadsCannotEnterDecideOrMint() {
        var draws = 0
        var decisions = 0
        Engine.memory(registry, identities = object : IdentitySource {
            override fun opaqueID() = "phase-act"
            override fun draw(bound: Int): Int { draws++; return 0 }
        }, actor = "actor").use { engine ->
            draws = 0
            val before = engine.snapshot()
            assertThrows(CommitFailure::class.java) { engine.commitAct({ context ->
                context.inScope(scope) { }
                try { context.inScope(ScopeRef.product("missing")) { } } catch (_: CommitFailure) { }
                context.mintID("card", scope)
                decisions++
                null to Unit
            }, { _, _, _ -> Gesture(emptyList()) }) }
            assertEquals(0, decisions)
            assertEquals(0, draws)
            assertThrows(CommitFailure::class.java) { engine.commitAct({ context ->
                context.finishLoad(); context.finishLoad()
                try { context.inScope(scope) { } } catch (_: CommitFailure) { }
                ActRequest(listOf(scope)) to Unit
            }, { _, _, _ -> create("card0001") }) }
            assertEquals(before, engine.snapshot())
        }
    }

    @Test fun actMintingRequiresBorrowBeforeRandomnessAndSharesReservations() {
        var draws = 0
        var identities = 0
        Engine.memory(registry, identities = object : IdentitySource {
            override fun opaqueID() = "act-${++identities}"
            override fun draw(bound: Int) = (draws++ / 32) % bound
        }, actor = "actor").use { engine ->
            draws = 0
            val before = engine.snapshot()
            assertThrows(CommitFailure::class.java) { engine.commitAct({ context ->
                context.mintID("card", scope); null to Unit
            }, { _, _, _ -> Gesture(emptyList()) }) }
            assertEquals(0, draws)
            assertEquals(before, engine.snapshot())
            val result = engine.commitAct({ context ->
                context.inScope(scope) { }
                null to listOf(context.mintID("card", scope), context.mintID("card", scope))
            }, { _, _, _ -> Gesture(emptyList()) })
            assertNotEquals(result.second[0], result.second[1])
            assertEquals(48, draws)
        }
    }

    @Test fun aLaterLoadReadsThroughAStagedSegmentAndTheRequestCommitsEverySegmentAsOneAct() {
        val card = RecordID("card0001")
        fun title(reader: ScopeReader) = reader.drawn("card", card)?.values?.get("title")
        fun titled(title: String, change: (Map<String, Json>) -> Change) = Gesture(listOf(change(mapOf("title" to Json.of(title)))))
        val create = titled("First") { Change.create("card", NewID.Given(card), it) }
        val rename = titled("First!") { Change.update("card", card, it) }
        engine().use { engine ->
            val reads = mutableListOf<Json?>()
            val outcome = engine.commitAct({ context ->
                reads.add(context.inScope(scope, ::title))
                assertNull(context.stage(scope) { create })
                context.beginPart()
                reads.add(context.inScope(scope, ::title))
                assertNull(context.stage(scope) { reader -> titled("${title(reader)!!.str()}!") { Change.update("card", card, it) } })
                ActRequest(listOf(scope, scope)) to listOf(create, rename)
            }, { gestures, index, _ -> gestures[index] }).first as ActCommitOutcome.Committed
            assertEquals(listOf(null, Json.of("First")), reads)
            val gestureId = outcome.receipt.gestureId
            assertEquals(listOf(listOf("$gestureId/0"), listOf("$gestureId/1")), outcome.receipt.segments.map { it.localIds })
            assertEquals(Json.of("First!"), engine.read(scope, ::title))
        }
    }

    @Test fun aStagedLocalRefusalIsAnsweredReportedAndTheActItEndsWritesNothing() = runBlocking<Unit> {
        val gone = ScopeRef.tree("b_00000005")
        val replica = freshReplica("replica").json().with("known" to Json.objectOf(gone.text to Json.of("gone")))
        val store = MemoryStore(registry, Json.objectOf("active" to Json.of("replica"), "replicas" to Json.array(replica)))
        val events = kotlinx.coroutines.channels.Channel<EngineEvent>(16)
        Engine(registry, store, object : EngineClock { override fun now() = 5_000L }, identities, "actor", telemetry = EngineTelemetry { events.send(it) }).use { engine ->
            val before = engine.snapshot()
            val outcome = engine.commitAct({ context ->
                assertNull(context.stage(scope) { create("card0001") })
                assertEquals(CommitOutcome.Refused(RefusalCode.scopeDead, null),
                    context.stage(gone) { Gesture(listOf(Change.create("tag", NewID.Given(RecordID("elm")), mapOf("label" to Json.of("Elm"))))) })
                null to Unit
            }, { _, _, _ -> throw AssertionError("a refused act reaches no segment") })
            assertNull(outcome.first)
            assertEquals(before, engine.snapshot())
            val reported = withTimeout(2_000) {
                var event = events.receive()
                while (event.operation != EngineOperation.commit) event = events.receive()
                event
            }
            assertEquals(EngineEvent(EngineOperation.commit, EngineOutcome.refused, "scope-dead"), reported)
        }
    }

    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
    private val identities = object : IdentitySource {
        var number = 0
        var replicas = 0
        override fun opaqueID() = "id${++number}"
        override fun draw(bound: Int) = 0
        override fun replicaID() = "rp_${(++replicas).toString(16).padStart(32, '0')}"
    }
    private val scope = ScopeRef.product("probe")
    private fun engine(telemetry: EngineTelemetry = NoEngineTelemetry) = Engine.memory(registry, clock = object : EngineClock { override fun now() = 5_000L }, identities = identities, actor = "actor", telemetry = telemetry)
    private fun create(id: String) = Gesture(listOf(Change.create("card", NewID.Given(RecordID(id)), mapOf("title" to Json.of(id)))))
    @Test fun derivedCommitsFitTheirIdDomainOrLeaveTheStoreUnchanged() {
        for (max in listOf(8, 1)) {
            val custom = Registry(Json.parse("""{
                "registry":"bounded","version":1,"minVersion":1,"products":{"p":{}},"commands":[],
                "types":[{"type":"node","scope":"product:p","identity":"derived","idSpace":"scope",
                "idDomain":{"type":"string","unit":"chars","min":1,"max":$max},
                "derive":{"fallback":"${"a".repeat(max)}"},"mint":{"prefix":"","alphabet":"ab","length":1},
                "life":true,"revivable":true,"deadRows":"keep","origins":["replica"],"fields":{}}]
            }"""))
            Engine.memory(custom, identities = identities, actor = "actor").use { engine ->
                val before = engine.snapshot()
                val gesture = Gesture(listOf("abcdefgh".repeat(25), "", "").map { Change.create("node", NewID.Derived(it)) })
                if (max == 1) {
                    assertThrows(CommitFailure::class.java) { engine.commit(ScopeRef.product("p"), gesture) }
                    assertEquals(before, engine.snapshot())
                } else {
                    val outcome = engine.commit(ScopeRef.product("p"), gesture) as CommitOutcome.Committed
                    assertEquals(listOf("abcdefgh", "aaaaaaaa", "aaaaaa-2"), outcome.receipt.ids.map { it?.string })
                }
            }
        }
    }
    @Test fun advertisedServerSchemaIsDurableAccountLocalAndPublished() = runBlocking {
        engine().use { engine ->
            assertNull(engine.read(scope) { it.serverSchema() })
            engine.signIn("A", emptyMap(), serverSchema = 6)
            val status = engine.status.state
            assertEquals(6L, engine.read(scope) { it.serverSchema() })
            withTimeout(2_000) { status.first { it.serverSchema == 6L } }
            Engine.memory(registry, engine.snapshot(), clock = engine.clock).use { restarted ->
                assertEquals(6L, restarted.read(scope) { it.serverSchema() })
            }
            engine.signOut("keep")
            assertNull(engine.read(scope) { it.serverSchema() })
            engine.signIn("B", emptyMap(), serverSchema = 5)
            assertEquals(5L, engine.read(scope) { it.serverSchema() })
            engine.signOut("keep"); engine.signIn("A", emptyMap(), serverSchema = 4)
            assertEquals(4L, engine.read(scope) { it.serverSchema() })
            withTimeout(2_000) { status.first { it.serverSchema == 4L } }
            Unit
        }
    }
    @Test fun bodyAndStoreFailuresLeaveNoClockIntentDeviceOrObservationChanges() {
        engine().use { engine ->
            val before = engine.snapshot()
            val thrown = IllegalStateException("caller")
            assertSame(thrown, assertThrows(IllegalStateException::class.java) { engine.commit(scope) { throw thrown; @Suppress("UNREACHABLE_CODE") (null to 1) } })
            assertEquals(before, engine.snapshot())
            engine.failNextCommit()
            val failed = assertThrows(CommitFailure::class.java) { engine.commit(scope, create("card0001")) }
            assertEquals(CommitFailure.Kind.storeFailure, failed.kind)
            assertEquals(before, engine.snapshot())
            assertTrue(engine.commit(scope, create("card0001")) is CommitOutcome.Committed)
        }
    }
    @Test fun memoryJournalRollsBackRowsAndTheirReferenceIndex() {
        engine().use { engine ->
            val store = engine.store as MemoryStore
            val replica = engine.device.current().id
            val row = Row(RecordKey("lap", RecordID("lap00001")), Lattice(fields = mapOf("runId" to Register(Json.of("run00001"), Stamp("1:0:a")))), seq = 1)
            store.failNextCommit = true
            assertThrows(StoreFailure::class.java) { store.transaction { store.put(replica, scope, row) } }
            assertNull(store.row(replica, scope, row.key))
            assertTrue(store.matching(replica, scope, "lap", "runId", RecordID("run00001")).isEmpty())
            store.transaction { store.put(replica, scope, row) }
            assertEquals(listOf(row), store.matching(replica, scope, "lap", "runId", RecordID("run00001")))
        }
    }
    @Test fun aNullBodyReadsOneClockAndWritesNothing() {
        var reads = 0
        Engine.memory(registry, clock = object : EngineClock { override fun now() = (10L + reads++) }, identities = identities, actor = "actor").use { engine ->
            val before = engine.snapshot()
            val result = engine.commit(scope) { context ->
                assertEquals(10L, context.now); null to context.replica
            }
            assertNull(result.first); assertEquals(engine.device.current().id, result.second)
            assertEquals(1, reads); assertEquals(before, engine.snapshot())
        }
    }
    @Test fun readerCannotEscapeItsTransactionAndCaughtMisuseStillFailsACommit() {
        engine().use { engine ->
            var escaped: ScopeReader? = null
            engine.read(scope) { escaped = it }
            assertEquals(CommitFailure.Kind.malformed, assertThrows(CommitFailure::class.java) { escaped!!.drawn("card") }.kind)
            val before = engine.snapshot()
            assertThrows(CommitFailure::class.java) { engine.commit(scope) { context ->
                runCatching { context.drawn("tag") }
                create("card0001") to Unit
            } }
            assertEquals(before, engine.snapshot())
            engine.failNextCommit()
            assertEquals(CommitFailure.Kind.storeFailure, assertThrows(CommitFailure::class.java) { engine.commit(scope) { null to Unit } }.kind)
            assertEquals(before, engine.snapshot())
        }
    }
    // §2.5, §7.5: a spent id is all the device keeps of a derived record deleted elsewhere. Both readers answer its born, null for an id the
    // scope keeps no spent id of, and a revive of the record takes that born (§7.1 step 4).
    @Test fun bothReadersAnswerTheBornOfASpentIdAndARevivalTakesIt() {
        val tree = ScopeRef.tree("b_00000001")
        val born = Stamp("1000:0:r_aaaaaaaaaaaa")
        val spent = Json.objectOf(tree.text to Json.array(Json.objectOf("t" to Json.of("tag"), "id" to Json.of("oak"), "born" to born.json)))
        val snapshot = Json.objectOf("active" to Json.of("rp_00000000000000000000000000000001"), "replicas" to Json.array(freshReplica("rp_00000000000000000000000000000001").json().with("spentIds" to spent)))
        Engine.memory(registry, snapshot, clock = object : EngineClock { override fun now() = 5_000L }, identities = identities, actor = "actor").use { engine ->
            assertEquals(listOf(born, null), engine.read(tree) { listOf(it.spentBorn("tag", RecordID("oak")), it.spentBorn("tag", RecordID("elm"))) })
            val read = engine.commit(tree) { context ->
                Gesture(listOf(Change.revive("tag", RecordID("oak"), mapOf("label" to Json.of("Next"))))) to context.spentBorn("tag", RecordID("oak"))
            }.second
            assertEquals(born, read)
            assertEquals(born, engine.read(tree) { it.drawn("tag", RecordID("oak"))?.born })
            assertEquals(CommitFailure.Kind.malformed, assertThrows(CommitFailure::class.java) { engine.read(scope) { it.spentBorn("tag", RecordID("oak")) } }.kind)
        }
    }
    @Test fun nestedCommitRollsBackAndReadBodiesCanReadTheSameTransaction() {
        engine().use { engine ->
            val before = engine.snapshot()
            val failure = assertThrows(CommitFailure::class.java) { engine.commit(scope) { engine.commit(scope, create("card0001")); null to Unit } }
            assertEquals(CommitFailure.Kind.malformed, failure.kind)
            assertEquals(before, engine.snapshot())
            engine.commit(scope) { assertNull(engine.read(scope) { it.drawn("card", RecordID("card0001")) }); create("card0001") to Unit }
        }
    }
    @Test fun refusedRetireKeepsTheHoldAndAcceptedRetirePreservesUntouchedFields() {
        engine().use { engine ->
            val stamp = Stamp("1:0:a"); val replica = engine.device.current().id
            engine.store.transaction { repeat(3) { index ->
                engine.store.put(replica, scope, Row(RecordKey("card", RecordID("card000${index + 1}")),
                    Lattice(Life("alive", stamp), stamp, mapOf("title" to Register(Json.of("Original"), stamp), "size" to Register(Json.of(2), stamp))), seq = index.toLong()))
            } }
            val id = RecordID("card0001")
            engine.commit(scope, Gesture(listOf(Change.delete("card", id)), hold = true, gestureId = "del"))
            val before = engine.snapshot()
            val refused = engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("card0004")))), retire = listOf(RecordRef("card", id))))
            assertEquals(RefusalCode.cap, (refused as CommitOutcome.Refused).code); assertEquals(before, engine.snapshot())
            val result = engine.commit(scope, Gesture(listOf(Change.update("card", id, mapOf("title" to Json.of("Changed")))), retire = listOf(RecordRef("card", id)))) as CommitOutcome.Committed
            assertEquals(listOf("del"), result.receipt.retired)
            assertEquals(Json.of(2), engine.read(scope) { it.drawn("card", id)!!.values["size"] })
            assertEquals(Json.of("Changed"), engine.read(scope) { it.drawn("card", id)!!.values["title"] })
            assertFalse(engine.cancelHeld("del"))
            engine.commit(scope, Gesture(listOf(Change.delete("card", id)), hold = true, gestureId = "later"))
            assertTrue(engine.release("later/0")); assertFalse(engine.release("later/0")); assertFalse(engine.cancelHeld("later"))
            assertThrows(CommitFailure::class.java) { engine.dismissNotice("missing") }
        }
    }
    @Test fun referenceReadAndObservationDoNotScanTenThousandUnrelatedRows() = runBlocking {
        engine().use { engine ->
            val replica = engine.device.current().id
            val stamp = Stamp("1:0:a")
            engine.store.transaction { repeat(10_000) { index ->
                engine.store.put(replica, scope, Row(RecordKey("lap", RecordID("lap" + index.toString().padStart(5, '0'))),
                    Lattice(Life("alive", stamp), stamp, mapOf("runId" to Register(Json.of(if (index == 0) "run00001" else "run00002"), stamp))), seq = index.toLong()))
            } }
            val before = engine.rowsRead()
            assertEquals(1, engine.read(scope) { it.drawn("lap", "runId", RecordID("run00001")).size })
            assertEquals(2, engine.rowsRead() - before)
            val initial = CompletableDeferred<Unit>()
            val result = async { withTimeout(5_000) { engine.observe(scope, "lap", "runId", RecordID("run00001")).onEach { initial.complete(Unit) }.take(2).toList() } }
            initial.await()
            val beforeUpdate = engine.rowsRead()
            engine.commit(scope, Gesture(listOf(Change.update("lap", RecordID("lap00000"), mapOf("weight" to Json.of(20))))))
            val rows = result.await()
            assertEquals(2, rows.size); assertEquals(Json.of(20), rows.last().single().values["weight"])
            assertTrue("bounded changed-row reads", engine.rowsRead() - beforeUpdate <= 4)
        }
    }
    @Test fun observationCompletesWhenEngineCloses() = runBlocking {
        val engine = engine()
        val initial = CompletableDeferred<Unit>()
        val observer = async { engine.observe(scope, "card").onEach { initial.complete(Unit) }.toList() }
        initial.await(); engine.close()
        assertEquals(listOf(emptyList<Record>()), withTimeout(5_000) { observer.await() })
        assertEquals(CommitFailure.Kind.notWritable, assertThrows(CommitFailure::class.java) { engine.commit(scope, create("card0001")) }.kind)
    }
    @Test fun concurrentCommitsSerializeWithUniqueIncreasingStamps() {
        engine().use { engine ->
            val pool = Executors.newFixedThreadPool(4)
            try {
                val results = (0 until 32).map { i -> pool.submit<CommitOutcome> { engine.commit(scope, Gesture(listOf(Change.create("lap", NewID.Given(RecordID("lap" + i.toString().padStart(5, '0'))))))) } }.map { it.get(5, TimeUnit.SECONDS) }
                val stamps = results.map { (it as CommitOutcome.Committed).receipt.stamp }.sorted()
                assertEquals(32, stamps.toSet().size); assertEquals((0L until 32).toList(), stamps.map { it.counter })
                assertEquals(32, engine.read(scope) { it.drawn("lap").size })
            } finally { pool.shutdownNow() }
        }
    }
    @Test fun writerTimesOutStalledWorkAndSurvivesFailuresAndCancellation() = runBlocking {
        CoroutineWriter(engine(), timeoutMs = 100).use { writer ->
            assertTrue(runCatching { writer.submit { awaitCancellation() } }.exceptionOrNull() is TimeoutCancellationException)
            assertTrue(runCatching { writer.submit<Unit> { throw IllegalStateException("crash") } }.exceptionOrNull() is IllegalStateException)
            assertTrue(runCatching { writer.submit<Unit> { throw CancellationException("caller") } }.exceptionOrNull() is CancellationException)
            assertEquals(42, writer.submit { 42 })
            assertTrue(writer.shutdown())
            assertTrue(runCatching { writer.submit { 7 } }.isFailure)
        }
    }
    @Test fun writerShutdownAndQueueSaturationHaveBoundedDeadlines() = runBlocking {
        val writer = CoroutineWriter(engine(), capacity = 1, timeoutMs = 100)
        val entered = CompletableDeferred<Unit>()
        val running = async { runCatching { writer.submit { entered.complete(Unit); awaitCancellation() } } }
        entered.await()
        val queued = async { runCatching { writer.submit { 1 } } }
        val overflow = async { runCatching { writer.submit { 2 } } }
        delay(10); writer.shutdown()
        withTimeout(1_000) { running.await(); queued.await(); overflow.await() }
        writer.close()
    }
    @Test fun cancellingCallerCancelsItsRunningWorkAndLeavesWriterUsable() = runBlocking {
        CoroutineWriter(engine(), timeoutMs = 5_000).use { writer ->
            val entered = CompletableDeferred<Unit>(); val cancelled = CompletableDeferred<Unit>()
            val caller = launch { writer.submit { entered.complete(Unit); try { awaitCancellation() } finally { cancelled.complete(Unit) } } }
            entered.await(); caller.cancelAndJoin()
            withTimeout(1_000) { cancelled.await() }
            assertEquals(42, withTimeout(1_000) { writer.submit { 42 } })
        }
    }
    @Test fun observerRemovesInvisibleRecordsAndStoredRecordsRetainTheHeldFlag() = runBlocking {
        engine().use { engine ->
            val replica = engine.device.current().id; val stamp = Stamp("1:0:a")
            engine.store.transaction { engine.store.put(replica, scope, Row(RecordKey("card", RecordID("card0001")), Lattice(Life("alive", stamp), stamp), seq = 1)) }
            val entered = CompletableDeferred<Unit>()
            val rows = async { withTimeout(5_000) { engine.observe(scope, "card").onEach { entered.complete(Unit) }.take(2).toList() } }
            entered.await(); engine.commit(scope, Gesture(listOf(Change.delete("card", RecordID("card0001"))), hold = true))
            assertTrue(rows.await().last().isEmpty())
            assertTrue(engine.read(scope) { it.stored("card", RecordID("card0001"))!!.isHeld })
            assertEquals(1, engine.read(scope) { it.stored("card").size })
            assertTrue(engine.read(scope) { it.drawn("card").isEmpty() })
        }
    }
    @Test fun refusingAnIntentDeletionFoldsInheritedLifePredictions() = endingDeletion(true, false)
    @Test fun undoingAnIntentDeletionFoldsInheritedLifePredictions() = endingDeletion(false, false)
    @Test fun refusingAPredictedDeletionFoldsInheritedLifePredictions() = endingDeletion(true, true)
    @Test fun undoingAPredictedDeletionFoldsInheritedLifePredictions() = endingDeletion(false, true)
    private fun endingDeletion(refuse: Boolean, predictedDeletion: Boolean) = runBlocking<Unit> {
        val command = Command("probe.predictDay", Json.objectOf())
        val commands = registry.json.items("commands") + Json.objectOf("name" to Json.of(command.name),
            "scope" to Json.of("product:probe"), "origins" to Json.array(Json.of("replica")), "serverInternal" to Json.of(false),
            "args" to Json.objectOf(), "predicts" to Json.array(Json.of("day")))
        val predictingRegistry = Registry(registry.json.with("commands" to Json.Arr(commands)))
        Engine.memory(predictingRegistry, clock = object : EngineClock { override fun now() = 5_000L }, actor = "actor").use { engine ->
            engine.signIn("A", mapOf("probe" to false))
            val id = RecordID("2026-01-01"); val laterId = RecordID("2026-01-02")
            val stamp = Stamp("1000:0:server")
            val row = Row(RecordKey("day", id), Lattice(Life("alive", stamp), fields = mapOf("score" to Register(Json.of(1), stamp))), seq = 1)
            engine.store.transaction { engine.store.put(engine.device.current().id, scope, row) }
            val before = engine.read(scope) { it.confirmed("day", id) }
            val view = engine.records(scope, "day")
            suspend fun visible(ids: List<RecordID>) = withTimeout(5_000) {
                view.state.first { it is RecordsView.State.Loaded && it.snapshot.records.map(Record::id) == ids }
            }
            visible(listOf(id))
            val deletion = Change.delete("day", id)
            val receipt = (engine.commit(scope, Gesture(if (predictedDeletion) emptyList() else listOf(deletion), hold = !refuse,
                command = if (predictedDeletion) command else null, predict = if (predictedDeletion) listOf(deletion) else emptyList(),
                gestureId = "delete")) as CommitOutcome.Committed).receipt
            engine.commit(scope, Gesture(listOf(Change.put("day", laterId, true, mapOf("score" to Json.of(9)))), command = command,
                predict = listOf(Change.put("day", id, null, mapOf("score" to Json.of(2)))), gestureId = "later"))
            engine.commit(scope, Gesture(emptyList(), command = command,
                predict = listOf(Change.put("day", id, null, mapOf("score" to Json.of(3)))), gestureId = "last"))
            val pending = engine.device.current().entries()
            assertEquals(listOf("delete/0", "later/0", "last/0"), pending.map { it.id })
            assertEquals(List(if (predictedDeletion) 3 else 2) { Life("dead", receipt.stamp) },
                pending.flatMap { it.predict }.filter { it.key == row.key }.map { it.lattice.life })
            assertFalse(engine.read(scope) { it.drawn("day", id)!!.isVisible })
            visible(listOf(laterId))
            if (refuse) {
                val request = engine.nextPush(1)!!
                assertEquals(listOf(Json.of(1)), request.items("intents").map { it.member("n") })
                val timing = RequestTiming(ClockReading(5_000, 5_000, "boot"), ClockReading(5_000, 5_000, "boot"))
                engine.onPushResponse(request, SyncResponse(200, Json.objectOf("epoch" to Json.of("ep-1"), "as" to Json.of("A"),
                    "lastN" to Json.of(1), "results" to Json.array(Json.objectOf("n" to Json.of(1), "s" to Json.of("refused"),
                        "code" to Json.of("invalid"))))), timing)
            } else {
                assertNull(engine.nextPush())
                assertTrue(engine.cancelHeld(receipt.gestureId))
            }
            val remaining = engine.device.current().entries().single()
            assertEquals("later/0", remaining.id); assertEquals("ready", remaining.state)
            assertEquals(listOf(RecordKey("day", laterId)), remaining.intent.deltas.map { it.key })
            assertNull(remaining.intent.command); assertEquals(emptyList<Delta>(), remaining.predict)
            assertEquals(before, engine.read(scope) { it.drawn("day", id) })
            assertEquals(before, engine.read(scope) { it.confirmed("day", id) })
            visible(listOf(id, laterId))
            if (refuse) assertEquals(2, engine.device.current().notices.single().member("content").items("dependents").size)
            else assertTrue(engine.device.current().notices.isEmpty())
            assertTrue(engine.undoOffers().isEmpty())
        }
    }
    @Test fun stalledAndThrowingTelemetryCannotBlockOrRollBackTheWriter() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val sink = EngineTelemetry { entered.complete(Unit); awaitCancellation() }
        engine(sink).use { engine ->
            engine.commit(scope, create("card0001")); withTimeout(2_000) { entered.await() }
            repeat(100) { engine.commit(scope, Gesture(emptyList(), local = listOf(DeviceWrite("rack", Json.of(it))))) }
            assertEquals(Json.of(99), engine.read(scope) { it.device("rack") })
        }
        val throwingSeen = CompletableDeferred<Unit>()
        engine(EngineTelemetry { throwingSeen.complete(Unit); throw IllegalStateException("private exception text") }).use { engine ->
            assertTrue(engine.commit(scope, create("card0001")) is CommitOutcome.Committed)
            withTimeout(2_000) { throwingSeen.await() }
            assertTrue(engine.commit(scope, Gesture(emptyList())) is CommitOutcome.Committed)
        }
    }
    @Test fun telemetryIsBoundedDropsOldestAndContainsOnlyAllowlistedLabels() = runBlocking {
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val received = kotlinx.coroutines.channels.Channel<EngineEvent>(100)
        val queue = TelemetryQueue(EngineTelemetry { event ->
            if (event.operation == EngineOperation.storage) { entered.complete(Unit); release.await() }
            received.send(event)
        })
        try {
            queue.offer(EngineOperation.storage, EngineOutcome.failure, "store-failure"); entered.await()
            repeat(1_000) { queue.offer(EngineOperation.commit, EngineOutcome.failure, "private user text and token") }
            queue.offer(EngineOperation.commit, EngineOutcome.refused, "cap"); release.complete(Unit)
            val events = withTimeout(2_000) { List(65) { received.receive() } }
            assertEquals("store-failure", events.first().code); assertEquals("cap", events.last().code)
            assertTrue(events.subList(1, 64).all { it.code == "unknown" })
            assertNull(withTimeoutOrNull(100) { received.receive() })
        } finally { queue.close(); received.cancel() }
    }
}
