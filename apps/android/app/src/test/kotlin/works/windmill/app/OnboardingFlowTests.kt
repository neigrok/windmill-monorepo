package works.windmill.app

import android.content.Intent
import android.app.KeyguardManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.unit.Density
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.WorkoutControls
import androidx.test.core.app.ActivityScenario
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi", application = WindmillApplication::class)
class OnboardingFlowTests {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun firstLaunchShowsFourScreensThenOpensGym() {
        compose.onNodeWithText("Three ways to grow.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Page 1 of 4").assertIsDisplayed()
        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithText("Map what you're learning.").assertIsDisplayed()
        compose.onNodeWithText("On the web").assertIsDisplayed()
        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithText("A page a night.").assertIsDisplayed()
        compose.onNodeWithText("On the web").assertIsDisplayed()
        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithText("Log the set.").assertIsDisplayed()
        compose.onNodeWithText("In this app").assertIsDisplayed()
        compose.onNodeWithText("Skip").assertDoesNotExist()
        compose.onNodeWithText("Get started").performClick()
        compose.onNodeWithTag("onboarding").assertDoesNotExist()
        compose.onNodeWithText("Start logging").assertIsDisplayed()
        compose.onNodeWithContentDescription("Your account").assertIsDisplayed()
    }

    @Test
    fun skipOpensGymAndColdActivityEntryDoesNotShowItAgain() {
        compose.onNodeWithText("Skip").performClick()
        compose.onNodeWithText("Start logging").assertIsDisplayed()
        compose.runOnIdle {
            assertFalse((compose.activity.application as WindmillApplication).onboardingLaunch
                .firstLaunch(hasAccount = false, deepLink = false))
        }
        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag("onboarding").assertDoesNotExist()
        compose.onNodeWithText("Start logging").assertIsDisplayed()
    }

    @Test
    fun aboutWindmillReplaysFromYouAndDoneRestoresTheAccountSheet() {
        compose.onNodeWithText("Skip").performClick()
        compose.onNodeWithContentDescription("Your account").performClick()
        compose.onNodeWithText("About Windmill").assertIsDisplayed().performClick()
        compose.onNodeWithText("Three ways to grow.").assertIsDisplayed()
        compose.onNodeWithText("Skip").assertDoesNotExist()
        compose.onNodeWithText("Back").assertIsDisplayed()
        repeat(3) { compose.onNodeWithText("Next").performClick() }
        compose.onNodeWithText("Done").assertIsDisplayed().performClick()
        compose.onNodeWithText("You").assertIsDisplayed()
        compose.onNodeWithText("About Windmill").assertIsDisplayed()
        compose.onNodeWithTag("onboarding").assertDoesNotExist()
    }

    @Test
    fun replayBackClosesToYouAndKeepsTheGymNavigation() {
        compose.onNodeWithText("Skip").performClick()
        compose.onNodeWithText("Log", useUnmergedTree = true).performClick()
        compose.onNodeWithContentDescription("Your account").performClick()
        compose.onNodeWithText("About Windmill").performClick()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("You").assertIsDisplayed()
        compose.onNodeWithText("About Windmill").assertIsDisplayed()
        compose.runOnIdle {
            val dialog = org.robolectric.shadows.ShadowDialog.getLatestDialog() as androidx.activity.ComponentDialog
            dialog.onBackPressedDispatcher.onBackPressed()
        }
        compose.onNodeWithText("You").assertDoesNotExist()
        compose.onNode(hasText("Log") and SemanticsMatcher.expectValue(SemanticsProperties.Heading, Unit), useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Start logging").assertDoesNotExist()
    }

    @Test
    fun systemBackReturnsAPageAndFirstPageDefersToTheActivity() {
        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithText("Map what you're learning.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
        compose.runOnIdle {
            assertTrue(compose.activity.onBackPressedDispatcher.hasEnabledCallbacks())
            compose.activity.onBackPressedDispatcher.onBackPressed()
            assertFalse(compose.activity.isFinishing)
        }
        compose.mainClock.advanceTimeBy(1000)
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Page 1 of 4").assertIsDisplayed()
        compose.onNodeWithText("Three ways to grow.").assertIsDisplayed()
        compose.runOnIdle {
            assertFalse(compose.activity.onBackPressedDispatcher.hasEnabledCallbacks())
            var reachedActivity = false
            val fallback = object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() { reachedActivity = true }
            }
            compose.activity.onBackPressedDispatcher.addCallback(fallback)
            compose.activity.onBackPressedDispatcher.onBackPressed()
            fallback.remove()
            assertTrue(reachedActivity)
        }
    }

    @Test
    fun committedPredictiveBackReturnsToThePreviousPage() {
        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
        compose.runOnIdle {
            compose.activity.onBackPressedDispatcher.dispatchOnBackStarted(BackEventCompat(0f, 200f, 0f, BackEventCompat.EDGE_LEFT))
            compose.activity.onBackPressedDispatcher.dispatchOnBackProgressed(BackEventCompat(80f, 200f, .4f, BackEventCompat.EDGE_LEFT))
            compose.activity.onBackPressedDispatcher.onBackPressed()
        }
        compose.onNodeWithContentDescription("Page 1 of 4").assertIsDisplayed()
        compose.onNodeWithText("Three ways to grow.").assertIsDisplayed()
    }

    @Test
    fun canceledPredictiveBackKeepsTheCurrentPage() {
        compose.onNodeWithText("Next").performClick()
        compose.runOnIdle {
            compose.activity.onBackPressedDispatcher.dispatchOnBackStarted(BackEventCompat(0f, 200f, 0f, BackEventCompat.EDGE_LEFT))
            compose.activity.onBackPressedDispatcher.dispatchOnBackProgressed(BackEventCompat(80f, 200f, .4f, BackEventCompat.EDGE_LEFT))
        }
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.dispatchOnBackCancelled() }
        compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
        compose.onNodeWithText("Map what you're learning.").assertIsDisplayed()
    }

    @Test
    fun recreationKeepsTheIntroductionAndSettledPage() {
        repeat(2) { compose.onNodeWithText("Next").performClick() }
        compose.onNodeWithText("A page a night.").assertIsDisplayed()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithContentDescription("Page 3 of 4").assertIsDisplayed()
        compose.onNodeWithText("A page a night.").assertIsDisplayed()
        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithText("Get started").assertIsDisplayed()
    }

    @Test
    fun incomingExternalIntentClosesReplayAndReturnsToGym() {
        val originalIntent = compose.activity.intent
        compose.onNodeWithText("Skip").performClick()
        compose.onNodeWithContentDescription("Your account").performClick()
        compose.onNodeWithText("About Windmill").performClick()
        compose.onNodeWithText("Three ways to grow.").assertIsDisplayed()
        compose.runOnIdle {
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().callActivityOnNewIntent(
                compose.activity, Intent(Intent.ACTION_VIEW, Uri.parse("windmill://workout"))
                    .setClass(compose.activity, MainActivity::class.java))
        }
        compose.onNodeWithTag("onboarding").assertDoesNotExist()
        compose.onNodeWithText("You").assertDoesNotExist()
        compose.onNodeWithText("Start logging").assertIsDisplayed()
        // ActivityScenario matches lifecycle callbacks against the original launch intent.
        compose.runOnIdle { compose.activity.intent = originalIntent }
    }

    @Test
    fun mainIntentWithoutLauncherCategoryClosesReplay() {
        val originalIntent = compose.activity.intent
        compose.onNodeWithText("Skip").performClick()
        compose.onNodeWithContentDescription("Your account").performClick()
        compose.onNodeWithText("About Windmill").performClick()
        compose.onNodeWithText("Three ways to grow.").assertIsDisplayed()
        compose.runOnIdle {
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().callActivityOnNewIntent(
                compose.activity, Intent(Intent.ACTION_MAIN).setClass(compose.activity, MainActivity::class.java))
        }
        compose.onNodeWithTag("onboarding").assertDoesNotExist()
        compose.onNodeWithText("Start logging").assertIsDisplayed()
        compose.runOnIdle { compose.activity.intent = originalIntent }
    }

    @Test
    fun accessibilityExposesOneGlimpseAndAnAdjustablePageControlInReadingOrder() {
        compose.onNodeWithContentDescription("Windmill").assertExists()
        compose.onNodeWithText("Next").performClick()
        val expected = listOf(
            compose.onNodeWithText("Skip") to 0f,
            compose.onNodeWithText("ROADMAP") to 1f,
            compose.onNodeWithText("Map what you're learning.") to 2f,
            compose.onNodeWithText("Your goal as a skill tree. Each step opens the next, and you watch it grow.") to 3f,
            compose.onNodeWithText("On the web") to 4f,
            compose.onNodeWithContentDescription("Example of a skill tree: Learn to sail, three steps open, three locked") to 5f,
            compose.onNodeWithContentDescription("Page 2 of 4") to 6f,
            compose.onNodeWithText("Next") to 7f,
        )
        expected.forEach { (node, index) ->
            assertEquals(index, node.fetchSemanticsNode().config[SemanticsProperties.TraversalIndex])
        }
        compose.onNodeWithText("Learn to sail").assertDoesNotExist()
        val glimpse = compose.onNodeWithContentDescription("Example of a skill tree: Learn to sail, three steps open, three locked").fetchSemanticsNode()
        assertEquals(emptyList<Any>(), glimpse.children)
        compose.onNodeWithContentDescription("Page 2 of 4").performSemanticsAction(SemanticsActions.SetProgress) { it(2f) }
        compose.onNodeWithText("A page a night.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Page 3 of 4").assertIsDisplayed()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi", application = WindmillApplication::class)
class OnboardingEntryTests {
    @get:Rule val compose = createEmptyComposeRule()

    @Test
    fun mainLauncherIntentIntroducesAFreshDevice() {
        val runtime = RuntimeEnvironment.getApplication() as WindmillApplication
        val prefs = runtime.getSharedPreferences(OnboardingLaunch.preferencesName, 0)
        assertFalse(prefs.contains("examined"))
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            .setClass(runtime, MainActivity::class.java)
        ActivityScenario.launch<MainActivity>(intent).use {
            compose.onNodeWithTag("onboarding").assertIsDisplayed()
            compose.onNodeWithText("Three ways to grow.").assertIsDisplayed()
            assertTrue(prefs.getBoolean("examined", false))
        }
    }

    @Test
    fun mainIntentWithoutLauncherCategoryNeverIntroducesAFreshDevice() {
        val runtime = RuntimeEnvironment.getApplication() as WindmillApplication
        val prefs = runtime.getSharedPreferences(OnboardingLaunch.preferencesName, 0)
        assertFalse(prefs.contains("examined"))
        val intent = Intent(Intent.ACTION_MAIN).setClass(runtime, MainActivity::class.java)
        ActivityScenario.launch<MainActivity>(intent).use {
            compose.onNodeWithTag("onboarding").assertDoesNotExist()
            compose.onNodeWithText("Start logging").assertIsDisplayed()
            assertTrue(prefs.getBoolean("examined", false))
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi", application = WindmillApplication::class)
class OnboardingExistingDataTests {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun anExistingWorkoutOnAnotherShelfOpensGymWithoutTheIntroduction() {
        val context = RuntimeEnvironment.getApplication()
        context.deleteSharedPreferences(OnboardingLaunch.preferencesName)
        val file = File(context.filesDir, WorkoutControls.fileName)
        val workout = Session("retained-workout", startedAtMs = 10L)
        val sets = listOf(TrainingSet("retained-set", "squat", weightKg = 100.0, reps = 5, completedAtMs = 15L))
        WorkoutControls(file, deviceOwner = "other").apply { hold(workout); store(sets.single(), workout.id) }
        val runtime = RuntimeEnvironment.getApplication() as WindmillApplication
        runtime.onCreate()
        val introduction = runtime.onboardingLaunch.firstLaunch(hasAccount = false, deepLink = false)
        assertFalse(introduction)
        compose.runOnUiThread { compose.activity.setContent { Root(runtime, introduction, onIntroductionExit = {}) } }
        compose.onNodeWithTag("onboarding").assertDoesNotExist()
        compose.onNodeWithText("Start logging").assertIsDisplayed()
        assertEquals(sets, WorkoutControls(file, deviceOwner = "other").sets(workout.id))
    }

    @Test
    fun largestFontKeepsThePrimaryVisibleAndAllowsWordsToScroll() {
        val runtime = RuntimeEnvironment.getApplication() as WindmillApplication
        compose.runOnUiThread { compose.activity.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 2f)) {
                Root(runtime, introduction = true, onIntroductionExit = {})
            }
        } }
        compose.onNodeWithText("Next").assertIsDisplayed()
        compose.onNodeWithText("Three ways to grow.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("One account keeps them together. You can start without one.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Next").assertIsDisplayed().performClick()
        compose.onNodeWithText("Map what you're learning.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Your goal as a skill tree. Each step opens the next, and you watch it grow.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("On the web").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Next").assertIsDisplayed().performClick()
        compose.onNodeWithText("A page a night.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Write a line or a page, in your own words. Nothing is graded or shared.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("On the web").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Next").assertIsDisplayed().performClick()
        compose.onNodeWithText("Log the set.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Two taps a set, and next time your numbers are already there.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("In this app").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Get started").assertIsDisplayed()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi", application = WindmillApplication::class)
class OnboardingLifecycleTests {
    @get:Rule val compose = createEmptyComposeRule()
    private val exits = mutableListOf<Map<String, String>>()
    private val telemetry = object : Telemetry {
        override fun event(name: String, properties: Map<String, String>) {
            if (name == "onboarding_exited") exits += properties.toMap()
        }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = Unit
    }

    private fun activity(savedState: Bundle? = null): ActivityController<MainActivity> {
        val runtime = RuntimeEnvironment.getApplication() as WindmillApplication
        ReflectionHelpers.setField(runtime, "telemetry", telemetry)
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            .setClass(runtime, MainActivity::class.java)
        val controller = Robolectric.buildActivity(MainActivity::class.java, intent)
        return if (savedState == null) controller.setup() else controller.setup(savedState)
    }

    @Test
    fun homeThenResumeAndCompleteEmitsOneTerminalExit() {
        val controller = activity()
        try {
            compose.onNodeWithText("Next").performClick()
            controller.pause().stop()
            assertEquals(emptyList<Map<String, String>>(), exits)
            controller.restart().start().resume().visible()
            compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
            repeat(2) { compose.onNodeWithText("Next").performClick() }
            compose.onNodeWithText("Get started").performClick()
            compose.onNodeWithText("Start logging").assertIsDisplayed()
            assertEquals(listOf(mapOf("state" to "first_launch", "screen" to "gym", "outcome" to "completed")), exits)
        } finally {
            controller.pause().stop().destroy()
        }
        assertEquals(1, exits.size)
    }

    @Test
    fun lockThenResumeAndSkipEmitsOneTerminalExit() {
        val controller = activity()
        val keyguard = shadowOf(controller.get().getSystemService(KeyguardManager::class.java))
        try {
            compose.onNodeWithText("Next").performClick()
            keyguard.setIsDeviceLocked(true)
            controller.pause().stop()
            assertEquals(emptyList<Map<String, String>>(), exits)
            keyguard.setIsDeviceLocked(false)
            controller.restart().start().resume().visible()
            compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
            compose.onNodeWithText("Skip").performClick()
            compose.onNodeWithText("Start logging").assertIsDisplayed()
            assertEquals(listOf(mapOf("state" to "first_launch", "screen" to "roadmap", "outcome" to "skipped")), exits)
        } finally {
            keyguard.setIsDeviceLocked(false)
            controller.pause().stop().destroy()
        }
        assertEquals(1, exits.size)
    }

    @Test
    fun configurationRecreationPreservesThePageAndDoesNotExitTheFlow() {
        val controller = activity()
        try {
            repeat(2) { compose.onNodeWithText("Next").performClick() }
            compose.onNodeWithContentDescription("Page 3 of 4").assertIsDisplayed()
            val configuration = Configuration(controller.get().resources.configuration).apply { fontScale = 1.1f }
            controller.configurationChange(configuration).visible()
            compose.onNodeWithContentDescription("Page 3 of 4").assertIsDisplayed()
            compose.onNodeWithText("A page a night.").assertIsDisplayed()
            assertEquals(emptyList<Map<String, String>>(), exits)
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test
    fun savedIntroductionWithoutAProcessTokenCannotOverrideThePersistedFlag() {
        val controller = activity()
        compose.onNodeWithText("Next").performClick()
        val savedState = Bundle()
        controller.saveInstanceState(savedState).pause().stop().destroy()
        assertTrue(savedState.getBoolean("windmill_introduction"))
        savedState.remove("windmill_introduction_process")
        val restored = activity(savedState)
        try {
            compose.onNodeWithTag("onboarding").assertDoesNotExist()
            compose.onNodeWithText("Start logging").assertIsDisplayed()
        } finally {
            restored.pause().stop().destroy()
        }
    }

    @Test
    fun savedIntroductionFromAnotherProcessCannotOverrideThePersistedFlag() {
        val controller = activity()
        compose.onNodeWithText("Next").performClick()
        val savedState = Bundle()
        controller.saveInstanceState(savedState).pause().stop().destroy()
        assertTrue(savedState.getBoolean("windmill_introduction"))
        savedState.putString("windmill_introduction_process", "another-process")
        val restored = activity(savedState)
        try {
            compose.onNodeWithTag("onboarding").assertDoesNotExist()
            compose.onNodeWithText("Start logging").assertIsDisplayed()
        } finally {
            restored.pause().stop().destroy()
        }
    }

    @Test
    fun finishingReportsTheCurrentScreenOnceEvenWithRepeatedStops() {
        val controller = activity()
        repeat(2) { compose.onNodeWithText("Next").performClick() }
        compose.onNodeWithContentDescription("Page 3 of 4").assertIsDisplayed()
        controller.get().finish()
        controller.pause().stop()
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().callActivityOnStop(controller.get())
        controller.destroy()
        assertEquals(listOf(mapOf("state" to "first_launch", "screen" to "journal", "outcome" to "closed")), exits)
    }
}
