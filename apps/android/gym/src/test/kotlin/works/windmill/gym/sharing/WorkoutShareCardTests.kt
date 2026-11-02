package works.windmill.gym.sharing

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.ContextWrapper
import android.content.Intent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.WriteFailure
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WorkoutShareCardTests {
    @get:Rule val compose = createComposeRule()

    private val share = SessionShare(token = "private-token", url = "https://windmill.works/shared/private-token", expiresAtMs = 1_756_992_000_000)
    private val copies = mutableListOf<String?>()
    private val events = mutableListOf<Pair<String, Map<String, String>>>()
    private val failures = mutableListOf<Pair<String, Map<String, String>>>()
    private val telemetry = object : Telemetry {
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation to properties }
    }

    private fun mount(startFailure: () -> Exception? = { null }, clipboardFailure: () -> Exception? = { null }, largeText: Boolean = false,
        actions: WorkoutShareActions = WorkoutShareActions("https://windmill.works", { GymResult.Ok(share) }, { null })) {
        compose.setContent {
            val context = LocalContext.current
            val wrapper = object : ContextWrapper(context) {
                override fun startActivity(intent: Intent) {
                    startFailure()?.let { throw it }
                    super.startActivity(intent)
                }
            }
            val clipboard = object : Clipboard by LocalClipboard.current {
                override suspend fun setClipEntry(clipEntry: ClipEntry?) {
                    clipboardFailure()?.let { throw it }
                    copies += clipEntry?.clipData?.getItemAt(0)?.text?.toString()
                }
            }
            CompositionLocalProvider(LocalContext provides wrapper, LocalTelemetry provides telemetry,
                LocalClipboard provides clipboard,
                LocalDensity provides if (largeText) Density(2f, fontScale = 2f) else LocalDensity.current) {
                GymMaterial { WorkoutShareCard(actions, "private-session") }
            }
        }
    }

    @Test fun aRefusedCopyReportsOneContentFreeFailureAndClaimsNothingUntilACopyLands() {
        assertRefusedCopy(IllegalStateException("private clipboard content"))
    }

    @Test fun clipboardCancellationInALiveCoroutineReportsFailureAndAllowsRetry() {
        assertRefusedCopy(CancellationException("private clipboard content"))
    }

    private fun assertRefusedCopy(error: Exception) {
        var refused = true
        mount(clipboardFailure = { if (refused) error else null })
        compose.onNodeWithText("Get a link").performClick()
        val initialSemantics = compose.onNodeWithText("Copy link").fetchSemanticsNode().config
        assertEquals(LiveRegionMode.Polite, initialSemantics[SemanticsProperties.LiveRegion])
        assertFalse(initialSemantics.contains(SemanticsProperties.StateDescription))
        compose.onNodeWithText("Copy link").performClick()
        val refusedSemantics = compose.onNodeWithText("Copy link").fetchSemanticsNode().config
        assertEquals(LiveRegionMode.Polite, refusedSemantics[SemanticsProperties.LiveRegion])
        assertFalse(refusedSemantics.contains(SemanticsProperties.StateDescription))
        compose.runOnIdle {
            assertEquals(emptyList<String?>(), copies)
            assertEquals(listOf("gym.share" to emptyMap<String, String>()), failures)
            assertEquals(listOf("gym_action" to mapOf("screen" to "session", "action" to "copy_link", "outcome" to "failed")), events)
            refused = false
        }
        compose.onNodeWithText("Copy link").performClick()
        val copiedSemantics = compose.onNodeWithText("Copied").fetchSemanticsNode().config
        assertEquals(LiveRegionMode.Polite, copiedSemantics[SemanticsProperties.LiveRegion])
        assertEquals("Link copied", copiedSemantics[SemanticsProperties.StateDescription])
        compose.runOnIdle {
            assertEquals(listOf(share.url), copies)
            assertEquals(listOf("gym.share" to emptyMap<String, String>()), failures)
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "session", "action" to "copy_link", "outcome" to "failed"),
                "gym_action" to mapOf("screen" to "session", "action" to "copy_link", "outcome" to "ok"),
            ), events)
        }
    }

    @Test fun shareSendsTheLinkAloneThroughTheChooser() {
        mount()
        compose.onNodeWithText("Get a link").performClick()
        compose.onNodeWithText("Share").performClick()
        val app = ApplicationProvider.getApplicationContext<Application>()
        val chooser = shadowOf(app).nextStartedActivity
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        assertEquals("Share workout link", chooser.getStringExtra(Intent.EXTRA_TITLE))
        val send = chooser.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)!!
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("text/plain", send.type)
        assertEquals(setOf(Intent.EXTRA_TEXT), send.extras!!.keySet())
        assertEquals(WorkoutSharing.link(share, "https://windmill.works"), send.getStringExtra(Intent.EXTRA_TEXT))
        assertNull(shadowOf(app).nextStartedActivity)
        compose.onNodeWithText("The link is live").assertExists()
        compose.onNodeWithText("Copy link").assertExists()
        assertEquals(listOf("gym_action" to mapOf("screen" to "session", "action" to "share_link", "outcome" to "ok")), events)
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), failures)
    }

    @Test fun noAppToTakeTheShareSaysSoWithoutAnIssue() {
        mount(startFailure = { ActivityNotFoundException("private failure") })
        compose.onNodeWithText("Get a link").performClick()
        compose.onNodeWithText("Share").performClick()
        compose.onNodeWithText("Sharing isn't available here. Copy the link instead.").assertExists()
        compose.onNodeWithText("The link is live").assertExists()
        compose.onNodeWithText("Copy link").performClick()
        compose.onNodeWithText("Copied").assertExists()
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), failures)
        assertEquals(listOf(
            "gym_action" to mapOf("screen" to "session", "action" to "share_link", "outcome" to "unavailable"),
            "gym_action" to mapOf("screen" to "session", "action" to "copy_link", "outcome" to "ok")), events)
    }

    private fun assertShareFailure(error: Exception) {
        mount(startFailure = { error })
        compose.onNodeWithText("Get a link").performClick()
        compose.onNodeWithText("Copy link").performClick()
        events.clear()
        compose.onNodeWithText("Share").performClick()
        compose.onNodeWithText("Sharing isn't available here. Copy the link instead.").assertExists()
        compose.onNodeWithText("The link is live").assertExists()
        compose.onNodeWithText("Copied").assertExists()
        assertEquals(listOf("gym.shareLink" to emptyMap<String, String>()), failures)
        assertEquals(listOf("gym_action" to mapOf("screen" to "session", "action" to "share_link", "outcome" to "failed")), events)
    }

    @Test fun unexpectedShareFailureReportsWithoutLosingTheLiveLink() {
        assertShareFailure(IllegalStateException("private failure"))
    }

    @Test fun synchronousCancellationIsAShareFailure() {
        assertShareFailure(CancellationException("private failure"))
    }

    @Test fun aSuccessfulRetryClearsTheShareFailureNoteAndKeepsTheCopyClaim() {
        var refused = true
        mount(startFailure = { if (refused) IllegalStateException("private failure") else null })
        compose.onNodeWithText("Get a link").performClick()
        compose.onNodeWithText("Copy link").performClick()
        events.clear()
        compose.onNodeWithText("Share").performClick()
        compose.onNodeWithText("Sharing isn't available here. Copy the link instead.").assertExists()
        compose.runOnIdle { refused = false }
        compose.onNodeWithText("Share").performClick()
        compose.onNodeWithText("Sharing isn't available here. Copy the link instead.").assertDoesNotExist()
        compose.onNodeWithText("The link is live").assertExists()
        compose.onNodeWithText("Copied").assertExists()
        assertEquals(listOf("gym.shareLink" to emptyMap<String, String>()), failures)
        assertEquals(listOf(
            "gym_action" to mapOf("screen" to "session", "action" to "share_link", "outcome" to "failed"),
            "gym_action" to mapOf("screen" to "session", "action" to "share_link", "outcome" to "ok")), events)
        val app = ApplicationProvider.getApplicationContext<Application>()
        assertEquals(Intent.ACTION_CHOOSER, shadowOf(app).nextStartedActivity.action)
        assertNull(shadowOf(app).nextStartedActivity)
    }

    @Test fun theLinkActionsAppearOnlyWhileTheLinkIsLive() {
        val minted = CompletableDeferred<GymResult<SessionShare>>()
        val revoked = CompletableDeferred<WriteFailure?>()
        mount(actions = WorkoutShareActions("https://windmill.works", { minted.await() }, { revoked.await() }))
        compose.onNodeWithText("Share").assertDoesNotExist()
        compose.onNodeWithText("Copy link").assertDoesNotExist()
        compose.onNodeWithText("Get a link").performClick()
        compose.onNodeWithText("…").assertIsNotEnabled()
        compose.onNodeWithText("Share").assertDoesNotExist()
        compose.onNodeWithText("Copy link").assertDoesNotExist()
        compose.runOnIdle { minted.complete(GymResult.Ok(share)) }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Share")).fetchSemanticsNodes().size == 1 }
        val copyTap = compose.onNodeWithText("Copy link").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        val shareTap = compose.onNodeWithText("Share").fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
        compose.onNodeWithText("Revoke the link").performScrollTo().performClick()
        compose.onNodeWithText("…").assertIsNotEnabled()
        compose.runOnIdle { copyTap(); shareTap() }
        compose.onNodeWithText("Share").assertDoesNotExist()
        compose.onNodeWithText("Copy link").assertDoesNotExist()
        compose.runOnIdle { revoked.complete(null) }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Get a link")).fetchSemanticsNodes().size == 1 }
        compose.onNodeWithText("The link is dead").assertExists()
        compose.runOnIdle { copyTap(); shareTap() }
        assertNull(shadowOf(ApplicationProvider.getApplicationContext<Application>()).nextStartedActivity)
        compose.onNodeWithText("Share").assertDoesNotExist()
        compose.onNodeWithText("Copy link").assertDoesNotExist()
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), events)
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), failures)
    }

    @Test fun aRefusedRevokeRestoresBothLinkActionsWithTheLiveNote() {
        mount(actions = WorkoutShareActions("https://windmill.works", { GymResult.Ok(share) }, { WriteFailure.NoAnswer }))
        compose.onNodeWithText("Get a link").performClick()
        compose.onNodeWithText("Revoke the link").performScrollTo().performClick()
        compose.onNodeWithText("the log didn’t answer — the link is still live").assertExists()
        compose.onNodeWithText("The link is live").assertExists()
        compose.onNodeWithText("Copy link").assertExists()
        compose.onNodeWithText("Share").assertExists()
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), events)
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), failures)
    }

    private fun assertLargeTextRow(width: Int) {
        mount(largeText = true)
        compose.onNodeWithText("Get a link").performScrollTo().performClick()
        for (copyLabel in listOf("Copy link", "Copied")) {
            compose.onNodeWithText(copyLabel).performScrollTo()
            val copy = compose.onNodeWithText(copyLabel).getBoundsInRoot()
            val send = compose.onNodeWithText("Share").getBoundsInRoot()
            assertEquals(copy.top.value, send.top.value, 0.5f)
            assertEquals(copy.height.value, send.height.value, 0.5f)
            assertEquals(copy.width.value, send.width.value, 0.5f)
            assertTrue(copy.height >= 56.dp)
            assertEquals(12f, (send.left - copy.right).value, 0.5f)
            assertEquals(20f, copy.left.value, 0.5f)
            assertEquals((width - 20).toFloat(), send.right.value, 0.5f)
            if (width == 412) assertEquals(180f, copy.width.value, 0.5f)
            val revoke = compose.onNodeWithText("Revoke the link").fetchSemanticsNode().boundsInRoot
            assertTrue(revoke.top >= compose.onNodeWithText(copyLabel).fetchSemanticsNode().boundsInRoot.bottom)
            for (label in listOf(copyLabel, "Share")) {
                val layouts = mutableListOf<TextLayoutResult>()
                compose.onNodeWithText(label, useUnmergedTree = true)
                    .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
                val layout = layouts.single()
                assertFalse(
                    "$label at $width dp: size=${layout.size}, paragraphHeight=${layout.multiParagraph.height}, " +
                        "lines=${layout.lineCount}, widthOverflow=${layout.didOverflowWidth}, " +
                        "heightOverflow=${layout.didOverflowHeight}, constraints=${layout.layoutInput.constraints}",
                    layout.hasVisualOverflow,
                )
                val lines = (0 until layout.lineCount).map { line ->
                    label.substring(layout.getLineStart(line), layout.getLineEnd(line))
                }
                assertEquals(label, lines.joinToString(""))
                if (width == 320) {
                    val expectedLines = when (label) {
                        "Copy link" -> listOf("Copy ", "link")
                        "Copied" -> listOf("Copie", "d")
                        else -> listOf("Share")
                    }
                    assertEquals(expectedLines, lines)
                }
                if (width == 412) {
                    for (line in 0 until layout.lineCount - 1) {
                        val end = layout.getLineEnd(line)
                        assertTrue("$label breaks only between words", label[end - 1].isWhitespace() || label[end].isWhitespace())
                    }
                }
            }
            if (copyLabel == "Copy link") compose.onNodeWithText(copyLabel).performClick()
        }
    }

    @Test @Config(qualifiers = "w320dp-h640dp-xhdpi") @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun theActionRowHoldsAt200PercentTextOnNarrowScreens() { assertLargeTextRow(320) }

    @Test @Config(qualifiers = "w412dp-h640dp-xhdpi") @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun theActionRowHoldsAt200PercentTextAtBoardWidth() { assertLargeTextRow(412) }
}
