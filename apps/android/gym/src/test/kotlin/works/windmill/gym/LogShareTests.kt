package works.windmill.gym

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.AnnotatedString
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.presentation.Readout
import works.windmill.gym.net.GymRest
import works.windmill.gym.sharing.SessionShare
import works.windmill.platform.Account
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.TrainingRefused
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LogShareTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()
    private var showing by mutableStateOf(true)

    @Test fun clipboardFailureReportsOneStaticFailureAndRetryCanCopy() = share(refuseMint = false)
    @Test fun mintRefusalIsHonestAndRetryCanCopyWithoutAnIssue() = share(refuseMint = true)

    private fun share(refuseMint: Boolean) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val actions = mutableListOf<Map<String, String>>()
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_action" && properties["action"] == "share") actions += properties
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val rest = FakeGymRest().apply { if (refuseMint) refuseShare = TrainingRefused("not-allowed", "Sharing unavailable.") }
        val room = EngineRoomFixture(tmp.newFolder(), scope, rest = rest, telemetry = telemetry)
        var failClipboard = !refuseMint
        var copies = 0
        try {
            room.now = 1_700_000_000_000
            runBlocking { room.select("u1"); room.workout() }
            room.store.observeEngine()
            compose.setContent {
                if (showing) {
                    val systemClipboard = LocalClipboardManager.current
                    val clipboard = object : ClipboardManager by systemClipboard {
                        override fun setText(annotatedString: AnnotatedString) {
                            copies++
                            if (failClipboard) throw IllegalStateException("private clipboard content")
                            systemClipboard.setText(annotatedString)
                        }
                    }
                    CompositionLocalProvider(LocalClipboardManager provides clipboard, LocalTelemetry provides telemetry) {
                        GymMaterial { GymRoom(room.account(), room.store) }
                    }
                }
            }
            compose.onNode(hasText("The log") and hasClickAction()).performClick()
            fun shareRow() {
                compose.onNode(hasText(Readout.noRoutine) and hasClickAction()).performTouchInput { longClick() }
                compose.onNodeWithText("Share this workout").performClick()
            }
            shareRow()
            compose.onNodeWithText(if (refuseMint) "Sharing unavailable." else "The link could not be copied. Try Share this workout again.").assertIsDisplayed()
            compose.runOnIdle {
                assertEquals(listOf(mapOf("screen" to "log", "action" to "share", "outcome" to if (refuseMint) "refused" else "failed")), actions)
                assertEquals(if (refuseMint) emptyList<String>() else listOf("gym.share"), failures)
                assertEquals(if (refuseMint) 0 else 1, copies)
                failClipboard = false
                rest.refuseShare = null
            }
            shareRow()
            compose.onNodeWithText("Link copied — anyone who has it can read this workout").assertIsDisplayed()
            compose.runOnIdle {
                assertEquals(listOf(mapOf("screen" to "log", "action" to "share", "outcome" to if (refuseMint) "refused" else "failed"),
                    mapOf("screen" to "log", "action" to "share", "outcome" to "ok")), actions)
                assertEquals(if (refuseMint) 1 else 2, copies)
            }
        } finally {
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }
    @Test fun aReplyAfterAccountReplacementCannotPublishAPrivateLink() = ownerChanged(returnToOpeningOwner = false)
    @Test fun aReplyAfterAccountRoundTripCannotPublishAPrivateLink() = ownerChanged(returnToOpeningOwner = true)

    private fun ownerChanged(returnToOpeningOwner: Boolean) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val pending = CompletableDeferred<SessionShare>()
        val started = CompletableDeferred<Unit>()
        val delegate = FakeGymRest()
        val rest = object : GymRest by delegate {
            override suspend fun share(sessionId: String): SessionShare {
                started.complete(Unit)
                return withContext(NonCancellable) { pending.await() }
            }
        }
        val actions = mutableListOf<Map<String, String>>()
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_action" && properties["action"] == "share") actions += properties
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val room = EngineRoomFixture(tmp.newFolder(), scope, rest = rest, telemetry = telemetry)
        var presented by mutableStateOf<Account?>(null)
        var copies = 0
        try {
            room.now = 1_700_000_000_000
            runBlocking { room.select("A"); room.workout() }
            room.store.observeEngine()
            presented = room.account("A")
            compose.setContent {
                if (showing) {
                    val systemClipboard = LocalClipboardManager.current
                    val clipboard = object : ClipboardManager by systemClipboard {
                        override fun setText(annotatedString: AnnotatedString) { copies++ }
                    }
                    CompositionLocalProvider(LocalClipboardManager provides clipboard, LocalTelemetry provides telemetry) {
                        GymMaterial { GymRoom(presented!!, room.store) }
                    }
                }
            }
            compose.onNode(hasText("The log") and hasClickAction()).performClick()
            compose.onNode(hasText(Readout.noRoutine) and hasClickAction()).performTouchInput { longClick() }
            compose.onNodeWithText("Share this workout").performClick()
            compose.runOnIdle { assertEquals(true, started.isCompleted) }
            compose.runOnIdle {
                runBlocking { room.select("B") }
                val account = room.account("B")
                presented = Account(account.origin, account.user, identityRevision = 1)
            }
            compose.waitForIdle()
            if (returnToOpeningOwner) {
                compose.runOnIdle {
                    runBlocking { room.select("A") }
                    val account = room.account("A")
                    presented = Account(account.origin, account.user, identityRevision = 2)
                }
                compose.waitForIdle()
            }
            compose.runOnIdle { pending.complete(SessionShare(token = "private-capability", expiresAtMs = 1_800_000_000_000)) }
            compose.waitForIdle()
            compose.onNodeWithText("Link copied — anyone who has it can read this workout").assertDoesNotExist()
            compose.onNodeWithText("The link could not be copied. Try Share this workout again.").assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(0, copies)
                assertEquals(emptyList<Map<String, String>>(), actions)
                assertEquals(emptyList<String>(), failures)
            }
        } finally {
            pending.complete(SessionShare(token = "private-capability", expiresAtMs = 1_800_000_000_000))
            compose.runOnIdle { showing = false }
            compose.waitForIdle()
            scope.cancel()
            room.close()
        }
    }
}
