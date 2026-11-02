package works.windmill.gym.coach

import android.app.Activity
import android.app.Application
import android.content.ContextWrapper
import android.content.Intent
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsIntent
import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CoachLinkHandlerTests {
    @Test fun aLinkOpensTheExactUrlInACustomTabAndReportsOnlyTheOutcome() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val telemetry = LinkTelemetry()
        val menu = CoachCopyMenu()
        CoachLinkHandler(activity, telemetry, menu, 2).openUri("https://example.org/Foo_(bar)")
        val intent = shadowOf(activity).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals("https://example.org/Foo_(bar)", intent.data.toString())
        assertTrue(intent.hasExtra(CustomTabsIntent.EXTRA_SESSION))
        assertNull(menu.selected)
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), telemetry.failures)
        assertEquals(listOf("gym_action" to mapOf("screen" to "coach", "action" to "open_link", "outcome" to "ok")), telemetry.events)
    }

    @Test fun anUppercaseSchemeIsNormalizedForAndroidIntentMatching() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val telemetry = LinkTelemetry()
        val menu = CoachCopyMenu()
        CoachLinkHandler(activity, telemetry, menu, 1).openUri("HTTP://Example.org/x")
        val intent = shadowOf(activity).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals("http://Example.org/x", intent.data.toString())
        assertTrue(intent.hasExtra(CustomTabsIntent.EXTRA_SESSION))
        assertNull(menu.selected)
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), telemetry.failures)
        assertEquals(listOf("gym_action" to mapOf("screen" to "coach", "action" to "open_link", "outcome" to "ok")), telemetry.events)
    }

    @Test fun aMissingBrowserOpensTheOriginatingBubblesMenuWithoutAnIssue() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val application: Application = RuntimeEnvironment.getApplication()
        shadowOf(application).checkActivities(true)
        val telemetry = LinkTelemetry()
        val menu = CoachCopyMenu()
        CoachLinkHandler(activity, telemetry, menu, 2).openUri("https://example.org/private")
        assertEquals(2, menu.selected)
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), telemetry.failures)
        assertEquals(listOf("gym_action" to mapOf("screen" to "coach", "action" to "open_link", "outcome" to "unavailable")), telemetry.events)
    }

    @Test fun unexpectedLaunchFailuresIncludingCancellationNeverEscapeTheNonSuspendingBoundary() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        for (failure in listOf(SecurityException("private url"), CancellationException("private url"))) {
            val context = object : ContextWrapper(activity) {
                override fun startActivity(intent: Intent, options: Bundle?) { throw failure }
            }
            val telemetry = LinkTelemetry()
            val menu = CoachCopyMenu()
            CoachLinkHandler(context, telemetry, menu, 3).openUri("https://example.org/private")
            assertEquals(3, menu.selected)
            assertEquals(listOf("gym.openLink" to emptyMap<String, String>()), telemetry.failures)
            assertEquals(listOf("gym_action" to mapOf("screen" to "coach", "action" to "open_link", "outcome" to "failed")), telemetry.events)
        }
    }

    private class LinkTelemetry : Telemetry {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<Pair<String, Map<String, String>>>()
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation to properties }
    }
}
