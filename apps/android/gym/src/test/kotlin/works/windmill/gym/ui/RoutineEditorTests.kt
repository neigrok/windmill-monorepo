package works.windmill.gym.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.StateRestorationTester
import works.windmill.gym.GymRoom
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import androidx.compose.ui.geometry.Offset
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.*
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.EngineRoomFixture

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RoutineEditorTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    // A store never connected, so its catalog is empty and every row reads the movement's id.
    private fun editor(room: EngineRoomFixture, opening: RoutineDraft): () -> RoutineDraft {
        var draft by mutableStateOf(opening)
        compose.setContent {
            RoutineBuilder(
                draft = draft,
                store = room.store,
                saving = false,
                onDraft = { draft = it },
                onSave = {},
                onClose = {},
                say = {},
                backTo = "Routines",
            )
        }
        return { draft }
    }

    private fun actionsOn(movement: String): List<CustomAccessibilityAction> {
        val row = compose.onNodeWithText(movement).fetchSemanticsNode()
        return generateSequence(row) { it.parent }.toList().asReversed()
            .flatMap { if (it.config.contains(SemanticsActions.CustomActions)) it.config[SemanticsActions.CustomActions] else emptyList() }
    }

    private fun handle(name: String) = compose.onNodeWithContentDescription(name, useUnmergedTree = true)

    @Test fun aNewRoutineHasNoHistory() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking { room.select(null) }
            val before = room.engine.snapshot()
            editor(room, RoutineDraft(name = "New"))
            compose.onNodeWithText("History").assertDoesNotExist()
            compose.onNodeWithTag("routine-history").assertDoesNotExist()
            assertEquals(before, room.engine.snapshot())
        } } finally { scope.cancel() }
    }

    @Test fun finishedHistoryShowsExactFactsWithoutChangingTheOuterDraft() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking {
                room.select(null)
                val plan = RoutineDraft(name = "Pull", creationId = "routine_history").adding("bench-press")
                    .capturingMovements(room.store.catalog)
                assertTrue(room.store.saveRoutine(plan) is GymResult.Ok)
                room.training.startSession(SessionStart("history_finished", room.now - 1_000, routineId = "routine_history"))
                room.training.appendSet("history_finished", SetWrite("history_set_1", "bench-press", 50.0, 8, room.now - 900))
                room.training.appendSet("history_finished", SetWrite("history_set_2", "barbell-row", 40.0, 10, room.now - 800))
                room.training.finishSession("history_finished", room.now - 100)
            }
            val opening = RoutineDraft.of(requireNotNull(room.store.routine("routine_history")), room.store.catalog).named("Retained draft")
            val before = room.engine.snapshot()
            val draft = editor(room, opening)
            compose.waitUntil(10_000) { compose.onAllNodesWithTag("routine-history-row").fetchSemanticsNodes().size == 1 }
            compose.onNodeWithText("History").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("2 sets · 2 movements").performScrollTo().assertIsDisplayed()
            compose.onNodeWithTag("routine-history-row").assertHasNoClickAction()
            val date = java.time.format.DateTimeFormatter.ofPattern("EEE, MMM d", java.util.Locale.getDefault())
                .format(java.time.Instant.ofEpochMilli(room.now - 1_000).atZone(java.time.ZoneId.systemDefault()))
            compose.onNodeWithText(date).assertExists()
            assertEquals(opening, draft())
            assertEquals(before, room.engine.snapshot())
        } } finally { scope.cancel() }
    }

    @Test
    fun testAMovementRowOffersRemoveAsACustomActionAndNotOnlyAsASwipe() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat"))

            val steps = actionsOn("bench-press")
            assertEquals(listOf("Remove movement", "Move down"), steps.map { it.label })

            compose.runOnIdle { steps.first { it.label == "Remove movement" }.action() }
            compose.runOnIdle {
                assertEquals("and it removes the same line the swipe would",
                    listOf("squat"), draft().entries.map { it.exerciseId })
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun testAFreshEditorOpensWithTheNameFieldFocused() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, RoutineDraft())
            compose.waitForIdle()
            compose.onNodeWithContentDescription("Routine name").assertIsFocused()
        } } finally { scope.cancel() }
    }

    @Test
    fun testTheNameCounterIsSilentUntilTheLastFifth() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, RoutineDraft(name = "Push Day"))

            compose.onNodeWithText("7/60").assertDoesNotExist()
            assertEquals(48, Program.counterFrom)

            compose.onNodeWithContentDescription("Routine name").performTextReplacement("a".repeat(47))
            compose.onNodeWithText("47/60").assertDoesNotExist()

            compose.onNodeWithContentDescription("Routine name").performTextReplacement("a".repeat(53))
            compose.onNodeWithText("53/60").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun testFreshBlankDraftIsQuietAndANamedEmptyDraftExplainsItsMissingMovement() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, RoutineDraft())

            compose.onNodeWithText("Name it to save it.").assertDoesNotExist()
            compose.onNodeWithText("A routine is at least one movement.").assertDoesNotExist()

            compose.onNodeWithContentDescription("Routine name").performTextReplacement("Push Day")
            compose.onNodeWithText("Name it to save it.").assertDoesNotExist()
            compose.onNodeWithText("A routine is at least one movement.").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun testTheEditorAndCombinedFormKeepOpenTargetsWithoutExtraHints() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            runBlocking { room.select(null) }
            editor(room, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat")
                .targeting("squat", List(3) { SetTarget(5, 60.0) }))

            compose.onNodeWithText("open").assertIsDisplayed()
            compose.onNodeWithText("You decide the numbers at the rack.").assertDoesNotExist()

            compose.onNodeWithText("Bench Press").performClick()
            compose.onNodeWithText("You decide the numbers at the rack.").assertDoesNotExist()
            compose.onNodeWithContentDescription("Movement name").assertExists()
            compose.onNodeWithContentDescription("Equipment").assertExists()
            compose.onNodeWithText("Done").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun testARoutineWhoseEveryLineNamesItsNumbersSaysNothingAboutTheRack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, RoutineDraft(name = "Push Day").adding("bench-press")
                .targeting("bench-press", List(3) { SetTarget(5, 60.0) }))

            compose.onNodeWithText("You decide the numbers at the rack.").assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    @Test
    fun testASavableDraftSaysNothingAtAll() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, RoutineDraft(name = "Push Day").adding("bench-press"))

            compose.onNodeWithText("Name it to save it.").assertDoesNotExist()
            compose.onNodeWithText("A routine is at least one movement.").assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    @Test
    fun testLongPressDragReordersAndRenumbersTheWholeDraft() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat").adding("row"))
            val start = handle("Move bench-press, 1 of 3").fetchSemanticsNode().boundsInRoot.center
            val end = handle("Move row, 3 of 3").fetchSemanticsNode().boundsInRoot.center
            handle("Move bench-press, 1 of 3").performTouchInput {
                down(center)
            }
            compose.mainClock.advanceTimeBy(650)
            handle("Move bench-press, 1 of 3").performTouchInput {
                moveBy(Offset(0f, end.y - start.y), delayMillis = 300)
                up()
            }
            compose.runOnIdle {
                assertEquals(listOf("squat", "row", "bench-press"), draft().entries.map { it.exerciseId })
                assertEquals(listOf(1, 2, 3), draft().entries.map { it.position })
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun testMoveActionsBelongToTheirRowAndDoNotWrapAtEitherEnd() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat").adding("row"))
            assertEquals(listOf("Remove movement", "Move down"), actionsOn("bench-press").map { it.label })
            assertEquals(listOf("Remove movement", "Move up", "Move down"), actionsOn("squat").map { it.label })
            assertEquals(listOf("Remove movement", "Move up"), actionsOn("row").map { it.label })
            compose.runOnIdle { actionsOn("row").first { it.label == "Move up" }.action() }
            compose.runOnIdle { assertEquals(listOf("bench-press", "row", "squat"), draft().entries.map { it.exerciseId }) }
            compose.onNodeWithText("row, 2 of 3").assertIsDisplayed()
            compose.runOnIdle { actionsOn("bench-press").first { it.label == "Move down" }.action() }
            compose.runOnIdle { assertEquals(listOf("row", "bench-press", "squat"), draft().entries.map { it.exerciseId }) }
            compose.onNodeWithText("bench-press, 2 of 3").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun testSwipeRemovesAnAddedMovementAndRenumbersTheRemainingRows() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat").adding("row"))
            compose.onNodeWithText("squat").performTouchInput { swipeLeft() }
            compose.waitForIdle()
            compose.runOnIdle {
                assertEquals(listOf("bench-press", "row"), draft().entries.map { it.exerciseId })
                assertEquals(listOf(1, 2), draft().entries.map { it.position })
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun testTheMoveIsSaidOnOneStablePoliteLiveRegion() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, RoutineDraft(name = "Push Day").adding("bench-press").adding("squat"))
            val lines = compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
            lines.assertCountEquals(1)
            val standing = lines.fetchSemanticsNodes().single()
            assertEquals("", standing.config[SemanticsProperties.Text].joinToString { it.text })
            compose.runOnIdle { actionsOn("squat").first { it.label == "Move up" }.action() }
            val said = lines.fetchSemanticsNodes().single()
            assertEquals("squat, 1 of 2", said.config[SemanticsProperties.Text].joinToString { it.text })
            assertEquals(standing.id, said.id)
        } } finally { scope.cancel() }
    }
    @Test
    fun testHoldingTheGripAtTheViewportEdgeScrollsBeyondInitiallyVisibleRows() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val initial = (1..20).fold(RoutineDraft(name = "Long day")) { draft, id -> draft.adding("movement-$id") }
            val draft = editor(room, initial)
            val body = compose.onNodeWithTag("routine-editor-body").fetchSemanticsNode().boundsInRoot
            val grip = handle("Move movement-1, 1 of 20").fetchSemanticsNode().boundsInRoot
            compose.mainClock.autoAdvance = false
            handle("Move movement-1, 1 of 20").performTouchInput { down(center) }
            compose.mainClock.advanceTimeBy(650)
            handle("Move movement-1, 1 of 20").performTouchInput {
                moveBy(Offset(0f, body.bottom - 12f - grip.center.y), delayMillis = 300)
            }
            compose.mainClock.advanceTimeBy(4_000)
            compose.onRoot().performTouchInput { up() }
            compose.mainClock.autoAdvance = true
            compose.waitForIdle()
            assertTrue("the first movement reaches rows that started below the viewport", draft().entries.indexOfFirst { it.exerciseId == "movement-1" } >= 12)
            assertEquals((1..20).toList(), draft().entries.map { it.position })
            assertEquals(initial.entries.map { it.exerciseId }.toSet(), draft().entries.map { it.exerciseId }.toSet())
        } } finally { scope.cancel() }
    }

    // A signed-out room on Routines, holding `saved` when given, with its routine_editor actions recorded. `back`
    // is the system Back; `recreate` saves and restores the room's whole state.
    private fun room(saved: RoutineDraft? = null,
                     test: (back: () -> Unit, recreate: () -> Unit, actions: List<Map<String, String>>) -> Unit) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val actions = mutableListOf<Map<String, String>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_action" && properties["screen"] == "routine_editor") actions += properties
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        lateinit var activity: ComponentActivity
        var showing by mutableStateOf(true)
        val room = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry)
        try {
            runBlocking {
                room.select(null)
                saved?.let { assertTrue(room.store.saveRoutine(it.capturingMovements(room.store.catalog)) is GymResult.Ok) }
            }
            room.store.observeEngine()
            actions.clear()
            val restorer = StateRestorationTester(compose)
            restorer.setContent {
                activity = LocalActivity.current as ComponentActivity
                if (showing) CompositionLocalProvider(LocalTelemetry provides telemetry) {
                    GymMaterial { GymRoom(room.account(), room.store) }
                }
            }
            test({ compose.runOnIdle { activity.onBackPressedDispatcher.onBackPressed() } },
                restorer::emulateSavedInstanceStateRestore, actions)
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }

    private fun editorTitle(title: String) = compose.onNode(hasText(title) and isHeading())

    private fun typedName() = compose.onNodeWithContentDescription("Routine name").fetchSemanticsNode()
        .config[SemanticsProperties.EditableText].text

    @Test fun backOnADirtyNewRoutineAsksAndDiscardLeaves() = room { back, _, actions ->
        compose.onNodeWithContentDescription("New routine").performClick()
        compose.onNodeWithContentDescription("Routine name").performTextInput("Push Day")
        back()
        compose.onNodeWithText("Discard routine changes?").assertIsDisplayed()
        compose.onNodeWithText("Push Day won’t be saved.").assertIsDisplayed()
        editorTitle("New routine").assertExists()
        compose.onNodeWithText("Discard").performClick()
        editorTitle("New routine").assertDoesNotExist()
        compose.onNodeWithText("Discard routine changes?").assertDoesNotExist()
        compose.onNodeWithContentDescription("New routine").assertIsDisplayed()
        assertEquals(listOf(
            mapOf("screen" to "routine_editor", "action" to "discard", "state" to "shown"),
            mapOf("screen" to "routine_editor", "action" to "discard", "outcome" to "ok"),
        ), actions)
    }

    @Test fun keepEditingKeepsEveryFieldAndTheBackArrowAsksTheSame() = room(
        saved = RoutineDraft(name = "Pull", creationId = "routine_pull").adding("bench-press").adding("back-squat"),
    ) { back, _, actions ->
        compose.onNodeWithText("Pull").performClick()
        compose.onNodeWithText("Edit routine").performClick()
        compose.onNodeWithContentDescription("Routine name").performTextReplacement("Pull Day")
        compose.runOnIdle { actionsOn("Bench Press").first { it.label == "Move down" }.action() }
        back()
        compose.onNodeWithText("Pull Day won’t be saved.").assertIsDisplayed()
        compose.onNodeWithText("Keep editing").performClick()
        compose.onNodeWithText("Discard routine changes?").assertDoesNotExist()
        assertEquals("Pull Day", typedName())
        handle("Move Back Squat, 1 of 2").assertExists()
        handle("Move Bench Press, 2 of 2").assertExists()
        compose.onNodeWithContentDescription("Back to Pull").performClick()
        compose.onNodeWithText("Discard routine changes?").assertIsDisplayed()
        compose.onNodeWithText("Keep editing").performClick()
        editorTitle("Edit routine").assertExists()
        assertEquals(listOf("shown", "cancelled", "shown", "cancelled"), actions.map { it["state"] ?: it.getValue("outcome") })
    }

    // Back's description names where it goes: the list a new routine was opened from, the routine an edit came from.
    @Test fun backOnACleanDraftLeavesWithoutAskingAndSaysWhereItGoes() = room(
        saved = RoutineDraft(name = "Pull", creationId = "routine_pull").adding("bench-press"),
    ) { back, _, actions ->
        compose.onNodeWithContentDescription("New routine").performClick()
        editorTitle("New routine").assertExists()
        compose.onNodeWithContentDescription("Back to Routines").assertIsDisplayed()
        back()
        editorTitle("New routine").assertDoesNotExist()
        compose.onNodeWithText("Pull").performClick()
        compose.onNodeWithText("Edit routine").performClick()
        editorTitle("Edit routine").assertExists()
        compose.onNodeWithContentDescription("Back to Pull").assertIsDisplayed()
        back()
        editorTitle("Edit routine").assertDoesNotExist()
        compose.onNodeWithText("Start workout").assertIsDisplayed()
        compose.onNodeWithText("Discard routine changes?").assertDoesNotExist()
        assertEquals(emptyList<Map<String, String>>(), actions)
    }

    @Test fun recreationWhileAskingKeepsTheQuestionAndTheDraft() = room { back, recreate, actions ->
        compose.onNodeWithContentDescription("New routine").performClick()
        compose.onNodeWithContentDescription("Routine name").performTextInput("Push Day")
        back()
        compose.onNodeWithText("Discard routine changes?").assertIsDisplayed()
        recreate()
        compose.onNodeWithText("Discard routine changes?").assertIsDisplayed()
        compose.onNodeWithText("Push Day won’t be saved.").assertIsDisplayed()
        compose.onNodeWithText("Keep editing").performClick()
        editorTitle("New routine").assertExists()
        assertEquals("Push Day", typedName())
        assertEquals(listOf("shown", "cancelled"), actions.map { it["state"] ?: it.getValue("outcome") })
    }
}
