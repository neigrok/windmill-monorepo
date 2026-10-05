package works.windmill.gym.ui.onboarding

import android.content.ContentResolver
import android.content.res.Configuration
import android.database.ContentObserver
import android.provider.Settings
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.Density
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowContentResolver
import org.robolectric.shadows.ShadowSettings.ShadowGlobal
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OnboardingPagerTests {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val events = mutableListOf<Pair<String, Map<String, String>>>()
    private val failures = mutableListOf<Pair<String, Throwable>>()
    private var failureExpected = false
    private val telemetry = object : Telemetry {
        override fun event(name: String, properties: Map<String, String>) {
            events += name to properties.toMap()
        }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
            if (!failureExpected) throw AssertionError("Unexpected telemetry failure: $operation", error)
            assertEquals(emptyMap<String, String>(), properties)
            failures += operation to error
        }
    }

    @Test
    fun nextRestorationAndPredictiveBackRecordOnlyCommittedSteps() {
        val restoration = StateRestorationTester(compose)
        var exits = 0
        restoration.setContent {
            CompositionLocalProvider(LocalTelemetry provides telemetry) {
                GymMaterial { OnboardingPager(replay = false, onExit = { exits++ }, reducedMotion = false) }
            }
        }
        compose.onNodeWithContentDescription("Page 1 of 4").assertIsDisplayed()
        val initial = listOf(
            "onboarding_opened" to mapOf("state" to "first_launch"),
            "onboarding_page_viewed" to mapOf("state" to "first_launch", "screen" to "windmill"),
        )
        compose.runOnIdle { assertEquals(initial, events) }

        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
        val advanced = initial + listOf(
            "onboarding_action" to mapOf("state" to "first_launch", "screen" to "windmill", "action" to "next"),
            "onboarding_page_viewed" to mapOf("state" to "first_launch", "screen" to "roadmap"),
        )
        compose.runOnIdle { assertEquals(advanced, events) }

        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
        compose.runOnIdle { assertEquals(advanced, events) }

        compose.runOnIdle {
            compose.activity.onBackPressedDispatcher.dispatchOnBackStarted(
                BackEventCompat(0f, 200f, 0f, BackEventCompat.EDGE_LEFT))
            compose.activity.onBackPressedDispatcher.dispatchOnBackProgressed(
                BackEventCompat(80f, 200f, .4f, BackEventCompat.EDGE_LEFT))
        }
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.dispatchOnBackCancelled() }
        compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
        compose.runOnIdle { assertEquals(advanced, events) }

        compose.runOnIdle {
            compose.activity.onBackPressedDispatcher.dispatchOnBackStarted(
                BackEventCompat(0f, 200f, 0f, BackEventCompat.EDGE_LEFT))
            compose.activity.onBackPressedDispatcher.dispatchOnBackProgressed(
                BackEventCompat(160f, 200f, .75f, BackEventCompat.EDGE_LEFT))
        }
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithContentDescription("Page 1 of 4").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(advanced + listOf(
                "onboarding_action" to mapOf("state" to "first_launch", "screen" to "roadmap", "action" to "back"),
                "onboarding_page_viewed" to mapOf("state" to "first_launch", "screen" to "windmill"),
            ), events)
            assertEquals(0, exits)
        }
    }

    @Test
    fun swipingBothWaysRecordsTheDepartingScreenAndOneSettledView() {
        compose.setContent {
            CompositionLocalProvider(LocalTelemetry provides telemetry) {
                GymMaterial { OnboardingPager(replay = false, onExit = {}, reducedMotion = false) }
            }
        }
        compose.onNodeWithContentDescription("Page 1 of 4").assertIsDisplayed()
        compose.onNodeWithContentDescription("Example of three rooms: Roadmap, Journal, Gym").performTouchInput {
            swipeLeft(startX = width * .9f, endX = width * .1f)
        }
        compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
        compose.onNodeWithContentDescription("Example of a skill tree: Learn to sail, three steps open, three locked").performTouchInput {
            swipeRight(startX = width * .1f, endX = width * .9f)
        }
        compose.onNodeWithContentDescription("Page 1 of 4").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(listOf(
                "onboarding_opened" to mapOf("state" to "first_launch"),
                "onboarding_page_viewed" to mapOf("state" to "first_launch", "screen" to "windmill"),
                "onboarding_action" to mapOf("state" to "first_launch", "screen" to "windmill", "action" to "swipe"),
                "onboarding_page_viewed" to mapOf("state" to "first_launch", "screen" to "roadmap"),
                "onboarding_action" to mapOf("state" to "first_launch", "screen" to "roadmap", "action" to "swipe"),
                "onboarding_page_viewed" to mapOf("state" to "first_launch", "screen" to "windmill"),
            ), events)
        }
    }

    @Test
    fun fittingPagesAcceptTheNextSwipeImmediatelyAfterSettlingAndAVerticalFling() {
        val settled = mutableListOf<Int>()
        compose.setContent {
            CompositionLocalProvider(LocalTelemetry provides telemetry) {
                GymMaterial { OnboardingPager(replay = false, onExit = {}, reducedMotion = false,
                    onPageSettled = { settled += it }) }
            }
        }
        compose.mainClock.autoAdvance = false
        try {
            for (page in 0..3) {
                val content = compose.onNodeWithTag("onboarding_page_$page", useUnmergedTree = true)
                val range = content.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
                assertEquals(0f, range.maxValue())
                assertEquals(0f, range.value())
                content.assert(SemanticsMatcher.keyNotDefined(SemanticsActions.ScrollBy))
                compose.onNodeWithContentDescription("Page ${page + 1} of 4").assertIsDisplayed()
                if (page == 3) break
                content.performTouchInput {
                    if (page > 0) swipeUp(durationMillis = 100)
                    swipeLeft(startX = width * .9f, endX = width * .1f, durationMillis = 150)
                }
                compose.mainClock.advanceTimeUntil(timeoutMillis = 2_000) { settled.last() == page + 1 }
            }
            compose.runOnIdle { assertEquals(listOf(0, 1, 2, 3), settled) }
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    @Test
    @Config(qualifiers = "w320dp-h640dp-xhdpi")
    fun doubleFontScaleStillScrollsAndAcceptsTheNextSwipeAfterAVerticalFling() {
        val settled = mutableListOf<Int>()
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f), LocalTelemetry provides telemetry) {
                GymMaterial { OnboardingPager(replay = false, onExit = {}, reducedMotion = false,
                    onPageSettled = { settled += it }) }
            }
        }
        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
        val content = compose.onNodeWithTag("onboarding_page_1", useUnmergedTree = true)
        val range = content.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
        assertTrue("double-sized text overflows", range.maxValue() > 0f)
        content.assert(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollBy))
        compose.mainClock.autoAdvance = false
        try {
            content.performTouchInput { swipeUp(startY = height * .6f, endY = height * .5f, durationMillis = 100) }
            val released = range.value()
            compose.mainClock.advanceTimeBy(32)
            assertTrue("a vertical fling keeps moving after release", range.value() > released)
            assertTrue("the fling has not reached the bottom (${range.value()}/${range.maxValue()})", range.value() < range.maxValue())
            content.performTouchInput { swipeLeft(startX = width * .9f, endX = width * .1f, durationMillis = 150) }
            compose.mainClock.advanceTimeUntil(timeoutMillis = 2_000) { settled.last() == 2 }
            compose.onNodeWithContentDescription("Page 3 of 4").assertIsDisplayed()
            compose.runOnIdle { assertEquals(listOf(0, 1, 2), settled) }
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    @Test
    fun reducedMotionReplayShowsEveryPageAndReportsItsCompletedExit() {
        var exits = 0
        compose.setContent {
            CompositionLocalProvider(LocalTelemetry provides telemetry) {
                GymMaterial { OnboardingPager(replay = true, onExit = { exits++ }, reducedMotion = true) }
            }
        }
        compose.onNodeWithContentDescription("Page 1 of 4").assertIsDisplayed()
        compose.onNodeWithText("Three ways to grow.").assertIsDisplayed()
        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
        compose.onNodeWithText("Map what you're learning.").assertIsDisplayed()
        compose.onNodeWithText("On the web").assertIsDisplayed()
        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithContentDescription("Page 3 of 4").assertIsDisplayed()
        compose.onNodeWithText("A page a night.").assertIsDisplayed()
        compose.onNodeWithText("On the web").assertIsDisplayed()
        compose.onNodeWithText("Next").performClick()
        compose.onNodeWithContentDescription("Page 4 of 4").assertIsDisplayed()
        compose.onNodeWithText("Log the set.").assertIsDisplayed()
        compose.onNodeWithText("In this app").assertIsDisplayed()
        compose.onNodeWithText("Done").performClick()
        compose.runOnIdle {
            assertEquals(1, exits)
            assertEquals(listOf(
                "onboarding_opened" to mapOf("state" to "replay"),
                "onboarding_page_viewed" to mapOf("state" to "replay", "screen" to "windmill"),
                "onboarding_action" to mapOf("state" to "replay", "screen" to "windmill", "action" to "next"),
                "onboarding_page_viewed" to mapOf("state" to "replay", "screen" to "roadmap"),
                "onboarding_action" to mapOf("state" to "replay", "screen" to "roadmap", "action" to "next"),
                "onboarding_page_viewed" to mapOf("state" to "replay", "screen" to "journal"),
                "onboarding_action" to mapOf("state" to "replay", "screen" to "journal", "action" to "next"),
                "onboarding_page_viewed" to mapOf("state" to "replay", "screen" to "gym"),
                "onboarding_exited" to mapOf("state" to "replay", "screen" to "gym", "outcome" to "completed"),
            ), events)
        }
    }

    @Test
    @Config(shadows = [MotionSettingsReadFailure::class])
    fun unreadableAnimatorScaleReportsAndNavigatesWithReducedMotion() {
        val context = compose.activity.createConfigurationContext(Configuration(compose.activity.resources.configuration))
        assertNotSame(compose.activity.contentResolver, context.contentResolver)
        val error = IllegalStateException("private settings read fixture")
        MotionSettingsReadFailure.resolver = context.contentResolver
        MotionSettingsReadFailure.error = error
        failureExpected = true
        compose.setContent {
            CompositionLocalProvider(LocalContext provides context, LocalTelemetry provides telemetry) {
                GymMaterial { OnboardingPager(replay = false, onExit = {}) }
            }
        }
        compose.onNodeWithContentDescription("Page 1 of 4").assertIsDisplayed()
        compose.mainClock.autoAdvance = false
        try {
            compose.onNodeWithText("Next").performClick()
            compose.mainClock.advanceTimeByFrame()
            compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
            compose.runOnIdle {
                assertEquals(listOf("onboarding_motion_settings" to error), failures)
                assertEquals(listOf(
                    "onboarding_opened" to mapOf("state" to "first_launch"),
                    "onboarding_page_viewed" to mapOf("state" to "first_launch", "screen" to "windmill"),
                    "onboarding_action" to mapOf("state" to "first_launch", "screen" to "windmill", "action" to "next"),
                    "onboarding_page_viewed" to mapOf("state" to "first_launch", "screen" to "roadmap"),
                ), events)
            }
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    @Test
    fun failedMotionObserverRegistrationReportsAndNavigatesWithReducedMotion() {
        val context = compose.activity.createConfigurationContext(Configuration(compose.activity.resources.configuration))
        assertNotSame(compose.activity.contentResolver, context.contentResolver)
        val error = IllegalStateException("private observer registration fixture")
        shadowOf(context.contentResolver).setRegisterContentProviderException(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), error)
        failureExpected = true
        compose.setContent {
            CompositionLocalProvider(LocalContext provides context, LocalTelemetry provides telemetry) {
                GymMaterial { OnboardingPager(replay = false, onExit = {}) }
            }
        }
        compose.onNodeWithContentDescription("Page 1 of 4").assertIsDisplayed()
        compose.mainClock.autoAdvance = false
        try {
            compose.onNodeWithText("Next").performClick()
            compose.mainClock.advanceTimeByFrame()
            compose.onNodeWithContentDescription("Page 2 of 4").assertIsDisplayed()
            compose.runOnIdle {
                assertEquals(listOf("onboarding_motion_settings" to error), failures)
                assertEquals(listOf(
                    "onboarding_opened" to mapOf("state" to "first_launch"),
                    "onboarding_page_viewed" to mapOf("state" to "first_launch", "screen" to "windmill"),
                    "onboarding_action" to mapOf("state" to "first_launch", "screen" to "windmill", "action" to "next"),
                    "onboarding_page_viewed" to mapOf("state" to "first_launch", "screen" to "roadmap"),
                ), events)
            }
        } finally {
            compose.mainClock.autoAdvance = true
        }
    }

    @Test
    @Config(shadows = [MotionObserverRemovalFailure::class])
    fun failedMotionObserverRemovalReportsAndAllowsThePagerToLeaveComposition() {
        val context = compose.activity.createConfigurationContext(Configuration(compose.activity.resources.configuration))
        assertNotSame(compose.activity.contentResolver, context.contentResolver)
        val error = IllegalStateException("private observer removal fixture")
        (shadowOf(context.contentResolver) as MotionObserverRemovalFailure).error = error
        failureExpected = true
        val visible = mutableStateOf(true)
        compose.setContent {
            CompositionLocalProvider(LocalContext provides context, LocalTelemetry provides telemetry) {
                GymMaterial { if (visible.value) OnboardingPager(replay = false, onExit = {}) }
            }
        }
        compose.onNodeWithContentDescription("Page 1 of 4").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<Pair<String, Throwable>>(), failures); visible.value = false }
        compose.onNodeWithTag("onboarding").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(listOf("onboarding_motion_settings" to error), failures)
            assertEquals(listOf(
                "onboarding_opened" to mapOf("state" to "first_launch"),
                "onboarding_page_viewed" to mapOf("state" to "first_launch", "screen" to "windmill"),
            ), events)
        }
    }
}

@Implements(Settings.Global::class)
class MotionSettingsReadFailure : ShadowGlobal() {
    companion object {
        var resolver: ContentResolver? = null
        var error: RuntimeException? = null

        @JvmStatic
        @Implementation(methodName = "getFloat")
        fun readFloat(cr: ContentResolver, name: String, defaultValue: Float): Float {
            if (cr === resolver && name == Settings.Global.ANIMATOR_DURATION_SCALE) throw requireNotNull(error)
            return ShadowGlobal.getFloat(cr, name, defaultValue)
        }
    }
}

@Implements(ContentResolver::class)
class MotionObserverRemovalFailure : ShadowContentResolver() {
    var error: RuntimeException? = null

    @Implementation
    public override fun unregisterContentObserver(observer: ContentObserver) {
        error?.let { throw it }
        super.unregisterContentObserver(observer)
    }
}
