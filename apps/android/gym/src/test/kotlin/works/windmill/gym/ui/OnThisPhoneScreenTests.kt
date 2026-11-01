package works.windmill.gym.ui

import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.presentation.*
import works.windmill.gym.store.*
import works.windmill.platform.design.WindmillMaterial
import works.windmill.platform.Account
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class OnThisPhoneScreenTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()
    private val events = mutableListOf<Map<String, String>>()
    private val failures = mutableListOf<String>()
    private val telemetry = object : Telemetry {
        override fun event(name: String, properties: Map<String, String>) { if (name == "gym_import_recovery") events += properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
            assertEquals(emptyMap<String, String>(), properties); failures += operation
        }
    }
    private fun phone(scope: CoroutineScope): EngineRoomFixture = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry).also { room ->
        runBlocking {
            room.select(null)
            val start = room.now + 100_000
            room.training.imports.prepare(SavedWorkout(Session("session01", start, start + 90_000, plan = null),
                listOf(TrainingSet("set00001", "bench-press", weightKg = 80.0, reps = 5, completedAtMs = start + 1_000))))
            room.select("A"); room.pull(EngineRoomFixture.server()); room.store.refreshEngine()
        }
    }
    private fun inspect(room: EngineRoomFixture, fixes: Boolean = false) {
        compose.setContent { WindmillMaterial { GymMaterial {
            CompositionLocalProvider(LocalTelemetry provides telemetry) {
                val read = room.store.recovery
                read?.workouts?.firstOrNull()?.let { row -> WorkoutInspectScreen(room.store, read, row, {}, { read.belongsTo(room.account()) }) }
                if (fixes) WorkoutFixScreen(room.store) { room.store.recoveryDraft?.read?.belongsTo(room.account()) == true }
            }
        } } }
    }

    @Test fun inspectCountsEverySetOffersOnePrimaryAndCancelNeverDeletesTheCopy() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        try { phone(scope).use { room ->
            val original = room.training.imports.retainedWorkouts().single()
            inspect(room)
            compose.onNodeWithText("Sets").assertIsDisplayed()
            compose.onAllNodesWithText("1").assertCountEquals(2)
            compose.onAllNodesWithText("Fix workout").assertCountEquals(1)
            compose.onNodeWithText("Choose set kind").assertDoesNotExist()
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Discard workout").performClick()
            compose.onNodeWithText("This deletes the workout and its 1 set. You can’t undo this.").assertIsDisplayed()
            compose.onNodeWithText("Cancel").performClick()
            compose.runOnIdle {
                assertEquals(original, room.training.imports.retainedWorkouts().single())
                assertTrue(room.outbox().isEmpty())
                assertEquals(listOf(mapOf("action" to "inspect", "state" to "opened"), mapOf("action" to "discard", "state" to "shown"),
                    mapOf("action" to "discard", "outcome" to "cancelled")), events)
            }
        } } finally { scope.cancel() }
    }

    @Test fun failedDiscardReportsAndKeepsTheExactCopyForAnExplicitSecondAttempt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        try { phone(scope).use { room ->
            val original = room.training.imports.retainedWorkouts().single()
            inspect(room)
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Discard workout").performClick()
            compose.runOnIdle { room.engine.failNextCommit() }
            compose.onNodeWithText("Discard", substring = false).performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { failures.isNotEmpty() } }
            compose.onNodeWithText("The original workout is still saved on this phone. Discard workout could not be completed.").assertIsDisplayed()
            compose.runOnIdle { assertEquals(original, room.training.imports.retainedWorkouts().single()) }
            compose.onNodeWithContentDescription("More").performClick()
            compose.onNodeWithText("Discard workout").performClick()
            compose.onNodeWithText("Discard", substring = false).performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { room.training.imports.refusals().isEmpty() } }
            compose.runOnIdle {
                assertEquals(listOf("gym_import_discard"), failures)
                assertEquals(listOf("failed", "ok"), events.mapNotNull { it["outcome"] })
                assertTrue(room.outbox().isEmpty())
            }
        } } finally { scope.cancel() }
    }

    @Test fun fixingStagesTheWholeCopyUntilOneSaveAndRetry() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        try { phone(scope).use { room ->
            val original = room.training.imports.retainedWorkouts().single()
            inspect(room, fixes = true)
            compose.onNodeWithText("Fix workout").performClick()
            compose.onNodeWithText("Save and retry").assertIsNotEnabled()
            compose.runOnIdle {
                val opening = requireNotNull(room.store.recoveryDraft)
                val set = opening.copy.sets.single()
                room.store.changeRecoveryFix(opening, opening.copy.copy(
                    session = opening.copy.session.copy(startedAtMs = room.now - 90_000, finishedAtMs = room.now - 1_000),
                    sets = listOf(set.copy(weightKg = 81.25, completedAtMs = room.now - 60_000))))
                assertEquals(original, room.training.imports.retainedWorkouts().single())
                assertTrue(room.outbox().isEmpty())
            }
            compose.waitUntil(10_000) { compose.runOnIdle { !room.store.recoveryBusy } }
            compose.onNodeWithText("Save and retry").assertIsEnabled().performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { room.store.recoveryDraft == null } }
            compose.runOnIdle {
                assertEquals(1, room.outbox().size)
                val command = room.outbox().single().member("intent").member("cmd")
                assertEquals("gym.importSession", command.member("name").str())
                assertEquals("session01", command.member("args").member("id").str())
                assertEquals("set00001", command.member("args").member("sets").arr().single().member("id").str())
                assertEquals(81.25, room.training.imports.retainedWorkouts().single().sets.single().weightKg, 0.0)
                assertEquals(listOf("completed"), events.mapNotNull { it["outcome"] })
                assertTrue(failures.isEmpty())
            }
        } } finally { scope.cancel() }
    }

    @Test fun listSeparatesWaitingAndAddingAndCountsOnlyTheWorkoutsNeedingYou() {
        val copy = SavedWorkout(Session("session01", 1_000, 91_000, plan = PlanSnapshot("Push A", emptyList())),
            listOf(TrainingSet("set00001", "bench-press", weightKg = 80.0, reps = 5, completedAtMs = 2_000)))
        val waiting = ImportRecovery("session01", copy, listOf(ImportRefusal("session01", copy.session, copy.sets, emptyList(), "session-overlap", "unused")), emptyList())
        val adding = ImportRecovery("session02", copy.copy(session = copy.session.copy(id = "session02", plan = PlanSnapshot("Legs", emptyList()))), emptyList(), emptyList())
        val read = RecoveryRead("https://test.invalid", "A", 1, "replica", listOf(waiting, adding))
        val opened = mutableListOf<String>()
        compose.setContent { WindmillMaterial { GymMaterial { OnThisPhoneScreen(read, {}, opened::add) } } }
        compose.onNodeWithText("Needs you").assertIsDisplayed()
        compose.onNodeWithText("Adding").assertIsDisplayed()
        compose.onNodeWithText("Overlaps another workout — fix its times.").assertIsDisplayed().performClick()
        compose.onNodeWithText("Adding…").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf("session01"), opened); assertEquals(1, PhoneRecovery.needsYou(read.workouts)) }
    }

    @Test fun unsupportedAndStrandedCopiesNeverAcquireADiscardCountOrGenericRetry() {
        val opaque = ImportRecovery("opaque", null, listOf(ImportRefusal("opaque", null, emptyList(), emptyList(), "source-unreadable", "Update the app.")), emptyList())
        val spent = opaque.copy(refusals = listOf(opaque.refusals.single().copy(code = "id-spent")))
        assertFalse(PhoneRecovery.canDiscard(opaque)); assertNull(PhoneRecovery.primary(opaque))
        assertFalse(PhoneRecovery.canFix(spent)); assertNull(PhoneRecovery.primary(spent))
        val operation = opaque.copy(refusals = listOf(opaque.refusals.single().copy(code = "session-finished", kind = "operation")))
        assertEquals(RecoveryAction.Retry, PhoneRecovery.primary(operation))
        assertFalse(PhoneRecovery.canDiscard(operation)); assertFalse(PhoneRecovery.canFix(operation))
    }

    @Test fun addingOperationInspectKeepsItsReadableRetainedSetCount() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val copy = SavedWorkout(Session("session01", 1_000, plan = PlanSnapshot("Push A", emptyList())),
                listOf(TrainingSet("set00001", "bench-press", weightKg = 80.0, reps = 5, completedAtMs = 2_000)))
            val row = ImportRecovery(copy.session.id, copy, emptyList(), listOf(ImportOpening("set00001", "replica", false, emptyMap())))
            val read = RecoveryRead("https://test.invalid", "A", 0, "replica", listOf(row))
            compose.setContent { WindmillMaterial { GymMaterial { WorkoutInspectScreen(room.store, read, row, {}, { true }) } } }
            compose.onNodeWithText("Sets").assertIsDisplayed()
            compose.onAllNodesWithText("1").assertCountEquals(2)
            compose.onNodeWithText("0").assertDoesNotExist()
            compose.onNodeWithText("Adding…").assertIsDisplayed()
            compose.onNodeWithContentDescription("More").assertDoesNotExist()
            compose.runOnIdle { assertTrue(row.operationsOnly); assertEquals(copy.sets, PhoneRecovery.sets(row)) }
        } } finally { scope.cancel() }
    }

    @Test fun opaqueOperationInspectHasOnlyTheExistingUpdateDestinationAndNoInventedFacts() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val row = ImportRecovery("opaque", null, listOf(ImportRefusal("opaque", null, emptyList(), emptyList(), "source-unreadable", WorkoutImports.reason("source-unreadable"), kind = "operation")), emptyList())
            val read = RecoveryRead("https://test.invalid", "A", 0, "replica", listOf(row))
            compose.setContent { WindmillMaterial { GymMaterial { WorkoutInspectScreen(room.store, read, row, {}, { true }) } } }
            compose.onNodeWithText("Open Windmill").assertIsDisplayed()
            compose.onNodeWithText("Sets").assertDoesNotExist()
            compose.onNodeWithText("0").assertDoesNotExist()
            compose.onNodeWithText("Retry").assertDoesNotExist()
            compose.onNodeWithContentDescription("More").assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    @Test fun logHeadUsesOnlyTheAuthorityFilteredReadAcrossOriginIdentityAndTrustChanges() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        try { phone(scope).use { room ->
            val read = requireNotNull(room.store.recovery)
            val opening = room.account()
            var account by mutableStateOf(opening)
            compose.setContent { WindmillMaterial { GymMaterial { LogScreen(room.store, "A", {}, {}, {}, {},
                recovery = read.takeIf { it.belongsTo(account) }, now = { room.now }) } } }
            compose.onNodeWithText("On this phone").assertIsDisplayed()
            for (changed in listOf(Account("https://other.invalid", opening.user),
                Account(opening.origin, opening.user, identityRevision = opening.identityRevision + 1),
                Account(opening.origin, opening.user, locallyTrusted = false), Account(opening.origin, opening.user, resolved = false))) {
                compose.runOnIdle { account = changed }
                compose.onNodeWithText("On this phone").assertDoesNotExist()
                compose.runOnIdle { assertSame(read, room.store.recovery); account = opening }
                compose.onNodeWithText("On this phone").assertIsDisplayed()
            }
        } } finally { scope.cancel() }
    }

    private fun opaqueOperation(id: String) = ImportRecovery(id, null,
        listOf(ImportRefusal(id, null, emptyList(), emptyList(), "source-unreadable", WorkoutImports.reason("source-unreadable"), kind = "operation")),
        listOf(ImportOpening(id, "replica", false, mapOf(id to "{\"source\":{\"sessionId\":null}}"))))

    @Test fun aggregateOmitsTheWorkoutCountForHealthyAndOpaqueRowsWithoutHidingEither() {
        val copy = SavedWorkout(Session("session01", 1_000, 91_000, plan = PlanSnapshot("Push A", emptyList())),
            listOf(TrainingSet("set00001", "bench-press", weightKg = 80.0, reps = 5, completedAtMs = 2_000)))
        val healthy = ImportRecovery(copy.session.id, copy, listOf(ImportRefusal(copy.session.id, copy.session, copy.sets, emptyList(), "session-overlap", "unused")), emptyList())
        val opaque = opaqueOperation("opaque01")
        val read = RecoveryRead("https://test.invalid", "A", 0, "replica", listOf(healthy, opaque))
        var list by mutableStateOf(false)
        val opened = mutableListOf<String>()
        compose.setContent { WindmillMaterial { GymMaterial {
            if (list) OnThisPhoneScreen(read, { list = false }, opened::add)
            else OnThisPhoneSection(read, { list = true }, opened::add)
        } } }
        compose.onNodeWithText("Saved training").assertIsDisplayed()
        compose.onNodeWithText("Needs you").assertIsDisplayed()
        compose.onNodeWithText("2 workouts").assertDoesNotExist()
        compose.onNodeWithText("2 need you").assertDoesNotExist()
        compose.onNodeWithText("Saved training").performClick()
        compose.onNodeWithText("Push A", substring = true).assertIsDisplayed().performClick()
        compose.onNodeWithText("Saved training").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf(healthy.id, opaque.id), opened) }
    }

    @Test fun twoOpaqueOperationsWithTheSameUnknownParentNeverBecomeTwoWorkouts() {
        val rows = listOf(opaqueOperation("opaque01"), opaqueOperation("opaque02"))
        val read = RecoveryRead("https://test.invalid", "A", 0, "replica", rows)
        var list by mutableStateOf(false)
        val opened = mutableListOf<String>()
        compose.setContent { WindmillMaterial { GymMaterial {
            if (list) OnThisPhoneScreen(read, { list = false }, opened::add)
            else OnThisPhoneSection(read, { list = true }, opened::add)
        } } }
        compose.onNodeWithText("Saved training").assertIsDisplayed()
        compose.onNodeWithText("Needs you").assertIsDisplayed()
        compose.onNodeWithText("2 workouts").assertDoesNotExist()
        compose.onNodeWithText("2 need you").assertDoesNotExist()
        compose.onNodeWithText("Saved training").performClick()
        compose.onAllNodesWithText("Saved training").assertCountEquals(2)
        compose.onAllNodesWithText("Saved training")[0].performClick()
        compose.onAllNodesWithText("Saved training")[1].performClick()
        compose.runOnIdle { assertEquals(rows.map { it.id }, opened) }
    }

    @Test fun signInCountsNameOnlyTheApprovedKindsInOrder() {
        val copy = PhoneSignInCopy(mapOf("gym" to mapOf("session" to 2, "set" to 99, "routine" to 1, "weighin" to 1,
            "prefs" to 1, "exerciseName" to 2, "pending" to 8)))
        assertEquals("2 workouts, 1 routine and 1 weigh-in", copy.phrase)
        assertEquals("Discard all of it?", copy.discardTitle)
        assertEquals("2 workouts, 1 routine and 1 weigh-in are deleted from this phone. You can’t undo this.", copy.discardBody)
        val one = PhoneSignInCopy(mapOf("gym" to mapOf("session" to 1, "set" to 20)))
        assertEquals("This phone has 1 workout from before you signed in. Your account already has training. Add it, or discard it from this phone.", one.question)
        assertEquals("It is deleted from this phone. You can’t undo this.", one.discardBody)
    }
}
