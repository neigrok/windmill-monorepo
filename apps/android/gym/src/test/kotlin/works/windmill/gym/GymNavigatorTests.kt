package works.windmill.gym

import android.provider.Settings
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.saveable.SaverScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import java.time.LocalDate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class GymNavigatorTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var activity: ComponentActivity
    private lateinit var restoration: StateRestorationTester
    private var guarded by mutableStateOf(false)

    @Test
    fun midWorkoutBackHidesTheLoggerAndAPushedScreenOverItPopsOne() {
        val workout = Standing(Tab.Routines, emptyList(), building = false, logger = true)
        assertEquals(BackMeans.HideTheWorkout, workout.means)
        assertEquals(Frame.Workout(Tab.Routines), workout.frame)
        assertEquals(Standing(Tab.Routines, emptyList(), building = false, logger = false), workout.afterBack())
        val notesOverIt = Standing(Tab.Log, listOf(Away.Notes), building = false, logger = true)
        assertEquals(BackMeans.PopOnePushedScreen, notesOverIt.means)
        assertEquals(Frame.Workout(Tab.Log), notesOverIt.afterBack()!!.frame)
    }

    @Test
    fun backIsCancelInTheEditorAndPopsOneScreenElsewhere() {
        val editing = Standing(Tab.Routines, listOf(Away.Notes), building = true, logger = false)
        assertEquals(BackMeans.LeaveTheDraft, editing.means)
        assertEquals(Frame.Draft(Tab.Routines), editing.frame)
        assertEquals(Frame.Pushed(Tab.Routines, Away.Notes, 1, null), editing.afterBack()!!.frame)
        val deep = Standing(Tab.Coach, listOf(Away.Threads, Away.Thread("t1"), Away.Notes, Away.Bodyweight), building = false, logger = false)
        assertEquals(BackMeans.PopOnePushedScreen, deep.means)
        assertEquals(Frame.Pushed(Tab.Coach, Away.Bodyweight, 4, Away.Notes), deep.frame)
        assertEquals("one at a time, never the whole stack",
            Frame.Pushed(Tab.Coach, Away.Notes, 3, Away.Thread("t1")), deep.afterBack()!!.frame)
    }

    @Test
    fun aTabThatIsNotHomeGoesHomeWithoutAPreviewAndHomeItselfLeavesTheApp() {
        val log = Standing(Tab.Log, emptyList(), building = false, logger = false)
        assertEquals(BackMeans.ReturnToTheRoutinesTab, log.means)
        assertFalse(log.means.previews)
        assertEquals(Frame.Root(Tab.Routines), log.afterBack()!!.frame)
        val home = Standing(Tab.Routines, emptyList(), building = false, logger = false)
        assertEquals(BackMeans.LeaveTheApp, home.means)
        assertNull("at the routines home back is the platform's again", home.afterBack())
    }

    @Test
    fun theRailStandsForTheTabsAndTheCoachRoomsOnly() {
        assertTrue(Frame.Root(Tab.Log).railStands)
        assertFalse("a workout takes the whole frame", Frame.Workout(Tab.Routines).railStands)
        assertFalse("so does a draft", Frame.Draft(Tab.Coach).railStands)
        assertFalse("and a pushed screen, a finished workout included",
            Frame.Pushed(Tab.Log, Away.Bodyweight, 1, null).railStands)
        assertTrue(Frame.Pushed(Tab.Routines, Away.Coach(), 1, null).railStands)
        assertTrue(Frame.Pushed(Tab.Routines, Away.Thread("t1"), 2, Away.Threads).railStands)
    }

    @Test
    fun aTabRoundTripsThroughItsNameAndAStaleNameLandsOnHome() {
        val scope = SaverScope { true }
        Tab.entries.forEach { tab ->
            val written = with(tabSaver) { scope.save(tab) }
            assertEquals(tab.name, written)
            assertEquals(tab, tabSaver.restore(written!!))
        }
        assertEquals(listOf(Tab.Routines, Tab.Routines, Tab.Routines, Tab.Routines, Tab.Routines),
            listOf("Today", "Ask", "", 42, null).map(::restoredTab))
        assertEquals(listOf("Routines", "The log", "Coach"), Tab.entries.map { it.title })
    }

    @Test
    fun retiredSettingsIsRemovedWithoutLosingOtherRoutes() {
        val raw = """[{"type":"works.windmill.gym.Away.Notes"},{"type":"works.windmill.gym.Away.Settings"},{"type":"works.windmill.gym.Away.Connections"}]"""
        assertEquals(listOf(Away.Notes, Away.Connections), awaySaver(Telemetry.None).restore(raw))
    }

    @Test
    fun unknownOrMalformedRoutesReportOneStaticRestoreFailureEach() {
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) = Unit
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        for (raw in listOf("""[{"type":"unknown"}]""", "null", "not json")) {
            assertEquals(emptyList<Away>(), awaySaver(telemetry).restore(raw))
        }
        assertEquals(List(3) { "gym.restoreNavigation" }, failures)
    }

    @Test
    fun aGestureOnAPushedScreenShowsTheScreenBeneathAndItsReleasePopsIt() = bodyweight { events ->
        startGesture()
        compose.onNode(hasText("Bodyweight") and isHeading()).assertExists()
        compose.onNode(hasText("The log") and hasClickAction()).assertExists()
        compose.runOnIdle { activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNode(hasText("Bodyweight") and isHeading()).assertDoesNotExist()
        compose.onNode(hasText("The log") and hasClickAction()).assertExists()
        assertEquals(listOf("log", "bodyweight", "log"), events.takeLast(3))
    }

    @Test
    fun aCancelledGestureKeepsTheScreenAndLetsTheOneBeneathGo() = bodyweight { events ->
        startGesture()
        compose.onNode(hasText("The log") and hasClickAction()).assertExists()
        compose.runOnIdle { activity.onBackPressedDispatcher.dispatchOnBackCancelled() }
        compose.onNode(hasText("Bodyweight") and isHeading()).assertExists()
        compose.onNode(hasText("The log") and hasClickAction()).assertDoesNotExist()
        assertEquals(listOf("log", "bodyweight"), events.takeLast(2))
    }

    @Test
    fun removeAnimationsPreviewsNothingAndPopsWithACut() {
        Settings.Global.putFloat(ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        bodyweight { _ ->
            startGesture()
            compose.onNode(hasText("The log") and hasClickAction()).assertDoesNotExist()
            assertTrue("the popped screen is gone within the first frames", poppedWithin64ms())
        }
    }

    @Test
    fun withAnimationsAPopTravelsInsteadOfCutting() = bodyweight { _ ->
        assertFalse("the leaving screen is still on its way out", poppedWithin64ms())
    }

    @Test
    fun restoringTheActivityKeepsTheStack() = bodyweight(restorable = true) { _ ->
        restoration.emulateSavedInstanceStateRestore()
        compose.onNode(hasText("Bodyweight") and isHeading()).assertExists()
        compose.runOnIdle { activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNode(hasText("The log") and hasClickAction()).assertExists()
        compose.onNode(hasText("Bodyweight") and isHeading()).assertDoesNotExist()
    }

    @Test
    fun aBusyScreenSwallowsTheGestureAndPreviewsNothing() {
        var popped = 0
        stage(busy = true, guarded = false, onPop = { popped++ })
        startGesture()
        compose.onNodeWithText("tab:Routines").assertDoesNotExist()
        compose.runOnIdle { activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("away:1:notes").assertExists()
        assertEquals(0, popped)
    }

    @Test
    fun aGuardVetoesThePreviewAndBackAsksInsteadOfLeaving() {
        var popped = 0
        var asked = 0
        stage(busy = false, guarded = true, onPop = { popped++ }, onAsk = { asked++ })
        startGesture()
        compose.onNodeWithText("tab:Routines").assertDoesNotExist()
        compose.runOnIdle { activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("away:1:notes").assertExists()
        assertEquals(0 to 1, popped to asked)
        guarded = false
        compose.runOnIdle { activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("tab:Routines").assertExists()
        assertEquals(1 to 1, popped to asked)
    }

    @Test
    fun aSecondBackDuringTheReleasePopsAgainAndTheStageSettles() {
        var popped = 0
        stage(busy = false, guarded = false, onPop = { popped++ }, away = listOf(Away.Notes, Away.Bodyweight))
        compose.mainClock.autoAdvance = false
        repeat(2) {
            compose.runOnIdle {
                activity.onBackPressedDispatcher.dispatchOnBackStarted(BackEventCompat(0f, 400f, 0f, BackEventCompat.EDGE_LEFT))
                activity.onBackPressedDispatcher.dispatchOnBackProgressed(BackEventCompat(120f, 400f, .5f, BackEventCompat.EDGE_LEFT))
                activity.onBackPressedDispatcher.onBackPressed()
            }
            compose.mainClock.advanceTimeBy(100)
        }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertEquals(2, popped)
        compose.onNodeWithText("away:1:notes").assertDoesNotExist()
        compose.onNodeWithText("away:2:bodyweight").assertDoesNotExist()
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val settled = compose.onNodeWithText("tab:Routines").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertEquals("the stage stands square, not half way out", root.left, settled.left)
    }

    @Test
    fun aBackRightAfterACancelledGesturePopsOnceAndSettles() {
        var popped = 0
        stage(busy = false, guarded = false, onPop = { popped++ })
        compose.mainClock.autoAdvance = false
        compose.runOnIdle {
            activity.onBackPressedDispatcher.dispatchOnBackStarted(BackEventCompat(0f, 400f, 0f, BackEventCompat.EDGE_LEFT))
            activity.onBackPressedDispatcher.dispatchOnBackProgressed(BackEventCompat(120f, 400f, .5f, BackEventCompat.EDGE_LEFT))
            activity.onBackPressedDispatcher.dispatchOnBackCancelled()
        }
        compose.mainClock.advanceTimeBy(48)
        compose.runOnIdle { activity.onBackPressedDispatcher.onBackPressed() }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertEquals(1, popped)
        compose.onNodeWithText("away:1:notes").assertDoesNotExist()
        compose.onNodeWithText("tab:Routines").assertIsDisplayed()
    }

    @Test
    fun theSameScreenAtTwoDepthsIsTwoFramesWithTheirOwnSavedState() {
        val navigator = GymNavigator(away = listOf(Away.Notes, Away.Bodyweight))
        val seen = mutableListOf<String>()
        compose.setContent {
            activity = LocalActivity.current as ComponentActivity
            val states = rememberSaveableStateHolder()
            GymStage(navigator.standing(building = false, logger = false), navigator.guards,
                onBack = { navigator.pop() }) { frame ->
                states.SaveableStateProvider(frame.key) {
                    val opened = rememberSaveable { frame.key }
                    Text(opened)
                    SideEffect { seen += opened }
                }
            }
        }
        compose.onNodeWithText("away:2:bodyweight").assertExists()
        compose.runOnIdle { navigator.reset(listOf(Away.Bodyweight)) }
        compose.onNodeWithText("away:1:bodyweight").assertExists()
        compose.onNodeWithText("away:2:bodyweight").assertDoesNotExist()
        assertEquals("both frames stood on the stage together, each with its own state",
            listOf("away:2:bodyweight", "away:1:bodyweight"), seen.distinct())
    }

    @Test
    fun backKeepsWhatTheScreenHasTypedBeforeItLeaves() {
        val order = mutableListOf<String>()
        compose.setContent {
            activity = LocalActivity.current as ComponentActivity
            val navigator = remember { GymNavigator(away = listOf(Away.Notes, Away.Bodyweight)) }
            GymStage(navigator.standing(building = false, logger = false), navigator.guards,
                onBack = { order += "back"; navigator.pop() }) { frame ->
                Text(frame.key)
                if (frame is Frame.Pushed) KeepOnBack { order += "kept ${frame.key}" }
            }
        }
        startGesture()
        compose.runOnIdle { activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("away:1:notes").assertExists()
        compose.runOnIdle { activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("tab:Routines").assertExists()
        assertEquals(listOf("kept away:2:bodyweight", "kept away:1:notes", "back", "kept away:1:notes", "back"), order)
    }

    private fun startGesture() {
        compose.runOnIdle {
            activity.onBackPressedDispatcher.dispatchOnBackStarted(BackEventCompat(0f, 400f, 0f, BackEventCompat.EDGE_LEFT))
            activity.onBackPressedDispatcher.dispatchOnBackProgressed(BackEventCompat(120f, 400f, .5f, BackEventCompat.EDGE_LEFT))
        }
        compose.waitForIdle()
    }

    private fun poppedWithin64ms(): Boolean {
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { activity.onBackPressedDispatcher.onBackPressed() }
        compose.mainClock.advanceTimeBy(64)
        val gone = compose.onAllNodes(hasText("Bodyweight") and isHeading()).fetchSemanticsNodes().isEmpty()
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        compose.onNode(hasText("Bodyweight") and isHeading()).assertDoesNotExist()
        return gone
    }

    private fun stage(busy: Boolean, guarded: Boolean, onPop: () -> Unit, onAsk: () -> Unit = {}, away: List<Away> = listOf(Away.Notes)) {
        this.guarded = guarded
        compose.setContent {
            activity = LocalActivity.current as ComponentActivity
            val navigator = remember { GymNavigator(away = away) }
            GymStage(navigator.standing(building = false, logger = false), navigator.guards,
                onBack = { navigator.pop(); onPop() }) { frame ->
                Text(frame.key)
                if (frame is Frame.Pushed) {
                    BackHandler(enabled = busy) {}
                    BackGuard(enabled = this.guarded, ask = onAsk)
                }
            }
        }
    }

    // A signed-out room on the log with two weigh-ins, Bodyweight pushed over it.
    private fun bodyweight(restorable: Boolean = false, test: (List<String>) -> Unit) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val screens = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_screen_viewed") screens += properties.getValue("screen")
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
        }
        val room = EngineRoomFixture(tmp.newFolder(), scope, telemetry = telemetry)
        val day = LocalDate.now()
        var showing by mutableStateOf(true)
        try {
            room.now = System.currentTimeMillis()
            runBlocking {
                room.select(null)
                room.store.bodyweight.weighIn(day.minusDays(1).toString(), 81.4)
                room.store.bodyweight.weighIn(day.toString(), 82.4)
            }
            room.store.observeEngine()
            val content: @androidx.compose.runtime.Composable () -> Unit = {
                activity = LocalActivity.current as ComponentActivity
                if (showing) CompositionLocalProvider(LocalTelemetry provides telemetry) {
                    GymMaterial { GymRoom(room.account(), room.store) }
                }
            }
            if (restorable) {
                restoration = StateRestorationTester(compose)
                restoration.setContent(content)
            } else compose.setContent(content)
            compose.onNode(hasText("The log") and hasClickAction()).performClick()
            compose.onNodeWithTag("weight:$day").performClick()
            compose.onNode(hasText("Bodyweight") and isHeading()).assertExists()
            test(screens)
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }
}
