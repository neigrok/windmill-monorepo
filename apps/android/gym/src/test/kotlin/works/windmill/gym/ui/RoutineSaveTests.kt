package works.windmill.gym.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.GymRoom
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.SetTarget
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import works.windmill.platform.telemetry.Telemetry
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.StandardTestDispatcher
import works.windmill.gym.store.*

@OptIn(androidx.compose.ui.test.ExperimentalTestApi::class, kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RoutineSaveTests {
    private val scheduler = TestCoroutineScheduler()
    private val admission = StandardTestDispatcher(scheduler)
    @get:Rule val compose = createComposeRule(effectContext = admission)
    @get:Rule val tmp = TemporaryFolder()

    private fun save(refused: Boolean) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val entries = listOf(RoutineEntry(1, "bench-press"), RoutineEntry(2, "back-squat"))
            val server = EngineRoomFixture.server()
            EngineRoomFixture(tmp.newFolder(), scope).use { other -> runBlocking {
                other.select("a"); other.pull(server)
                assertTrue(other.store.saveRoutine(RoutineDraft(name = "Push", entries = entries, creationId = "routine_push").capturingMovements(other.store.catalog)) is GymResult.Ok)
                other.sync(server)
            } }
            runBlocking { room.select("a"); room.pull(server); room.store.refreshEngine() }
            val original = room.training.program().single()
            // The room comes down before the engine closes: its lifecycle watcher writes on pause.
            val visible = mutableStateOf(true)
            compose.setContent { if (visible.value) GymMaterial { GymRoom(room.account(), room.store) } }
            try {
                compose.onNodeWithText("Push").performClick()
                compose.onNodeWithText("Edit routine").performClick()
                compose.onNodeWithContentDescription("Routine name").performTextReplacement("Saved push")
                // Another phone moves the routine on while this draft stays open over the revision it read.
                val moved = if (!refused) null else EngineRoomFixture(tmp.newFolder(), scope).use { other -> runBlocking {
                    other.select("a"); other.pull(server)
                    val draft = RoutineDraft.of(other.training.program().single()).named("Push elsewhere")
                    assertTrue(other.store.saveRoutine(draft) is GymResult.Ok)
                    other.sync(server)
                    room.pull(server); room.store.refreshEngine()
                    room.training.program().single()
                } }
                compose.onNodeWithText("Save").performClick()
                compose.waitForIdle()
                if (refused) {
                    compose.onNodeWithContentDescription("Routine name").assertIsEnabled().assertTextEquals("Saved push")
                    compose.onNodeWithText("Save").assertIsEnabled()
                    // The room's line is a polite live region, so TalkBack says what the eye reads.
                    compose.onNodeWithText("That changed. Open it again.").assertIsDisplayed()
                        .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
                    compose.onNodeWithContentDescription("Routine name").performTextReplacement("Retry push")
                    compose.onNodeWithContentDescription("Routine name").assertTextEquals("Retry push")
                    assertEquals(Routine("routine_push", "Push elsewhere", entries = entries, revision = 2), moved)
                    assertEquals("the refused draft never reached the replica", moved, room.training.program().single())
                } else {
                    compose.onNodeWithContentDescription("Routine name").assertDoesNotExist()
                    compose.onAllNodesWithText("Saved push").assertCountEquals(2)
                    compose.onNode(hasText("Saved push") and hasAnyAncestor(hasTestTag("routine-sheet"))).assertIsDisplayed()
                    compose.runOnIdle { room.sync(server) }
                    assertEquals(original.copy(name = "Saved push", revision = 2), room.training.program().single())
                }
            } finally { compose.runOnIdle { visible.value = false }; compose.waitForIdle() }
        } } finally { scope.cancel() }
    }

    @Test fun aSavedDraftLandsOnTheLogAndTheSheetReadsIt() = save(refused = false)
    @Test fun aRefusedSaveKeepsTheSameRecoverableDraft() = save(refused = true)
    @Test fun aQueuedOldOwnerSaveCannotWriteIntoTheNewOwnerOrCloseItsDraft() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { error("unexpected $operation") }
        }
        try { EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry, readDispatcher = Dispatchers.Unconfined).use { room ->
            runBlocking {
                room.select("first")
                room.training.createRoutine(works.windmill.gym.domain.RoutineWrite("routine_first", "First push", 0,
                    listOf(works.windmill.gym.domain.RoutineEntryWrite("bench-press"))))
                room.store.refreshEngine()
            }
            val account = mutableStateOf(room.account())
            val visible = mutableStateOf(true)
            compose.setContent { if (visible.value) GymMaterial { GymRoom(account.value, room.store) } }
            try {
                compose.onNodeWithText("First push").performClick()
                compose.onNodeWithText("Edit routine").performClick()
                compose.onNodeWithContentDescription("Routine name").performTextReplacement("First edited")
                val submit = compose.onNodeWithText("Save").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
                events.clear()
                compose.runOnIdle {
                    submit()
                    assertEquals(listOf("First push"), room.training.program().map { it.name })
                    runBlocking { room.select("second") }
                    account.value = room.account()
                }
                compose.waitForIdle()
                assertEquals(emptyList<Routine>(), room.training.program())
                assertEquals(emptyList<Pair<String, Map<String, String>>>(), events.filter { it.first == "gym_routine_saved" })
                compose.onNodeWithContentDescription("New routine").performClick()
                compose.onNodeWithContentDescription("Routine name").performTextReplacement("Second draft")
                compose.onNodeWithText("Add movement").performClick()
                compose.onNodeWithText("Bench Press").performClick()
                compose.onNodeWithText("Add").performClick()
                compose.onNodeWithContentDescription("Routine name").assertTextEquals("Second draft")
                compose.onNodeWithText("Save").assertIsEnabled().performClick()
                compose.waitForIdle()
                assertEquals(listOf("Second draft"), room.training.program().map { it.name })
                assertEquals(listOf("gym_routine_saved" to mapOf("action" to "create")), events.filter { it.first == "gym_routine_saved" })
            } finally { compose.runOnIdle { visible.value = false }; compose.waitForIdle() }
            runBlocking { room.select("first") }
            assertEquals(listOf("First push"), room.training.program().map { it.name })
        } } finally { scope.cancel() }
    }

    @Test fun aQueuedSaveWithANewIdentityRevisionReleasesBusyWithoutClosingTheDraft() = identityChanged(false)
    @Test fun aCoalescedOwnerSwitchCannotReuseTheOriginalQueuedSave() = identityChanged(true)

    private fun identityChanged(coalescedSwitch: Boolean) {
        // Hold only caller admission while Compose renders the new identity; no store write has begun.
        val saveScheduler = TestCoroutineScheduler()
        val saveAdmission = StandardTestDispatcher(saveScheduler)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope, readDispatcher = Dispatchers.Unconfined).use { room ->
            runBlocking {
                room.select("first")
                room.training.createRoutine(works.windmill.gym.domain.RoutineWrite("routine_identity", "Opening", 0,
                    listOf(works.windmill.gym.domain.RoutineEntryWrite("bench-press"))))
                room.store.refreshEngine()
            }
            val account = mutableStateOf(room.account())
            val visible = mutableStateOf(true)
            compose.setContent { if (visible.value) GymMaterial { GymRoom(account.value, room.store, routineSaveContext = saveAdmission) } }
            try {
                compose.onNodeWithText("Opening").performClick()
                compose.onNodeWithText("Edit routine").performClick()
                compose.onNodeWithContentDescription("Routine name").performTextReplacement("Retained edit")
                val submit = compose.onNodeWithText("Save").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
                val opening = room.engine.snapshot()
                compose.runOnIdle {
                    submit()
                    if (coalescedSwitch) account.value = works.windmill.platform.Account(account.value.origin,
                        room.account("second").user, identityRevision = 1)
                    account.value = works.windmill.platform.Account(account.value.origin, room.account("first").user,
                        identityRevision = if (coalescedSwitch) 2 else 1)
                }
                compose.waitForIdle()
                compose.onNodeWithText("Saving…").assertIsNotEnabled()
                compose.runOnIdle { saveScheduler.runCurrent() }
                compose.waitForIdle()
                assertEquals(opening, room.engine.snapshot())
                compose.onNodeWithContentDescription("Routine name").assertTextEquals("Retained edit").assertIsEnabled()
                compose.onNodeWithText("Save").assertIsEnabled().performClick()
                compose.runOnIdle { saveScheduler.runCurrent() }
                compose.waitForIdle()
                assertEquals(listOf("Retained edit"), room.training.program().map { it.name })
                compose.onNodeWithContentDescription("Routine name").assertDoesNotExist()
            } finally { compose.runOnIdle { visible.value = false }; compose.waitForIdle() }
        } } finally { scope.cancel() }
    }

}
