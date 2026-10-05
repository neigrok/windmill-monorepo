package works.windmill.gym.store

import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*
import works.windmill.sync.core.Json
import works.windmill.sync.engine.EngineCrash
import works.windmill.sync.engine.signIn

class LocalClaimConsentTests {
    @get:Rule val tmp = TemporaryFolder()
    private fun batch() = ClaimBatch("batch", listOf(ClaimItem(ClaimSource.Anonymous, ClaimKind.Queue, "session01", "a".repeat(64), "{\"sets\":[\"set00001\"]}", 123, true)))

    @Test fun theExactSignInSnapshotAndOwnerSurviveFreshInstances() {
        val approved = ClaimConsent.Approved(batch(), "A", "flow1"); legacyConsent(tmp.root, approved)
        val file = File(tmp.root, LocalClaimConsent.fileName); val original = file.readText()
        val decoded = LocalClaimConsent(file).state as ClaimConsent.Approved
        assertEquals(batch(), decoded.resumeFor("A")); assertNull(decoded.resumeFor("B")); assertEquals(approved, LocalClaimConsent(file).state)
        assertEquals(original, file.readText())
    }
    @Test fun callersCannotMutateTheArchivedSnapshotThroughARead() {
        legacyConsent(tmp.root, ClaimConsent.Approved(batch(), "A")); val file = File(tmp.root, LocalClaimConsent.fileName); val store = LocalClaimConsent(file)
        val returned = store.state as ClaimConsent.Approved; (returned.batch.items as MutableList<ClaimItem>).clear()
        assertEquals(ClaimConsent.Approved(batch(), "A"), store.state); assertEquals(store.state, LocalClaimConsent(file).state)
    }
    @Test fun anInterruptedTemporaryWriteCannotReplaceApprovalOrResurrectCompletedWork() {
        val file = File(tmp.root, LocalClaimConsent.fileName); legacyConsent(tmp.root, ClaimConsent.Approved(batch(), "A"))
        File(tmp.root, "${LocalClaimConsent.fileName}.tmp").writeText("{\"version\":1,\"consent\":")
        assertEquals(ClaimConsent.Approved(batch(), "A"), LocalClaimConsent(file).state)
        legacyConsent(tmp.root, null); assertNull(LocalClaimConsent(file).state)
    }
    @Test fun anAwaitingSignInDecisionDoesNotApproveOrBindAnyAccountDuringMigration() {
        val f = LegacyEngineFixture(tmp.root); f.log.hold(f.row()); val frozen = ClaimBatch("batch", f.log.claimItems())
        legacyConsent(tmp.root, ClaimConsent.AwaitingSignIn(frozen, "flow1"))
        f.engine().use { e -> f.migrate(e); assertTrue(e.read(LegacyGymMigration.scope) { it.isAnonymous })
            assertEquals(frozen, LocalClaimConsent(File(tmp.root, LocalClaimConsent.fileName)).state!!.batch)
            assertEquals(Json.Null, e.snapshot().member("replicas").arr().single().member("meta")["account"] ?: Json.Null) }
    }
    @Test fun aCrashAfterDurableMigrationResumesOnlyThePersistedApprovedOwner() {
        val f = LegacyEngineFixture(tmp.root); f.log.hold(f.row()); legacyConsent(tmp.root, ClaimConsent.Approved(ClaimBatch("batch", f.log.claimItems()), "A"))
        val e = f.engine(); e.crashAfterTransactions(1); assertThrows(EngineCrash::class.java) { f.migrate(e) }; val snapshot = e.snapshot(); e.close()
        f.engine(snapshot).use { reopened -> f.migrate(reopened); reopened.signIn("A", emptyMap())
            assertTrue(f.outbox(reopened).isEmpty()); assertEquals(listOf(f.row()), LegacyGymMigration.pendingFinished(reopened))
            assertEquals("u.A", f.items(reopened).first { it["kind"] == Json.of("finished") }.member("seat").str()) }
    }
    @Test fun aFrozenDiscardPreservesTrainingEditedAfterTheOriginalDecision() {
        val f = LegacyEngineFixture(tmp.root); val log = f.log; log.hold(Exercise("exercise1", "Before", custom = true))
        legacyConsent(tmp.root, ClaimConsent.Discarding(ClaimBatch("discard", log.claimItems()))); log.renameExercise("exercise1", "After")
        f.engine().use { e -> f.migrate(e); assertEquals("After", EngineTraining(e) { null }.catalogue().first { it.id == "exercise1" }.name); assertEquals(1, f.outbox(e).size) }
    }
    @Test fun corruptUnknownAndIncompleteDocumentsFailClosedWithoutBeingOverwritten() {
        val file = File(tmp.root, LocalClaimConsent.fileName)
        listOf("{", "{}", """{"version":2,"consent":null}""", """{"version":1,"version":2,"consent":null}""", """{"version":1,"consent":{"type":"approved"}}""",
            """{"version":1,"consent":null,"unexpected":true}""").forEach { text ->
            file.writeText(text); assertThrows(Exception::class.java) { LocalClaimConsent(file) }; assertEquals(text, file.readText())
        }
        file.delete(); assertNull(LocalClaimConsent(file).state); assertFalse(file.exists())
    }
    @Test fun aNewBuildNeverWritesOrManufacturesALegacyConsentFile() {
        val f = LegacyEngineFixture(tmp.root); f.log.hold(f.row()); val file = File(tmp.root, LocalClaimConsent.fileName)
        assertNull(LocalClaimConsent(file).state)
        f.engine().use { e -> f.migrate(e); assertFalse(file.exists()); assertEquals(1, f.outbox(e).size) }
    }
}
