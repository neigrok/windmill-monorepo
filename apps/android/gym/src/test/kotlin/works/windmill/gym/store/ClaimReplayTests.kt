package works.windmill.gym.store

import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*
import works.windmill.sync.api.*
import works.windmill.sync.core.ClockReading
import works.windmill.sync.core.Json
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.*
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

internal fun legacyConsent(directory: File, consent: ClaimConsent?) {
    val value = consent?.let { Json.parse(diskJson.encodeToString(ClaimConsent.serializer(), it)) } ?: Json.Null
    File(directory, LocalClaimConsent.fileName).writeText(Json.objectOf("version" to Json.of(1), "consent" to value).jcs)
}

internal class LegacyEngineFixture(val directory: File) {
    val now = 1_800_000_000_000L
    val log get() = LocalLog(File(directory, LocalLog.fileName))
    val queue get() = SetQueue(File(directory, SetQueue.fileName))
    val prefs get() = LocalPreferences(File(directory, LocalPreferences.fileName))
    val weights get() = LocalBodyweight(File(directory, LocalBodyweight.fileName))
    fun engine(snapshot: Json? = null) = Engine.memory(SyncSchema.registry, snapshot,
        clock = object : EngineClock { override fun now() = now }, rewriteDeviceValue = LegacyGymMigration.rewriteDeviceValue,
        pendingDeviceWork = LegacyGymMigration.pendingDeviceWork, commandResultWrites = LegacyGymMigration.commandResultWrites)
    fun row(id: String = "session01", start: Long = now - 10_000) = LocalLog.FinishedSession(
        Session(id, start, start + 2_000), listOf(TrainingSet("set00001", "bench-press", weightKg = 82.5, reps = 5, completedAtMs = start + 1_000)))
    fun migrate(engine: Engine, owner: String? = null) = LegacyGymMigration(directory, engine, owner).run()
    fun outbox(engine: Engine) = engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }
    fun items(engine: Engine) = engine.read(LegacyGymMigration.scope) { it.devices(LegacyGymMigration.journalPrefix).values
        .flatMap { journal -> journal.member("items").obj().values } }
    fun refuseFirst(engine: Engine, code: String) {
        if (engine.read(LegacyGymMigration.scope) { it.isAnonymous }) engine.signIn("A", emptyMap())
        val request = engine.nextPush(1)!!
        val n = request.member("intents").arr().single().member("n")
        val reading = ClockReading(now, now, "boot")
        engine.onPushResponse(request, SyncResponse(200, Json.objectOf("epoch" to Json.of("ep-1"), "as" to Json.of("A"), "lastN" to n,
            "results" to Json.array(Json.objectOf("n" to n, "s" to Json.of("refused"), "code" to Json.of(code))))), RequestTiming(reading, reading))
    }
    fun seed(engine: Engine, type: String, id: String, fields: Map<String, Json>) {
        assertTrue(engine.commit(LegacyGymMigration.scope, Gesture(listOf(Change.create(type, NewID.Given(RecordID(id)), fields)))) is CommitOutcome.Committed)
    }
}

class ClaimReplayTests {
    @get:Rule val tmp = TemporaryFolder()
    private fun fixture() = LegacyEngineFixture(tmp.root)

    @Test fun shelvesKeepTheirDependencyOrderAndFinishedWorkoutsGoOldestFirst() {
        val f = fixture(); val log = f.log
        log.hold(Exercise("exercise1", "Local press", custom = true))
        log.hold(Routine("routine01", "Local routine"))
        log.hold(f.row("session02", f.now - 5_000).copy(sets = listOf(f.row().sets.single().copy(id = "set00002", completedAtMs = f.now - 4_000))))
        log.hold(f.row())
        f.engine().use { e -> f.migrate(e)
            val entries = f.outbox(e)
            assertEquals(listOf("exercise", "routine"), entries.take(2).map { it.member("intent").member("d").arr().single().member("t").str() })
            assertEquals(listOf("session01", "session02"), entries.drop(2).map { it.member("intent").member("cmd").member("args").member("id").str() })
        }
    }
    @Test fun anOwedRackIsKeptWithItsFullPreferenceDocument() {
        val f = fixture(); val value = GymPreferences(units = Units.Pounds, confirmSound = true); f.prefs.save(value)
        f.engine().use { e -> f.migrate(e); assertEquals(value, runBlocking { EngineTraining(e) { null }.preferences() }) }
    }
    @Test fun aRefusedWorkoutDoesNotPreventPreferencesFromMigrating() {
        val f = fixture(); f.log.hold(f.row(start = f.now + 1_000)); f.prefs.save(GymPreferences(confirmSound = true))
        f.engine().use { e -> f.migrate(e); assertEquals(1, LegacyGymMigration.refusals(e).size)
            assertTrue(runBlocking { EngineTraining(e) { null }.preferences() }.confirmSound) }
    }
    @Test fun aRefusedWorkoutDoesNotPreventAnotherWorkoutFromMigrating() {
        val f = fixture(); val refused = f.row(start = f.now + 1_000)
        f.log.hold(refused); f.log.hold(f.row("session02").copy(sets = emptyList()))
        f.engine().use { e -> f.migrate(e)
            assertEquals(listOf("session02"), e.read(LegacyGymMigration.scope) { reader -> reader.drawn(Gym.Types.session).filter { it.isVisible }.map { it.id.string } })
            assertEquals(refused.session, LegacyGymMigration.refusals(e).single().session); assertEquals(refused.sets, LegacyGymMigration.refusals(e).single().sets)
            assertEquals(setOf("session01", "session02"), EngineTraining(e) { null }.details().map { it.session.id }.toSet()) }
    }
    @Test fun aRackMigrationIsIdempotentAcrossProcessReplacement() {
        val f = fixture(); f.prefs.save(GymPreferences(units = Units.Pounds))
        val first = f.engine(); f.migrate(first); val snapshot = first.snapshot(); first.close()
        f.engine(snapshot).use { e -> f.migrate(e); assertEquals(1, f.outbox(e).size)
            assertEquals(Units.Pounds, runBlocking { EngineTraining(e) { null }.preferences() }.units) }
    }
    @Test fun aRejectedHistorySourceIsVisibleAndCannotBeLostByDismissalOfAnEngineNotice() {
        val f = fixture(); f.log.hold(f.row())
        f.engine().use { e -> f.migrate(e); f.refuseFirst(e, "session-overlap")
            val before = LegacyGymMigration.refusals(e).single(); e.events()
            assertEquals(before, LegacyGymMigration.refusals(e).single()); assertEquals(f.row().sets, before.sets) }
    }
    @Test fun brokenTimestampsAreRefusedWithoutRepairingTheSavedWorkout() {
        val f = fixture(); val row = f.row().copy(session = f.row().session.copy(finishedAtMs = f.now - 11_000)); f.log.hold(row)
        f.engine().use { e -> f.migrate(e); val refused = LegacyGymMigration.refusals(e).single()
            assertEquals(row.session, refused.session); assertEquals(row.sets, refused.sets); assertTrue(f.outbox(e).isEmpty()) }
    }
    @Test fun aSpentSetIdentityIsNeverRemintedAfterServerRefusal() {
        val f = fixture(); f.log.hold(f.row())
        f.engine().use { e -> f.migrate(e); f.refuseFirst(e, "id-taken")
            val request = e.pullRequest(listOf(LegacyGymMigration.scope))!!
            val reply = ModelServer(SyncSchema.registry, GymServerRules()).pull(request, Credential.Account("A"), f.now)
            val reading = ClockReading(f.now, f.now, "boot")
            e.onPullResponse(request, SyncResponse(reply.status, reply.body), RequestTiming(reading, reading))
            LegacyGymMigration.retry(e, "session01")
            assertEquals("set00001", f.outbox(e).single().member("intent").member("cmd").member("args").member("sets").arr().single().member("id").str()) }
    }
    @Test fun aSpentRoutineIdentityDoesNotSilentlyOrphanItsWorkout() {
        val f = fixture(); val routine = Routine("routine01", "Saved", entries = listOf(RoutineEntry(exerciseId = "bench-press")))
        f.log.apply { hold(routine); hold(f.row().copy(session = f.row().session.copy(routineId = routine.id, plan = PlanSnapshot(routine)))) }
        f.engine().use { e -> f.migrate(e); f.refuseFirst(e, "id-taken")
            assertEquals("routine01", LegacyGymMigration.refusals(e).single().session!!.routineId)
            assertEquals("parent-dead", LegacyGymMigration.refusals(e).single().code) }
    }
    @Test fun aMissingRoutineNeedsExplicitUnlinkingBeforeItsWorkoutCanImport() {
        val f = fixture(); val row = f.row().copy(session = f.row().session.copy(routineId = "routine01")); f.log.hold(row)
        f.engine().use { e -> f.migrate(e); assertEquals("routine01", LegacyGymMigration.refusals(e).single().session!!.routineId)
            LegacyGymMigration.replaceAndRetry(e, row.session.id, row.copy(session = row.session.copy(routineId = null)))
            assertNull(f.outbox(e).single().member("intent").member("cmd").member("args")["routineId"]) }
    }
    @Test fun aMissingMovementKeepsTheEntireAtomicWorkoutForFixAndRetry() {
        val f = fixture(); val row = f.row().copy(sets = listOf(f.row().sets.single().copy(exerciseId = "missing01"))); f.log.hold(row)
        f.engine().use { e -> f.migrate(e); f.refuseFirst(e, "unknown-exercise")
            assertEquals(row.sets, LegacyGymMigration.refusals(e).single().sets); assertTrue(f.outbox(e).isEmpty()) }
    }
    @Test fun aSetCorrectedBeforeMigrationKeepsTheCorrectionAndIsNotQueuedTwice() {
        val f = fixture(); val row = f.row().copy(sets = listOf(f.row().sets.single().copy(weightKg = 87.5, reps = 6))); f.log.hold(row)
        f.engine().use { e -> f.migrate(e); f.migrate(e)
            assertEquals(row.sets, EngineTraining(e) { null }.details().single().sets); assertEquals(1, f.outbox(e).size) }
    }
    @Test fun anExplicitCorrectionAfterRefusalKeepsOriginalIdsAndOriginalSource() {
        val f = fixture(); f.log.hold(f.row())
        f.engine().use { e -> f.migrate(e); f.refuseFirst(e, "bad-instant"); val raw = f.items(e).single().member("source")
            LegacyGymMigration.replaceAndRetry(e, "session01", f.row().copy(sets = listOf(f.row().sets.single().copy(weightKg = 90.0))))
            assertEquals(raw, f.items(e).single().member("original")); assertEquals("set00001", EngineTraining(e) { null }.details().single().sets.single().id) }
    }
    @Test fun deletedSetTombstonesRemainUntilExplicitReconciliation() {
        val f = fixture(); f.log.hold(f.row().copy(deleted = listOf("deleted1")))
        f.engine().use { e -> f.migrate(e); assertEquals(listOf("deleted1"), LegacyGymMigration.deletedSets(e).map { it.setId })
            assertFalse(EngineTraining(e) { null }.details().single().sets.any { it.id == "deleted1" }) }
    }
    @Test fun anAttemptedAppendCorrectedBeforeUpgradeKeepsItsAttemptAndCorrection() {
        val f = fixture(); val queue = f.queue; queue.hold(f.row().session.copy(finishedAtMs = null), true)
        queue.store(f.row().sets.single(), "session01", true); queue.sending(queue.pending.single()); queue.fix(f.row().sets.single().copy(weightKg = 90.0))
        f.engine().use { e -> f.migrate(e); val entry = LegacyGymMigration.operations(e).single().entry
            assertTrue(entry.attempted); assertEquals(Owed.Fix, entry.write); assertEquals(90.0, entry.set.weightKg, 0.0) }
    }
    @Test fun anAttemptedAppendDeletedBeforeUpgradeKeepsTheOriginalDeleteIdentity() {
        val f = fixture(); val q = f.queue; q.hold(f.row().session.copy(finishedAtMs = null), true)
        q.store(f.row().sets.single(), "session01", true); q.sending(q.pending.single()); q.delete("set00001")
        f.engine().use { e -> f.migrate(e); val entry = LegacyGymMigration.operations(e).single().entry
            assertTrue(entry.attempted); assertEquals(Owed.Delete, entry.write); assertEquals("set00001", entry.set.id) }
    }
    @Test fun aTombstoneForAnUnknownSetCostsNoNewSetAndCanBeResolvedOnce() {
        val f = fixture(); f.log.hold(f.row().copy(deleted = listOf("neverhad1")))
        f.engine().use { e -> f.migrate(e); val tombstone = LegacyGymMigration.deletedSets(e).single()
            LegacyGymMigration.resolveDeletion(e, tombstone.token); LegacyGymMigration.resolveDeletion(e, tombstone.token)
            assertTrue(LegacyGymMigration.deletedSets(e).isEmpty()); assertEquals(listOf(Json.of("neverhad1")), f.items(e).single().member("source").member("deleted").arr()) }
    }
    @Test fun aFailedTombstoneResolutionRetainsItForAnotherPass() {
        val f = fixture(); f.log.hold(f.row().copy(deleted = listOf("deleted1")))
        f.engine().use { e -> f.migrate(e); val tombstone = LegacyGymMigration.deletedSets(e).single(); e.failNextCommit()
            assertThrows(CommitFailure::class.java) { LegacyGymMigration.resolveDeletion(e, tombstone.token) }
            assertEquals(listOf(tombstone), LegacyGymMigration.deletedSets(e)) }
    }
    @Test fun aRefusedCorrectionRemainsVisibleAndRetryRestoresTheExactOperation() {
        val f = fixture(); val q = f.queue; q.hold(f.row().session.copy(finishedAtMs = null), true); q.store(f.row().sets.single(), "session01", true)
        f.engine().use { e -> f.migrate(e); val operation = LegacyGymMigration.operations(e).single()
            LegacyGymMigration.refuseOperation(e, operation.token, "unknown-exercise")
            assertEquals(operation.entry.set, LegacyGymMigration.refusals(e).single().sets.single()); assertTrue(LegacyGymMigration.operations(e).isEmpty())
            LegacyGymMigration.retry(e, operation.entry.set.id); assertEquals(operation, LegacyGymMigration.operations(e).single()) }
    }
    @Test fun aDeletedLinkedRoutineNeverChangesTheArchivedFrozenPlan() {
        val f = fixture(); val row = f.row().copy(session = f.row().session.copy(routineId = "routine01", plan = PlanSnapshot("Gone", emptyList()))); f.log.hold(row)
        f.engine().use { e -> f.migrate(e); LegacyGymMigration.retry(e, row.session.id)
            assertEquals(row.session, LegacyGymMigration.refusals(e).single().session); assertTrue(f.outbox(e).isEmpty()) }
    }
    @Test fun routineHistoryCarriesItsExactFrozenPlan() {
        val f = fixture(); val routine = Routine("routine01", "Saved", entries = listOf(RoutineEntry(exerciseId = "bench-press", sets = listOf(SetTarget(5, 82.5)))))
        val row = f.row().copy(session = f.row().session.copy(routineId = routine.id, plan = PlanSnapshot(routine))); f.log.apply { hold(routine); hold(row) }
        f.engine().use { e -> f.migrate(e); assertEquals(row.session.plan, EngineTraining(e) { null }.details().single().session.plan) }
    }
    @Test fun bothAcknowledgedAndUnclaimedLiveStartsExplicitlyRefuseJoiningAndMigrateOnlyOnce() {
        listOf(false, true).forEach { unclaimed ->
            val directory = tmp.newFolder(); val f = LegacyEngineFixture(directory); val q = f.queue
            q.hold(f.row().session.copy(finishedAtMs = null), unclaimed); q.flush()
            f.engine().use { e -> f.migrate(e); f.migrate(e)
                assertEquals(1, f.outbox(e).size); assertFalse(f.outbox(e).single().member("intent").member("cmd").member("args").member("joinOpenSession").bool()) }
        }
    }
    @Test fun finishedImportsNeverJoinThePhonesOwnLiveWorkout() {
        val f = fixture(); f.log.hold(f.row()); f.queue.apply { hold(Session("session02", f.now - 2_000), true); flush() }
        f.engine().use { e -> f.migrate(e)
            assertEquals(setOf("gym.importSession", "gym.start"), f.outbox(e).map { it.member("intent").member("cmd").member("name").str() }.toSet())
            assertEquals(setOf("session01", "session02"), EngineTraining(e) { null }.details().map { it.session.id }.toSet()) }
    }
    @Test fun aClockAheadSourceRetriesWithoutSilentlyChangingItsTimes() {
        val f = fixture(); val row = f.row(start = f.now + 5_000); f.log.hold(row)
        f.engine().use { e -> f.migrate(e); LegacyGymMigration.retry(e, row.session.id)
            assertEquals(row.session, LegacyGymMigration.refusals(e).single().session); assertTrue(f.outbox(e).isEmpty()) }
    }
    @Test fun aTerminalImportRefusalStaysOnThePhoneAcrossProcessReplacement() {
        val f = fixture(); f.log.hold(f.row()); val e = f.engine(); f.migrate(e); f.refuseFirst(e, "session-finished")
        val refusal = LegacyGymMigration.refusals(e).single(); val snapshot = e.snapshot(); e.close()
        f.engine(snapshot).use { reopened -> assertEquals(listOf(refusal), LegacyGymMigration.refusals(reopened)) }
    }
    @Test fun aCanonicalCorrectionRetainsTheSetsIdentityAndItsWorkout() = runBlocking {
        val f = fixture(); f.engine().use { e -> val gym = EngineTraining(e) { null }
            gym.startSession(SessionStart("session01", f.now - 10_000)); gym.appendSet("session01", SetWrite("set00001", "bench-press", 82.5, 5, SetKind.Working, completedAt = f.now - 9_000))
            gym.fixSet("session01", "set00001", SetFix(weightKg = 90.0))
            assertEquals("set00001", gym.details().single().sets.single().id); assertEquals(90.0, gym.details().single().sets.single().weightKg, 0.0) }
    }
    @Test fun aDeletedAmbiguousAttemptIsNeverRecreatedUnderAFreshIdentity() {
        val f = fixture(); val q = f.queue; q.hold(f.row().session.copy(finishedAtMs = null), true)
        q.store(f.row().sets.single(), "session01", true); q.sending(q.pending.single()); q.delete("set00001")
        f.engine().use { e -> f.migrate(e); assertEquals(Owed.Delete, LegacyGymMigration.operations(e).single().entry.write)
            assertTrue(EngineTraining(e) { null }.details().single().sets.none { it.id == "set00001" })
            assertTrue(f.outbox(e).none { it.member("intent")["d"]?.arr()?.any { d -> d.member("t").str() == Gym.Types.set } == true }) }
    }
}
