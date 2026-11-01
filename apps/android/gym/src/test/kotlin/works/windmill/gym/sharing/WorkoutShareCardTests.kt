package works.windmill.gym.sharing

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.store.GymResult
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WorkoutShareCardTests {
    @get:Rule val compose = createComposeRule()

    @Test fun aRefusedCopyReportsOneContentFreeFailureAndClaimsNothingUntilACopyLands() {
        var refused = true
        val copies = mutableListOf<String?>()
        val failures = mutableListOf<Pair<String, Map<String, String>>>()
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation to properties }
        }
        val sharing = WorkoutShareActions("https://windmill.works",
            mint = { GymResult.Ok(SessionShare(token = "abc123", expiresAtMs = 1_756_992_000_000)) }, revoke = { null })
        compose.setContent {
            val clipboard = object : Clipboard by LocalClipboard.current {
                override suspend fun setClipEntry(clipEntry: ClipEntry?) {
                    if (refused) throw IllegalStateException("private clipboard content")
                    copies += clipEntry?.clipData?.getItemAt(0)?.text?.toString()
                }
            }
            GymMaterial { CompositionLocalProvider(LocalTelemetry provides telemetry, LocalClipboard provides clipboard) {
                WorkoutShareCard(sharing, "session-1")
            } }
        }
        compose.onNodeWithText("Get a link").performClick()
        compose.onNodeWithText("Copy link").performClick()
        compose.onNodeWithText("Copy link").assertExists()
        compose.runOnIdle {
            assertEquals(emptyList<String?>(), copies)
            assertEquals(listOf("gym.share" to emptyMap<String, String>()), failures)
            assertEquals(listOf("gym_action" to mapOf("screen" to "session", "action" to "share", "outcome" to "failed")), events)
            refused = false
        }
        compose.onNodeWithText("Copy link").performClick()
        compose.onNodeWithText("Copied").assertExists()
        compose.runOnIdle {
            assertEquals(listOf<String?>("https://windmill.works/#/gym/shared/abc123"), copies)
            assertEquals(listOf("gym.share" to emptyMap<String, String>()), failures)
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "session", "action" to "share", "outcome" to "failed"),
                "gym_action" to mapOf("screen" to "session", "action" to "share", "outcome" to "ok"),
            ), events)
        }
    }
}
