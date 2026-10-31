package works.windmill.gym.coach.onboarding

import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import works.windmill.domain.kit.Id
import works.windmill.gym.domain.sync.CoachImportReceipt
import works.windmill.gym.domain.sync.CoachRoutineImport
import works.windmill.gym.domain.sync.Exercise
import works.windmill.gym.domain.sync.ImportCoachRoutineBatch
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.domain.sync.RoutineEntry
import works.windmill.gym.domain.sync.SetTarget
import works.windmill.gym.store.EngineTraining
import works.windmill.platform.ai.AiAllowance
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.api.DeviceWrite
import works.windmill.sync.api.Gesture
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineClock
import works.windmill.sync.engine.AndroidSqlite
import works.windmill.sync.engine.IdentitySource
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class CoachRoutineImportsTests {
    @get:Rule val temporary = TemporaryFolder()
    private val allowance = AiAllowance("ok", "USD", "lifetime", "anonymous", true, null, "0", "0", "0")
    private fun engine(initial: Json? = null) = Engine.memory(SyncSchema.registry, initial,
        clock = object : EngineClock { override fun now() = 1_800_000_000_000L },
        rewriteDeviceValue = EngineTraining.rewriteDeviceValue)
    private fun record(replica: String) = CoachOnboardingRecord("anonymous:fixture", "original-chat", replica,
        "11111111-1111-4111-8111-111111111111", "", 1_800_000_000_000, response = CoachOnboardingResponse(
            "11111111-1111-4111-8111-111111111111", "result", "completed", 1_900_000_000_000,
            listOf(CoachOnboardingResponse.Routine("Upper", listOf(CoachOnboardingResponse.Entry("bench-press",
                listOf(CoachOnboardingResponse.Target(5, 0.0)), 90)))), allowance))
    private val movement = Exercise(Id("movement1", Exercise), "Single press", "press", "dumbbell", 2.0, loadCount = 1)
    private val routines = listOf(CoachRoutineImport(Id("routineA", Routine), "Upper", listOf(RoutineEntry(movement.id,
        listOf(SetTarget(5, 0.0)), 90))), CoachRoutineImport(Id("routineB", Routine), "Lower",
        listOf(RoutineEntry(Id("back-squat", Exercise), listOf(SetTarget(5, -501.0)), 120))))

    @Test fun oneAtomicImportReplaysAfterProcessDeathBeforeAnyChatSavedStateUpdate() = runTest {
        val snapshot: Json
        val receipt: CoachImportReceipt
        engine().use { engine ->
            val record = record(engine.activeReplica())
            val imports = CoachRoutineImports(engine, { CoachOnboardingSeat(record.owner, record.replica) }, backgroundScope)
            receipt = (imports.apply(record, routines, listOf(movement)) as CoachImportOutcome.Committed).receipt
            assertEquals(listOf("routineA", "routineB"), receipt.routines.map { it.record.string })
            assertEquals(listOf("movement1"), receipt.movements.map { it.record.string })
            assertEquals(receipt, imports.receipt("result"))
            assertEquals(2, engine.read(Routine.scope) { it.drawn(Routine.type).size })
            assertEquals(1, engine.read(Exercise.scope) { it.drawn(Exercise.type).size })
            snapshot = engine.snapshot()
        }
        engine(snapshot).use { restored ->
            val record = record(restored.activeReplica())
            val imports = CoachRoutineImports(restored, { CoachOnboardingSeat(record.owner, record.replica) }, backgroundScope)
            assertEquals(CoachImportOutcome.Replayed(receipt), imports.apply(record, routines, listOf(movement)))
            assertEquals(snapshot, restored.snapshot())
            val changed = routines.mapIndexed { index, value -> if (index == 1) value.copy(name = "Different payload") else value }
            assertTrue(imports.apply(record, changed, listOf(movement)) is CoachImportOutcome.Refused)
            assertEquals(snapshot, restored.snapshot())
        }
    }

    @Test fun invalidNthDraftAndStorageFailureLeaveEveryRecordAndReceiptAbsent() = runTest {
        engine().use { engine ->
            val record = record(engine.activeReplica())
            val issues = mutableListOf<String>()
            val telemetry = object : Telemetry {
                override fun event(name: String, properties: Map<String, String>) = Unit
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { issues += operation }
            }
            val imports = CoachRoutineImports(engine, { CoachOnboardingSeat(record.owner, record.replica) }, backgroundScope, telemetry)
            val before = engine.snapshot()
            assertTrue(imports.apply(record, routines.dropLast(1) + routines.last().copy(name = " "), listOf(movement)) is CoachImportOutcome.Refused)
            assertEquals(before, engine.snapshot())
            engine.failNextCommit()
            assertEquals(CoachImportOutcome.Failed, imports.apply(record, routines, listOf(movement)))
            assertEquals(before, engine.snapshot())
            assertNull(imports.receipt("result"))
            assertEquals(listOf("gym.coachOnboarding"), issues)
            assertTrue(imports.apply(record, routines, listOf(movement)) is CoachImportOutcome.Committed)
        }
    }

    @Test fun concurrentApplyReturnsOneCommittedReceiptAndOneReplay() = runTest {
        engine().use { engine ->
            val record = record(engine.activeReplica())
            val imports = CoachRoutineImports(engine, { CoachOnboardingSeat(record.owner, record.replica) }, backgroundScope)
            val a = async { imports.apply(record, routines, listOf(movement)) }
            val b = async { imports.apply(record, routines, listOf(movement)) }
            val results = listOf(a.await(), b.await())
            assertEquals(1, results.count { it is CoachImportOutcome.Committed })
            assertEquals(1, results.count { it is CoachImportOutcome.Replayed })
            assertEquals(2, engine.read(Routine.scope) { it.drawn(Routine.type).size })
            assertEquals(1, engine.read(Exercise.scope) { it.drawn(Exercise.type).size })
        }
    }

    @Test fun authorityIsRecheckedInsideTheAtomicLoadAndCannotWriteIntoANewOwner() = runTest {
        engine().use { engine ->
            val record = record(engine.activeReplica())
            var checks = 0
            val imports = CoachRoutineImports(engine, {
                checks++
                if (checks == 1) CoachOnboardingSeat(record.owner, record.replica) else null
            }, backgroundScope)
            val before = engine.snapshot()
            assertTrue(imports.apply(record, routines, listOf(movement)) is CoachImportOutcome.Refused)
            assertEquals(2, checks)
            assertEquals(before, engine.snapshot())
        }
    }

    @Test fun disposingTheCallerWhileWriterAdmissionWaitsDoesNotCancelTheOwnedImport() = runBlocking {
        engine().use { engine ->
            val record = record(engine.activeReplica())
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val writer = Executors.newSingleThreadExecutor()
            val locked = CountDownLatch(1)
            val release = CountDownLatch(1)
            val admitted = CountDownLatch(1)
            val imports = CoachRoutineImports(engine, {
                admitted.countDown()
                CoachOnboardingSeat(record.owner, record.replica)
            }, scope)
            try {
                val held = writer.submit {
                    engine.commit(Routine.scope) { locked.countDown(); check(release.await(5, TimeUnit.SECONDS)); null to Unit }
                }
                assertTrue(locked.await(5, TimeUnit.SECONDS))
                val caller = launch(Dispatchers.Default) { imports.apply(record, routines, listOf(movement)) }
                assertTrue(admitted.await(5, TimeUnit.SECONDS))
                caller.cancel()
                release.countDown()
                held.get(5, TimeUnit.SECONDS)
                caller.join()
                withTimeout(5_000) { while (imports.receipt("result") == null) delay(10) }
                assertTrue(caller.isCancelled)
                assertEquals(2, engine.read(Routine.scope) { it.drawn(Routine.type).size })
                assertEquals(listOf(Id("routineA", Routine), Id("routineB", Routine)), imports.receipt("result")?.routines)
            } finally {
                release.countDown()
                scope.cancel()
                writer.shutdownNow()
            }
        }
    }

    @Test fun addRetainsUnrelatedAccountReceiptsAndDiscardRemovesOnlyAnonymousImports() = runTest {
        for (choice in listOf("add", "discard")) engine().use { engine ->
            engine.signIn("account", mapOf("gym" to false))
            val old = CoachImportReceipt("older-result", "b".repeat(64), listOf(Id("older-routine", Routine)), emptyList())
            engine.commit(Routine.scope, Gesture(emptyList(), local = listOf(DeviceWrite(CoachRoutineImports.receiptKey("older-result"), old.json))))
            engine.signOut("keep")
            val record = record(engine.activeReplica())
            val imports = CoachRoutineImports(engine, { CoachOnboardingSeat(record.owner, record.replica) }, backgroundScope)
            val saved = (imports.apply(record, routines, listOf(movement)) as CoachImportOutcome.Committed).receipt
            assertTrue(engine.signIn("account", mapOf("gym" to true), mapOf("gym" to choice)).member("complete").bool())
            assertEquals(old, imports.receipt("older-result"))
            if (choice == "add") {
                assertEquals(saved, imports.receipt("result"))
                assertEquals(2, engine.read(Routine.scope) { it.drawn(Routine.type).size })
            } else {
                assertNull(imports.receipt("result"))
                assertTrue(engine.read(Routine.scope) { it.drawn(Routine.type).isEmpty() })
            }
        }
    }

    @Test fun adoptionHookRewritesOnlyRecordReferencesAndPreservesTheFingerprintAndOtherReceipts() {
        val receipt = CoachImportReceipt("result", "a".repeat(64), listOf(Id("routineA", Routine), Id("routineB", Routine)), listOf(movement.id))
        val routine = EngineTraining.rewriteDeviceValue("gym", CoachRoutineImports.receiptKey("result"), receipt.json,
            Gym.Types.routine, RecordID("routineA"), RecordID("adopted-routine"))
        val movement = EngineTraining.rewriteDeviceValue("gym", CoachRoutineImports.receiptKey("result"), routine,
            Gym.Types.exercise, RecordID("movement1"), RecordID("adopted-movement"))
        assertEquals(receipt.copy(routines = listOf(Id("adopted-routine", Routine), Id("routineB", Routine)),
            movements = listOf(Id("adopted-movement", Exercise))).json, movement)
        assertEquals(receipt.json, EngineTraining.rewriteDeviceValue("gym", "unrelated", receipt.json,
            Gym.Types.routine, RecordID("routineA"), RecordID("adopted-routine")))
        assertEquals(receipt.json, EngineTraining.rewriteDeviceValue("journal", CoachRoutineImports.receiptKey("result"), receipt.json,
            Gym.Types.routine, RecordID("routineA"), RecordID("adopted-routine")))
    }

    @Test fun sqliteReceiptFailureRollsBackEveryRecordAndAClosedDatabaseReplaysWithoutAChatCache() = runTest {
        val database = File(temporary.root, "engine.sqlite")
        val initial = engine().use { it.snapshot() }
        val identities = object : IdentitySource {
            override fun opaqueID() = java.util.UUID.randomUUID().toString()
            override fun draw(bound: Int) = java.security.SecureRandom().nextInt(bound)
        }
        val clock = object : EngineClock { override fun now() = 1_800_000_000_000L }
        fun open() = AndroidSqlite.open(database, SyncSchema.registry, initial, clock, identities, identities.actorID(),
            rewriteDeviceValue = EngineTraining.rewriteDeviceValue)
        open().use { engine ->
            val record = record(engine.activeReplica())
            val imports = CoachRoutineImports(engine, { CoachOnboardingSeat(record.owner, record.replica) }, backgroundScope)
            val before = engine.snapshot()
            SQLiteDatabase.openDatabase(database.path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
                db.execSQL("CREATE TRIGGER fail_coach_receipt BEFORE INSERT ON device_row WHEN NEW.key LIKE 'rack:coachImport%' BEGIN SELECT RAISE(ABORT,'injected'); END")
            }
            assertEquals(CoachImportOutcome.Failed, imports.apply(record, routines, listOf(movement)))
            assertEquals(before, engine.snapshot())
        }
        val receipt = open().use { engine ->
            assertTrue(engine.read(Routine.scope) { it.drawn(Routine.type).isEmpty() })
            assertTrue(engine.read(Exercise.scope) { it.drawn(Exercise.type).isEmpty() })
            assertTrue(engine.read(Routine.scope) { it.devices(ImportCoachRoutineBatch.receiptPrefix).isEmpty() })
            SQLiteDatabase.openDatabase(database.path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
                db.rawQuery("SELECT count(*) FROM outbox", null).use { cursor -> assertTrue(cursor.moveToFirst()); assertEquals(0, cursor.getInt(0)) }
                db.execSQL("DROP TRIGGER fail_coach_receipt")
            }
            val record = record(engine.activeReplica())
            val imports = CoachRoutineImports(engine, { CoachOnboardingSeat(record.owner, record.replica) }, backgroundScope)
            (imports.apply(record, routines, listOf(movement)) as CoachImportOutcome.Committed).receipt
        }
        open().use { engine ->
            val record = record(engine.activeReplica())
            val imports = CoachRoutineImports(engine, { CoachOnboardingSeat(record.owner, record.replica) }, backgroundScope)
            val before = engine.snapshot()
            assertEquals(CoachImportOutcome.Replayed(receipt), imports.apply(record, routines, listOf(movement)))
            assertEquals(before, engine.snapshot())
            assertEquals(2, engine.read(Routine.scope) { it.drawn(Routine.type).size })
            assertEquals(1, engine.read(Exercise.scope) { it.drawn(Exercise.type).size })
            assertEquals(receipt, imports.receipt("result"))
        }
    }

    @Test fun receiptKeysFitTheExistingGrammarWithoutRestrictingOpaqueResultIdentities() {
        val opaque = "opaque/" + "x".repeat(120)
        val key = CoachRoutineImports.receiptKey(opaque)
        assertTrue(Regex("^rack:[A-Za-z0-9_-]{8,64}$").matches(key))
        assertEquals(59, key.removePrefix("rack:").length)
        assertEquals(48, key.removePrefix(ImportCoachRoutineBatch.receiptPrefix).length)
        assertEquals(key, CoachRoutineImports.receiptKey(opaque))
        assertNotEquals(key, CoachRoutineImports.receiptKey(opaque + "y"))
    }

    @Test fun parallelAndRetriedAppliesWithFreshlyMintedIdsImportOnce() = runBlocking {
        Engine.memory(SyncSchema.registry, null as Json?, clock = object : EngineClock { override fun now() = 1_800_000_000_000L },
            rewriteDeviceValue = EngineTraining.rewriteDeviceValue).use { engine ->
            val record = CoachOnboardingRecord("anonymous:fixture", "chat", engine.activeReplica(),
                "11111111-1111-4111-8111-111111111111", "", 1_800_000_000_000, response = CoachOnboardingResponse(
                    "11111111-1111-4111-8111-111111111111", "result", "completed", 1_900_000_000_000,
                    listOf(CoachOnboardingResponse.Routine("Upper", listOf(CoachOnboardingResponse.Entry("bench-press",
                        listOf(CoachOnboardingResponse.Target(5, 0.0)), 90))),
                        CoachOnboardingResponse.Routine("Lower", listOf(CoachOnboardingResponse.Entry("back-squat",
                            listOf(CoachOnboardingResponse.Target(5, 60.0)), 120)))),
                    allowance))
            val minted = java.util.concurrent.atomic.AtomicInteger()
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val imports = CoachRoutineImports(engine, { CoachOnboardingSeat(record.owner, record.replica) }, scope,
                mintRoutine = { "routine" + minted.incrementAndGet() })
            val outcomes = (1..8).map { scope.async { imports.apply(record) } }.map { it.await() } + imports.apply(record)
            assertEquals(1, outcomes.count { it is CoachImportOutcome.Committed })
            assertEquals(8, outcomes.count { it is CoachImportOutcome.Replayed })
            assertEquals(2, engine.read(Routine.scope) { it.drawn(Routine.type).size })
            assertEquals(1, outcomes.mapNotNull { (it as? CoachImportOutcome.Committed)?.receipt ?: (it as? CoachImportOutcome.Replayed)?.receipt }.toSet().size)
            scope.cancel()
        }
    }
}
