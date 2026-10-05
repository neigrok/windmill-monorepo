package works.windmill.gym.store

import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.core.Json
import works.windmill.sync.engine.*

class ClaimTransferTests {
    @get:Rule val tmp = TemporaryFolder()
    private fun fixture() = LegacyEngineFixture(tmp.root)
    private fun decision(engine: Engine) = engine.signIn("A", mapOf("gym" to true))
    private fun counted(question: Json) = mapOf("gym" to question.member("due").arr().single().member("counted").arr().map(Json::str))

    @Test fun selectingAnAccountLeavesTheWholeAnonymousBatchUntouchedUntilTheDecision() {
        val f = fixture(); f.log.hold(Exercise("exercise1", "Local press", custom = true)); f.log.hold(f.row())
        f.engine().use { e -> f.migrate(e); val before = f.outbox(e); val question = decision(e)
            assertFalse(question.member("complete").bool()); assertTrue(e.read(LegacyGymMigration.scope) { it.isAnonymous }); assertEquals(before, f.outbox(e))
            assertEquals(setOf("exercise", "session", "set"), question.member("due").arr().single().member("count").obj().keys) }
    }
    @Test fun anAddBindsTheExactWorkoutAndIdentifiersToItsAccount() {
        val f = fixture(); f.log.hold(f.row())
        f.engine().use { e -> f.migrate(e); val question = decision(e)
            e.signIn("A", mapOf("gym" to true), mapOf("gym" to "add"), counted(question))
            assertEquals(f.row().session, EngineTraining(e) { null }.details().single().session)
            assertEquals(f.row().sets, EngineTraining(e) { null }.details().single().sets)
            assertTrue(f.outbox(e).all { it.member("lineage").str() == "A" }) }
    }
    @Test fun aDiscardRemovesOnlyTheCountedAnonymousWorkAndCannotResurrectOnBoot() {
        val f = fixture(); f.log.hold(f.row())
        val e = f.engine(); f.migrate(e); val question = decision(e); e.signIn("A", mapOf("gym" to true), mapOf("gym" to "discard"), counted(question))
        val snapshot = e.snapshot(); e.close()
        f.engine(snapshot).use { reopened -> f.migrate(reopened); assertTrue(f.outbox(reopened).isEmpty()); assertTrue(EngineTraining(reopened) { null }.details().isEmpty()) }
    }
    @Test fun storageFailureBeforeAddPreservesTheSourceAndRequiresRetry() {
        val f = fixture(); f.log.hold(f.row())
        f.engine().use { e -> f.migrate(e); val question = decision(e); val before = e.snapshot(); e.failNextCommit()
            assertThrows(CommitFailure::class.java) { e.signIn("A", mapOf("gym" to true), mapOf("gym" to "add"), counted(question)) }
            assertEquals(before, e.snapshot()); assertTrue(e.read(LegacyGymMigration.scope) { it.isAnonymous })
            assertTrue(e.signIn("A", mapOf("gym" to true), mapOf("gym" to "add"), counted(question)).member("complete").bool()) }
    }
    @Test fun signingInWithoutAnExplicitAnswerCannotSendAnonymousTraining() {
        val f = fixture(); f.log.hold(f.row())
        f.engine().use { e -> f.migrate(e); val question = decision(e)
            assertFalse(question.member("complete").bool()); assertNull(e.nextPush()); assertEquals(1, f.outbox(e).size) }
    }
    @Test fun aDiscardDecisionCannotSweepTrainingAddedAfterItsCountedSnapshot() {
        val f = fixture(); f.log.hold(f.row())
        f.engine().use { e -> f.migrate(e); val question = decision(e)
            f.seed(e, "exercise", "exercise1", mapOf("name" to Json.of("After"), "pattern" to Json.of("press"), "equipment" to Json.of("barbell"), "stepKg" to Json.of(2.5)))
            val result = e.signIn("A", mapOf("gym" to true), mapOf("gym" to "discard"), counted(question))
            assertFalse(result.member("complete").bool()); assertEquals(2, f.outbox(e).size); assertEquals("exercise1", EngineTraining(e) { null }.catalogue().first { it.id == "exercise1" }.id) }
    }
    @Test fun aCorruptPriorConsentStaysVisibleWithItsOriginalBytesAndDoesNotCrashTheRoom() {
        val f = fixture(); f.log.hold(f.row()); val file = File(tmp.root, LocalClaimConsent.fileName); file.writeText("not a decision")
        f.engine().use { e -> f.migrate(e); val refusal = LegacyGymMigration.refusals(e).single()
            assertEquals("source-unreadable", refusal.code); assertEquals("not a decision", file.readText()); assertEquals(f.row().session, EngineTraining(e) { null }.details().single().session) }
    }
    @Test fun aCompletedDiscardRetainsAnArchiveWithoutAnyFutureAccountAdoption() {
        val f = fixture(); f.log.hold(f.row()); legacyConsent(tmp.root, ClaimConsent.Discarding(ClaimBatch("discard", f.log.claimItems())))
        f.engine().use { e -> f.migrate(e); e.signIn("A", emptyMap()); assertTrue(f.outbox(e).isEmpty())
            e.signOut("keep"); e.signIn("B", emptyMap()); f.migrate(e); assertTrue(f.outbox(e).isEmpty())
            assertTrue(File(tmp.root, LegacyGymMigration.archiveName).readText().contains("session01")) }
    }
    @Test fun approvedPriorConsentResumesOnlyItsPersistedOwnerAfterProcessReplacement() {
        val f = fixture(); f.log.hold(f.row()); legacyConsent(tmp.root, ClaimConsent.Approved(ClaimBatch("batch", f.log.claimItems()), "A", "flow1"))
        val e = f.engine(); f.migrate(e); val snapshot = e.snapshot(); e.close()
        f.engine(snapshot).use { reopened -> reopened.signIn("B", emptyMap()); assertTrue(EngineTraining(reopened) { null }.details().isEmpty())
            reopened.signOut("keep"); reopened.signIn("A", emptyMap()); assertEquals(f.row().session, EngineTraining(reopened) { null }.details().single().session) }
    }
    @Test fun signOutKeepPreservesUnsentWorkForTheSameAccountAndIsolatesTheNextPerson() {
        val f = fixture(); f.log.hold(f.row())
        f.engine().use { e -> f.migrate(e); e.signIn("A", emptyMap()); val pending = e.signOut()
            assertEquals(1L, pending.member("ready").long()); e.signOut("keep")
            assertTrue(EngineTraining(e) { null }.details().isEmpty()); e.signIn("B", emptyMap()); assertTrue(EngineTraining(e) { null }.details().isEmpty())
            e.signOut("keep"); e.signIn("A", emptyMap()); assertEquals(f.row().session, EngineTraining(e) { null }.details().single().session) }
    }
    @Test fun aFailedMigrationPreflightCannotPartiallyTransferTheWorkout() {
        val f = fixture(); f.log.hold(f.row()); val e = f.engine(); e.failNextCommit()
        assertThrows(CommitFailure::class.java) { f.migrate(e) }; assertTrue(f.outbox(e).isEmpty()); assertTrue(f.items(e).isEmpty())
        val snapshot = e.snapshot(); e.close(); f.engine(snapshot).use { reopened -> f.migrate(reopened); assertEquals(1, f.outbox(reopened).size) }
    }
    @Test fun aLostPushReplyRetainsOneSentIntentAndTheOriginalWorkoutForAnExactRetry() {
        val f = fixture(); f.log.hold(f.row()); val e = f.engine(); f.migrate(e); e.signIn("A", emptyMap()); val request = e.nextPush()!!
        val original = request.member("intents").arr().single(); val snapshot = e.snapshot(); e.close()
        f.engine(snapshot).use { reopened -> reopened.start(); val retry = reopened.nextPush()!!
            assertEquals(original, retry.member("intents").arr().single()); assertEquals(1, f.outbox(reopened).size)
            assertEquals(f.row().session, EngineTraining(reopened) { null }.details().single().session) }
    }
}
