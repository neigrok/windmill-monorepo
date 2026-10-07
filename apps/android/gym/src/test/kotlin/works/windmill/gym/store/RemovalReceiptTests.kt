package works.windmill.gym.store

import java.io.File
import android.database.sqlite.SQLiteDatabase
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import works.windmill.domain.kit.*
import works.windmill.gym.domain.*
import works.windmill.gym.domain.sync.ProposeRoutine
import works.windmill.gym.domain.sync.Proposal as EngineProposal
import works.windmill.gym.domain.sync.Routine as EngineRoutine
import works.windmill.sync.core.*
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.*
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.schema.Gym
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.api.CommitFailure

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
@OptIn(ExperimentalCoroutinesApi::class)
class RemovalReceiptTests {
    @get:Rule val tmp = TemporaryFolder()

    private suspend fun seed(room: EngineRoomFixture, server: ModelServer): Proposal {
        room.select("A")
        room.training.createRoutine(RoutineWrite("routine1", "Original", 0,
            listOf(RoutineEntryWrite("bench-press", listOf(SetTarget(5, 80.0))))))
        room.sync(server)
        val runner = ActionRunner(room.engine, room.engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
        assertTrue(runner.run(ProposeRoutine(Id("proposal1", EngineProposal), Id("routine1", EngineRoutine),
            "", emptyList(), "Remove", true)) is Outcome.Committed)
        room.sync(server)
        room.store.refreshEngine()
        return requireNotNull(room.training.proposal("proposal1"))
    }

    @Test fun aRemovalRetryAfterTimeoutReceivesTheOriginalCommandsReceipt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server()
            val pending = seed(room, server)
            val first = async { room.store.applyProposal("proposal1") }
            runCurrent(); advanceTimeBy(15_001); runCurrent()
            assertEquals(ProposalOutcome.Failed(WriteFailure.NoAnswer), first.await())
            val queued = room.outbox()
            assertEquals(1, queued.size)
            val retry = async { room.store.applyProposal("proposal1") }
            runCurrent()
            assertEquals(queued, room.outbox())
            room.sync(server); advanceTimeBy(15_001); runCurrent()
            assertEquals(ProposalOutcome.Decided(pending.copy(state = ProposalState.Applied)), retry.await())
        }
    }

    @Test fun aRemovalRetryAfterAnInterruptedWaitReceivesTheOriginalCommandsReceipt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server()
            val pending = seed(room, server)
            val first = async { room.store.applyProposal("proposal1") }
            runCurrent(); first.cancelAndJoin()
            val queued = room.outbox()
            val retry = async { room.store.applyProposal("proposal1") }
            runCurrent()
            assertEquals(queued, room.outbox())
            room.sync(server); advanceTimeBy(15_001); runCurrent()
            assertEquals(ProposalOutcome.Decided(pending.copy(state = ProposalState.Applied)), retry.await())
        }
    }

    @Test fun pendingAcknowledgedAndResolvedRemovalsSurviveRelaunchUntilTheirReceiptIsShown() = runTest {
        for (phase in listOf("pending", "acknowledged", "resolved")) {
            val server = EngineRoomFixture.server()
            lateinit var pending: Proposal
            val snapshot = EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
                pending = seed(room, server)
                val first = async { room.store.applyProposal("proposal1") }
                runCurrent(); first.cancelAndJoin()
                if (phase == "resolved") room.sync(server)
                if (phase == "acknowledged") {
                    val request = requireNotNull(room.engine.nextPush())
                    val response = server.push(request, Credential.Account("A"), room.now)
                    val clock = ClockReading(room.now, room.now, "test")
                    room.engine.onPushResponse(request, SyncResponse(response.status, response.body), RequestTiming(clock, clock))
                }
                room.engine.snapshot()
            }
            val settled = pending.copy(state = ProposalState.Applied)
            val reopened = EngineRoomFixture(tmp.newFolder(), backgroundScope, snapshot).use { room ->
                room.selected = "A"
                room.store.connect(room.account())
                if (phase != "resolved") {
                    assertEquals(ProposalRead.Found(pending), room.store.proposal("proposal1"))
                    room.sync(server)
                }
                room.store.refreshEngine()
                assertEquals("$phase relaunch", ProposalRead.Found(settled), room.store.proposal("proposal1"))
                assertEquals(mapOf("proposal1" to settled), room.store.settledProposals)
                room.engine.snapshot()
            }
            EngineRoomFixture(tmp.newFolder(), backgroundScope, reopened).use { room ->
                room.selected = "A"
                room.store.connect(room.account())
                room.store.refreshEngine()
                assertEquals("Reading is not showing", ProposalRead.Found(settled), room.store.proposal("proposal1"))
            }
        }
    }

    @Test fun aPendingRemovalAndItsUnshownReceiptSurviveClosingTheSqliteDatabase() = runTest {
        val directory = tmp.newFolder()
        val database = File(directory, "engine.sqlite")
        val initial = Engine.memory(SyncSchema.registry).use { it.snapshot() }
        val identities = object : IdentitySource {
            override fun opaqueID() = java.util.UUID.randomUUID().toString()
            override fun draw(bound: Int) = java.security.SecureRandom().nextInt(bound)
        }
        val open: (Json?, EngineClock) -> Engine = { _, clock ->
            AndroidSqlite.open(database, SyncSchema.registry, initial, clock, identities, identities.actorID(),
                intentResultWrites = EngineTraining.intentResultWrites,
                rewriteDeviceValue = WorkoutImports.rewriteDeviceValue, pendingDeviceWork = WorkoutImports.pendingDeviceWork)
        }
        val server = EngineRoomFixture.server()
        val pending = EngineRoomFixture(directory, backgroundScope, createEngine = open).use { room ->
            val proposal = seed(room, server)
            val wait = async { room.store.applyProposal("proposal1") }
            runCurrent(); wait.cancelAndJoin()
            assertEquals(1, room.outbox().size)
            proposal
        }
        val receipt = pending.copy(state = ProposalState.Applied)
        EngineRoomFixture(directory, backgroundScope, createEngine = open).use { room ->
            room.selected = "A"
            room.store.connect(room.account())
            assertEquals(ProposalRead.Found(pending), room.store.proposal("proposal1"))
            room.sync(server)
            room.store.refreshEngine()
            assertEquals(ProposalRead.Found(receipt), room.store.proposal("proposal1"))
        }
        EngineRoomFixture(directory, backgroundScope, createEngine = open).use { room ->
            room.selected = "A"
            room.store.connect(room.account())
            room.store.refreshEngine()
            assertEquals(ProposalRead.Found(receipt), room.store.proposal("proposal1"))
            assertTrue(room.outbox().isEmpty())
            SQLiteDatabase.openDatabase(database.path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
                db.execSQL("CREATE TRIGGER fail_metadata BEFORE INSERT ON device BEGIN SELECT RAISE(ABORT,'injected'); END")
            }
            room.store.proposalReceiptShown(receipt, room.store.accountKey)
            assertEquals(mapOf("proposal1" to receipt), room.store.unseenRemovalReceipts)
        }
        EngineRoomFixture(directory, backgroundScope, createEngine = open).use { room ->
            room.selected = "A"
            room.store.connect(room.account())
            assertEquals(ProposalRead.Found(receipt), room.store.proposal("proposal1"))
            SQLiteDatabase.openDatabase(database.path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
                db.execSQL("DROP TRIGGER fail_metadata")
            }
            room.store.proposalReceiptShown(receipt, room.store.accountKey)
            assertEquals(emptyMap<String, Proposal>(), room.store.unseenRemovalReceipts)
            assertEquals(ProposalRead.Found(receipt), room.store.proposal("proposal1"))
        }
        EngineRoomFixture(directory, backgroundScope, createEngine = open).use { room ->
            room.selected = "A"
            room.store.connect(room.account())
            assertEquals(ProposalRead.Gone, room.store.proposal("proposal1"))
        }
    }

    @Test fun aFailedApplyCommitQueuesNeitherTheRemovalNorItsReceiptAndAFailedAcknowledgmentRetainsIt() = runTest {
        val failures = mutableListOf<String>()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            val server = EngineRoomFixture.server()
            val pending = seed(room, server)
            room.engine.failNextCommit()
            assertEquals(ProposalOutcome.Failed(WriteFailure.NoAnswer), room.store.applyProposal("proposal1"))
            assertEquals(emptyList<Json>(), room.outbox())
            assertNull(room.engine.read(ScopeRef(Gym.scope)) { it.device(RemovalReceipts.key) })
            assertEquals(ProposalRead.Found(pending), room.store.proposal("proposal1"))
            val apply = async { room.store.applyProposal("proposal1") }
            runCurrent(); room.sync(server); advanceTimeBy(25); runCurrent()
            val receipt = (apply.await() as ProposalOutcome.Decided).proposal
            room.engine.failNextCommit()
            room.store.proposalReceiptShown(receipt, room.store.accountKey)
            assertEquals(mapOf("proposal1" to receipt), room.store.unseenRemovalReceipts)
            assertEquals(listOf("gym.applyProposal", "gym.proposal_receipt_shown"), failures)
            assertTrue(events.none { it.first == "gym_proposal_receipt_shown" })
            room.store.proposalReceiptShown(receipt, room.store.accountKey)
            room.store.proposalReceiptShown(receipt, room.store.accountKey)
            assertEquals(listOf("gym_proposal_receipt_shown" to mapOf("outcome" to "applied")),
                events.filter { it.first == "gym_proposal_receipt_shown" })
        }
    }

    @Test fun aReceiptBelongsToTheReplicaThatAppliedItAndReappearsAfterSignOutKeep() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server()
            val pending = seed(room, server)
            val wait = async { room.store.applyProposal("proposal1") }
            runCurrent(); wait.cancelAndJoin()
            room.sync(server); room.store.refreshEngine()
            val receipt = pending.copy(state = ProposalState.Applied)
            val owner = room.store.accountKey
            room.select("B")
            assertEquals(ProposalRead.Gone, room.store.proposal("proposal1"))
            assertTrue(room.store.unseenRemovalReceipts.isEmpty())
            room.store.proposalReceiptShown(receipt, owner)
            room.select("A")
            room.store.refreshEngine()
            assertEquals(ProposalRead.Found(receipt), room.store.proposal("proposal1"))
            assertEquals(mapOf("proposal1" to receipt), room.store.unseenRemovalReceipts)
        }
    }

    @Test fun aLostPushReplyKeepsThePendingReviewReachableAfterPullAndRelaunch() = runTest {
        val server = EngineRoomFixture.server()
        lateinit var pending: Proposal
        val snapshot = EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            pending = seed(room, server)
            val wait = async { room.store.applyProposal("proposal1") }
            runCurrent(); wait.cancelAndJoin()
            val request = requireNotNull(room.engine.nextPush())
            assertEquals(200, server.push(request, Credential.Account("A"), room.now).status)
            room.pull(server)
            assertEquals(1, room.outbox().size)
            room.engine.snapshot()
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, snapshot).use { room ->
            room.selected = "A"
            room.store.connect(room.account())
            room.store.refreshEngine()
            assertEquals(ProposalRead.Found(pending), room.store.proposal("proposal1"))
            assertEquals(listOf(pending), room.store.pendingProposals)
            assertTrue(room.store.unseenRemovalReceipts.isEmpty())
            val queued = room.outbox()
            val retry = async { room.store.applyProposal("proposal1") }
            runCurrent()
            assertEquals(queued, room.outbox())
            room.sync(server); advanceTimeBy(25); runCurrent()
            assertEquals(ProposalOutcome.Decided(pending.copy(state = ProposalState.Applied)), retry.await())
        }
    }

    @Test fun aRetriedRefusedRemovalUsesANewCommandAndIgnoresItsOldNotice() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server()
            val pending = seed(room, server)
            val first = async { room.store.applyProposal("proposal1") }
            runCurrent()
            val original = room.outbox().single()
            server.refuse(code = "stale"); room.sync(server); advanceTimeBy(25); runCurrent()
            assertTrue(first.await() is ProposalOutcome.Settled)
            val retry = async { room.store.applyProposal("proposal1") }
            runCurrent()
            assertEquals(1, room.outbox().size)
            assertNotEquals(original.member("gestureId"), room.outbox().single().member("gestureId"))
            room.sync(server); advanceTimeBy(25); runCurrent()
            assertEquals(ProposalOutcome.Decided(pending.copy(state = ProposalState.Applied)), retry.await())
        }
    }

    @Test fun showingTheReceiptBeforeTheOriginalWaitResumesStillAnswersThatWait() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server()
            val pending = seed(room, server)
            val applying = async { room.store.applyProposal("proposal1") }
            runCurrent(); room.sync(server); room.store.refreshEngine()
            val receipt = pending.copy(state = ProposalState.Applied)
            assertFalse(applying.isCompleted)
            room.store.proposalReceiptShown(receipt, room.store.accountKey)
            advanceTimeBy(25); runCurrent()
            assertEquals(ProposalOutcome.Decided(receipt), applying.await())
        }
    }

    @Test fun receiptResultWritesRollBackOrSurviveAProcessDeathWithTheMatchingCommand() = runTest {
        for (failure in listOf("storage", "crash")) {
            val server = EngineRoomFixture.server()
            var failResult = false
            lateinit var pending: Proposal
            lateinit var request: Json
            lateinit var response: SyncResponse
            lateinit var timing: RequestTiming
            val snapshot = EngineRoomFixture(tmp.newFolder(), backgroundScope, createEngine = { state, clock ->
                lateinit var engine: Engine
                engine = Engine.memory(SyncSchema.registry, state, clock,
                    intentResultWrites = { intent, result, epoch, gesture, values ->
                        if (failResult) { failResult = false; engine.failNextCommit() }
                        EngineTraining.intentResultWrites(intent, result, epoch, gesture, values)
                    }, pendingDeviceWork = WorkoutImports.pendingDeviceWork, rewriteDeviceValue = WorkoutImports.rewriteDeviceValue)
                engine
            }).use { room ->
                pending = seed(room, server)
                val wait = async { room.store.applyProposal("proposal1") }
                runCurrent(); wait.cancelAndJoin()
                request = requireNotNull(room.engine.nextPush())
                val reply = server.push(request, Credential.Account("A"), room.now)
                response = SyncResponse(reply.status, reply.body)
                val clock = ClockReading(room.now, room.now, "test")
                timing = RequestTiming(clock, clock)
                if (failure == "storage") {
                    failResult = true
                    assertThrows(CommitFailure::class.java) { room.engine.onPushResponse(request, response, timing) }
                } else {
                    room.engine.crashAfterTransactions(2)
                    assertThrows(EngineCrash::class.java) { room.engine.onPushResponse(request, response, timing) }
                }
                assertTrue(room.store.unseenRemovalReceipts.isEmpty())
                room.engine.snapshot()
            }
            EngineRoomFixture(tmp.newFolder(), backgroundScope, snapshot).use { room ->
                room.selected = "A"
                room.store.connect(room.account())
                assertEquals(ProposalRead.Found(pending), room.store.proposal("proposal1"))
                room.engine.onPushResponse(request, response, timing)
                room.pull(server)
                room.store.refreshEngine()
                assertEquals(ProposalRead.Found(pending.copy(state = ProposalState.Applied)), room.store.proposal("proposal1"))
            }
        }
    }

    @Test fun explicitAndTerminalWireRefusalsSurviveRelaunchWithoutInventingARemovalReceipt() = runTest {
        for (status in listOf(200, 400, 413)) {
            val server = EngineRoomFixture.server()
            val snapshot = EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
                seed(room, server)
                val apply = async { room.store.applyProposal("proposal1") }
                runCurrent()
                if (status == 200) { server.refuse(code = "stale"); room.sync(server) }
                else {
                    val request = requireNotNull(room.engine.nextPush())
                    val clock = ClockReading(room.now, room.now, "test")
                    room.engine.onPushResponse(request, SyncResponse(status), RequestTiming(clock, clock))
                }
                advanceTimeBy(25); runCurrent()
                assertTrue(apply.await() is ProposalOutcome.Settled)
                assertTrue(room.store.unseenRemovalReceipts.isEmpty())
                assertEquals(ProposalState.Pending, room.training.proposal("proposal1")!!.state)
                assertEquals("Original", room.training.routine("routine1")!!.name)
                room.engine.snapshot()
            }
            EngineRoomFixture(tmp.newFolder(), backgroundScope, snapshot).use { room ->
                room.selected = "A"
                room.store.connect(room.account())
                withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.notices("gym").notices.first { it.isNotEmpty() } } }
                room.store.refreshEngine()
                assertEquals(1, room.store.refusals.size)
                assertTrue(room.store.settledProposals.isEmpty())
                assertFalse(room.store.removalPending("proposal1"))
                room.store.clearRefusals()
                assertNull(room.engine.read(ScopeRef(Gym.scope)) { it.device(RemovalReceipts.key) })
                room.training.deleteRoutine("routine1")
                room.sync(server)
                room.store.refreshEngine()
                assertTrue("An unrelated deletion is not this Apply's receipt", room.store.unseenRemovalReceipts.isEmpty())
            }
        }
    }
}
