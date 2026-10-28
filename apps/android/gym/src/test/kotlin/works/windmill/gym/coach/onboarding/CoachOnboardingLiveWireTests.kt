package works.windmill.gym.coach.onboarding

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.util.Collections
import java.util.UUID
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import works.windmill.domain.kit.Fields
import works.windmill.domain.kit.Id
import works.windmill.gym.coach.LocalChat
import works.windmill.gym.coach.LocalCoach
import works.windmill.gym.domain.sync.CoachRoutineImport
import works.windmill.gym.domain.sync.Exercise
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.domain.sync.RoutineEntry
import works.windmill.gym.domain.sync.SetTarget
import works.windmill.gym.store.EngineTraining
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.ai.AiInstallationHttp
import works.windmill.platform.auth.KeptValues
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.telemetry.AndroidTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.engine.*
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class CoachOnboardingLiveWireTests {
    @Test fun aHostedDraftImportsAtomicallyReplaysAndAdoptsThroughTheRealSyncDoor() = runBlocking {
        assumeTrue(System.getenv("WM_ANDROID_COACH_WIRE_TEST") == "1")
        val base = checkNotNull(System.getenv("WM_WIRE_BASE")).toHttpUrl()
        require(base.host in setOf("127.0.0.1", "localhost"))
        val bearer = checkNotNull(System.getenv("WM_WIRE_BEARER"))
        val evidence = File(checkNotNull(System.getenv("WM_COACH_EVIDENCE"))).apply { mkdirs() }
        val release = checkNotNull(System.getenv("WM_COACH_RELEASE"))
        val context = RuntimeEnvironment.getApplication()
        val eventPrefs = context.getSharedPreferences("works.windmill.telemetry", Context.MODE_PRIVATE)
        assertTrue(eventPrefs.edit().clear().commit())
        val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        AndroidTelemetry.startSentry(context, checkNotNull(System.getenv("WM_COACH_SENTRY_DSN")), release, "local", "38")
        val delivery = AndroidTelemetry(context, base, release, "local", "task38", "38", null, { null }, applicationScope)
        val failures = Collections.synchronizedList(mutableListOf<String>())
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) = delivery.event(name, properties)
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                failures += operation
                delivery.failure(operation, error, properties)
            }
        }
        val installPrefs = context.getSharedPreferences("coach-wire-installation", Context.MODE_PRIVATE)
        assertTrue(installPrefs.edit().clear().commit())
        val values = object : KeptValues {
            override fun read(key: String) = installPrefs.getString(key, null)
            override fun write(values: Map<String, String?>) {
                val edit = installPrefs.edit()
                values.forEach { (key, value) -> if (value == null) edit.remove(key) else edit.putString(key, value) }
                check(edit.commit())
            }
        }
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val installation = AiInstallation(values, SecretVault { key }, AiInstallationHttp(base, telemetry), telemetry)
        val local = LocalCoach(File(evidence, LocalCoach.fileName))
        val owner = local.anonymousOwner()
        local.saveChat(owner, LocalChat("original"), select = true)
        local.saveChat(owner, LocalChat("other"))
        val database = File(evidence, "engine.sqlite")
        val clock = object : EngineClock { override fun now() = System.currentTimeMillis() }
        val ids = object : IdentitySource {
            override fun opaqueID() = UUID.randomUUID().toString()
            override fun draw(bound: Int) = java.security.SecureRandom().nextInt(bound)
        }
        val initial = Engine.memory(SyncSchema.registry, clock = clock).use { it.snapshot() }
        fun open() = AndroidSqlite.open(database, SyncSchema.registry, initial, clock, ids, ids.actorID(),
            rewriteDeviceValue = EngineTraining.rewriteDeviceValue)
        val replica = open().use { it.activeReplica() }
        val seat = CoachOnboardingSeat(owner, replica)
        val http = CoachOnboardingHttp(base, telemetry)
        val coordinator = CoachOnboardingStore(local, installation, http, { seat }, applicationScope, telemetry)
        try {
            assertEquals(AnonymousCoachAccess.Available, coordinator.access())
            val pending = coordinator.send("original", "Draft a routine")
            local.select(owner, "other")
            val answered = withTimeout(20_000) { pending.await() }
            assertTrue(answered is CoachOnboardingOutcome.Answered)
            val record = (answered as CoachOnboardingOutcome.Answered).record
            val response = checkNotNull(record.response)
            assertEquals("original", record.chat)
            assertEquals("other", local.selected(owner))
            assertEquals(listOf(record), coordinator.records(owner, "original"))
            assertEquals(emptyList<CoachOnboardingRecord>(), coordinator.records(owner, "other"))
            assertEquals("completed", response.status)
            assertEquals(2, response.routines.size)
            assertEquals(record.requestId, record.request().requestId)
            assertEquals(record, LocalCoach(File(evidence, LocalCoach.fileName)).onboarding(owner, record.requestId))
            val credential = installation.forRecovery()
            assertTrue(installPrefs.all.values.none { it.toString().contains(credential) })
            val movement = Exercise(Id("ex_" + UUID.randomUUID().toString().replace("-", ""), Exercise),
                "Wire assistance", "pull", "other", 2.5)
            val routines = response.routines.mapIndexed { index, routine ->
                CoachRoutineImport(Id("rt_" + UUID.randomUUID().toString().replace("-", ""), Routine), routine.name,
                    routine.entries.mapIndexed { entryIndex, entry ->
                        if (index == 0 && entryIndex == 0)
                            RoutineEntry(movement.id, listOf(SetTarget(5, -12.5), SetTarget(null, 0.0), SetTarget(8)), 90)
                        else RoutineEntry(Id(entry.exerciseId, Exercise),
                            entry.sets.takeIf { it.isNotEmpty() }?.map { SetTarget(it.reps, it.weightKg) }, entry.restSeconds)
                    })
            }
            open().use { engine ->
                val imports = CoachRoutineImports(engine, { seat }, applicationScope, telemetry)
                val before = engine.snapshot()
                SQLiteDatabase.openDatabase(database.path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
                    db.execSQL("CREATE TRIGGER fail_coach_receipt BEFORE INSERT ON device_row WHEN NEW.key LIKE 'rack:coachImport%' BEGIN SELECT RAISE(ABORT,'injected'); END")
                }
                assertEquals(CoachImportOutcome.Failed, imports.apply(record, routines, listOf(movement)))
                assertEquals(before, engine.snapshot())
                assertNull(imports.receipt(response.resultId))
            }
            val receipt = open().use { engine ->
                assertTrue(engine.read(Routine.scope) { it.drawn(Routine.type).isEmpty() })
                assertTrue(engine.read(Exercise.scope) { it.drawn(Exercise.type).isEmpty() })
                SQLiteDatabase.openDatabase(database.path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
                    db.rawQuery("SELECT count(*) FROM outbox", null).use { cursor -> assertTrue(cursor.moveToFirst()); assertEquals(0, cursor.getInt(0)) }
                    db.execSQL("DROP TRIGGER fail_coach_receipt")
                }
                val saved = CoachRoutineImports(engine, { seat }, applicationScope, telemetry).apply(record, routines, listOf(movement))
                assertTrue(saved is CoachImportOutcome.Committed)
                (saved as CoachImportOutcome.Committed).receipt
            }
            open().use { engine ->
                val imports = CoachRoutineImports(engine, { seat }, applicationScope, telemetry)
                val before = engine.snapshot()
                assertEquals(CoachImportOutcome.Replayed(receipt), imports.apply(record, routines, listOf(movement)))
                assertEquals(before, engine.snapshot())
                assertEquals(receipt, imports.receipt(response.resultId))
                val transport = HTTPTransport(base.toString(), SyncSchema.registry.version.toInt())
                suspend fun answer(reply: Reply<SyncResponse>): SyncResponse = when (reply) {
                    is Reply.Answer -> reply.value
                    is Reply.Failed -> reply.response
                    Reply.Unreachable -> error("The local verification server is unavailable.")
                }
                val send = clock.reading()
                val hello = answer(transport.hello(bearer))
                assertEquals(200, hello.status)
                engine.onHello(hello, RequestTiming(send, clock.reading()))
                val body = checkNotNull(hello.body)
                val account = body.member("as").str()
                val holds = body.member("holdsRecords").obj().mapValues { it.value.bool() }
                assertTrue(holds.values.none { it })
                val adopted = engine.signIn(account, holds, serverSchema = body.member("schema").long())
                assertTrue(adopted.member("complete").bool())
                engine.subscribe(ScopeRef(Gym.scope))
                val adapter = EngineTraining(engine)
                withTimeout(20_000) {
                    while (true) {
                        val push = engine.nextPush()
                        if (push != null) {
                            val sent = clock.reading()
                            engine.onPushResponse(push, answer(transport.push(push, bearer)), RequestTiming(sent, clock.reading()))
                        }
                        val pull = checkNotNull(engine.pullRequest(listOf(ScopeRef(Gym.scope))))
                        val sent = clock.reading()
                        engine.onPullResponse(pull, answer(transport.pull(pull, bearer)), RequestTiming(sent, clock.reading()))
                        if (adapter.firstPullComplete && engine.read(Routine.scope) {
                            it.drawn(Routine.type).size == 2 && it.drawn(Routine.type).all { row -> !row.isPending } &&
                                it.drawn(Exercise.type).size == 1 && it.drawn(Exercise.type).all { row -> !row.isPending }
                        }) break
                        delay(100)
                    }
                }
                val adoptedReceipt = checkNotNull(imports.receipt(response.resultId))
                assertEquals(receipt.fingerprint, adoptedReceipt.fingerprint)
                assertEquals(2, adoptedReceipt.routines.size)
                assertEquals(1, adoptedReceipt.movements.size)
                assertEquals(response.resultId, adoptedReceipt.resultId)
                val expectedMovement = movement.copy(id = adoptedReceipt.movements.single())
                val expectedRoutines = routines.mapIndexed { index, routine ->
                    Routine(adoptedReceipt.routines[index], routine.name, index, routine.entries.map { entry ->
                        if (entry.exerciseId == movement.id) entry.copy(exerciseId = expectedMovement.id) else entry
                    })
                }
                engine.read(Routine.scope) { read ->
                    val actualRoutines = read.drawn(Routine.type).map { Routine.decode(Fields(it)) }.sortedBy { it.position }
                    assertEquals(expectedRoutines.map { it.id }, actualRoutines.map { it.id })
                    assertEquals(expectedRoutines.map { it.fields() }, actualRoutines.map { it.fields() })
                    assertEquals(listOf(expectedMovement), read.drawn(Exercise.type).map { Exercise.decode(Fields(it)) })
                }
                evidence.resolve("expected.json").writeText(Json.objectOf(
                    "routines" to Json.Arr(expectedRoutines.map { routine -> Json.Obj(listOf("id" to routine.id.json) + routine.fields().toList()) }),
                    "movements" to Json.Arr(listOf(Json.Obj(listOf("id" to expectedMovement.id.json) + expectedMovement.fields().toList())))
                ).jcs)
                evidence.resolve("receipt.json").writeText(adoptedReceipt.json.jcs)
                installation.bind(account, bearer)
                assertEquals(AnonymousCoachAccess.Bound, coordinator.access())
                assertEquals(credential, installation.forRecovery())
                val recovered = http.get(record.requestId, installation.forRecovery())
                assertEquals(response.resultId, recovered.resultId)
                assertEquals(response.routines, recovered.routines)
            }
            assertEquals(listOf("gym.coachOnboarding"), failures.toList())
            withTimeout(10_000) {
                while (eventPrefs.getString("queue", null)?.let { raw ->
                    Json.parse(raw).member("shelves").arr().all { it.member("events").arr().isEmpty() }
                } != true) delay(100)
            }
            evidence.resolve("completed.json").writeText(Json.objectOf("requestId" to Json.of(record.requestId),
                "resultId" to Json.of(response.resultId), "replica" to Json.of(replica), "release" to Json.of(release),
                "clientFailureOperations" to Json.Arr(failures.map(Json::of))).jcs)
        } finally {
            applicationScope.cancel()
        }
    }
}
