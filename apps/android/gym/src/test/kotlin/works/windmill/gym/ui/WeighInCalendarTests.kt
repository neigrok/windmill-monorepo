package works.windmill.gym.ui

import android.view.MotionEvent
import androidx.activity.ComponentDialog
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.WeighIn
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xhdpi")
class WeighInCalendarTests {
    @get:Rule val compose = createComposeRule()
    private val day = LocalDate.of(2026, 10, 22)
    private val now = day.atTime(12, 0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
    private val saved = mutableListOf<Pair<String, Double>>()
    private val events = mutableListOf<Map<String, String>>()
    private val telemetry = object : Telemetry {
        override fun event(name: String, properties: Map<String, String>) { if (name == "gym_action") events += properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {}
    }

    private fun form(restoration: StateRestorationTester? = null) {
        val content: @androidx.compose.runtime.Composable () -> Unit = {
            CompositionLocalProvider(LocalTelemetry provides telemetry) {
                GymMaterial { WeighInSheet(WeighIn(day.toString(), 82.4), null, now, false, null,
                    onSave = { date, kg -> saved += date to kg }, onDelete = null) }
            }
        }
        if (restoration == null) compose.setContent(content) else restoration.setContent(content)
        compose.onNodeWithContentDescription(weightField).performTextReplacement("82,45")
        compose.onNodeWithContentDescription("Date, ${Bodyweight.fullDay(day)}").performClick()
    }

    @Test fun stagedSelectionSurvivesRecreationCommitsOnlyWithUseDateAndReopensAtTheCommittedDay() {
        val restoration = StateRestorationTester(compose)
        form(restoration)
        assertTrue(compose.onNodeWithTag("weigh-in-calendar").getBoundsInRoot().height >= 360.dp)
        compose.onNodeWithText("Thursday, October 15, 2026").performClick()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("Thursday, October 15, 2026").assertIsSelected()
        compose.onNodeWithText("Use date").performClick()
        compose.onNodeWithText("82,45").assertIsDisplayed()
        compose.onNodeWithContentDescription("Date, ${Bodyweight.fullDay(day.minusDays(7))}").assertIsDisplayed().performClick()
        compose.onNodeWithText("Thursday, October 15, 2026").assertIsSelected()
        compose.onNodeWithText("Friday, October 23, 2026").assertIsNotEnabled()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(emptyList<Pair<String, Double>>(), saved)
        assertEquals(listOf("calendar_open", "calendar_confirm", "calendar_open", "calendar_cancel"), events.map { it.getValue("action") })
        assertTrue(events.all { it.keys == setOf("screen", "action", "outcome") && it["screen"] == "bodyweight" && it["outcome"] == "ok" })
    }

    @Test fun cancelDiscardsOnlyTheStagedDate() = cancel("button")
    @Test fun backDiscardsOnlyTheStagedDate() = cancel("back")
    @Test fun outsideDismissDiscardsOnlyTheStagedDate() = cancel("outside")

    private fun cancel(door: String) {
        form()
        compose.onNodeWithText("Thursday, October 15, 2026").performClick()
        when (door) {
            "button" -> compose.onNodeWithText("Cancel").performClick()
            "back" -> compose.runOnIdle { (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed() }
            else -> compose.runOnIdle {
                val dialog = ShadowDialog.getLatestDialog()
                val event = MotionEvent.obtain(0, 0, MotionEvent.ACTION_OUTSIDE, -1f, -1f, 0)
                try { dialog.window!!.decorView.dispatchTouchEvent(event) } finally { event.recycle() }
            }
        }
        compose.onNodeWithText("82,45").assertIsDisplayed()
        compose.onNodeWithContentDescription("Date, ${Bodyweight.fullDay(day)}").assertIsDisplayed().performClick()
        compose.onNodeWithText("Thursday, October 22, 2026").assertIsSelected()
        assertEquals(emptyList<Pair<String, Double>>(), saved)
        assertEquals(listOf("calendar_open", "calendar_cancel", "calendar_open"), events.map { it.getValue("action") })
    }

    @Test fun nativeMonthYearAndInputModesRemainUsable() {
        form()
        compose.onNodeWithContentDescription("Switch to text input mode").performClick()
        compose.onNodeWithContentDescription("Switch to calendar input mode").performClick()
        compose.onNodeWithContentDescription("Change to previous month").performClick()
        compose.onNodeWithText("September 2026").assertIsDisplayed()
        compose.onNodeWithContentDescription("Change to next month").performClick()
        compose.onNodeWithText("October 2026").assertIsDisplayed()
        compose.onNodeWithText("October 2026").performClick()
        compose.onNodeWithText("Navigate to year 2025").performScrollTo().performClick()
        compose.onNodeWithText("October 2025").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("82,45").assertIsDisplayed()
        assertEquals(emptyList<Pair<String, Double>>(), saved)
    }

    @Test fun nativeTextInputRejectsFutureDatesAndKeepsItsStagedModeThroughRecreation() {
        val restoration = StateRestorationTester(compose)
        form(restoration)
        compose.onNodeWithContentDescription("Switch to text input mode").performClick()
        val dateInput = hasSetTextAction() and hasAnyAncestor(hasTestTag("weigh-in-calendar"))
        compose.onNode(dateInput).performTextReplacement("10232026")
        compose.onNodeWithText("Use date").assertIsNotEnabled()
        compose.onNode(dateInput).performTextReplacement("10152026")
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithContentDescription("Switch to calendar input mode").assertIsDisplayed()
        assertEquals("10/15/2026", compose.onNode(dateInput).fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.EditableText].text)
        compose.onNodeWithText("Use date").assertIsEnabled().performClick()
        compose.onNodeWithContentDescription("Date, ${Bodyweight.fullDay(day.minusDays(7))}").assertIsDisplayed()
        compose.onNodeWithText("82,45").assertIsDisplayed()
        assertEquals(emptyList<Pair<String, Double>>(), saved)
    }

    @Test fun invalidInputCannotSaveThroughButtonOrImeAndAValidGestureSubmitsOnce() {
        compose.setContent { GymMaterial { WeighInSheet(null, null, now, false, null,
            onSave = { date, kg -> saved += date to kg }, onDelete = null) } }
        compose.onNodeWithText(Bodyweight.save).assertIsNotEnabled()
        for (raw in listOf("", "abc", "19.99", "400.01", "82,4.5")) {
            compose.onNodeWithContentDescription(weightField).performTextReplacement(raw)
            compose.onNodeWithContentDescription(weightField).performImeAction()
            compose.onNodeWithText(Bodyweight.save).assertIsNotEnabled()
            assertEquals(emptyList<Pair<String, Double>>(), saved)
        }
        compose.onNodeWithContentDescription(weightField).performTextReplacement("82.45")
        compose.onNodeWithContentDescription(weightField).performImeAction()
        compose.onNodeWithContentDescription(weightField).assertIsNotEnabled()
        compose.onNodeWithText("Saving…").assertIsNotEnabled()
        assertEquals(listOf(day.toString() to 82.45), saved)
    }
    @Test fun repeatedIdenticalSaveRefusalsLeaveTheDraftAvailableForAnotherAttempt() {
        var refusal by mutableStateOf<String?>(null)
        var saving by mutableStateOf(false)
        var calls = 0
        compose.setContent { GymMaterial { WeighInSheet(null, null, now, saving, refusal,
            onSave = { date, kg ->
                saved += date to kg
                calls++
                if (calls < 3) refusal = "That weigh-in could not be saved." else { refusal = null; saving = true }
            }, onDelete = null) } }
        compose.onNodeWithContentDescription(weightField).performTextReplacement("82,45")
        repeat(2) {
            compose.onNodeWithText(Bodyweight.save).assertIsEnabled().performClick()
            compose.onNodeWithText("That weigh-in could not be saved.").assertIsDisplayed()
            compose.onNodeWithText("82,45").assertIsDisplayed()
        }
        compose.onNodeWithText(Bodyweight.save).assertIsEnabled().performClick()
        compose.onNodeWithText("Saving…").assertIsNotEnabled()
        assertEquals(List(3) { day.toString() to 82.45 }, saved)
    }
}
