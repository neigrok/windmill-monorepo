package works.windmill.gym.coach

import works.windmill.gym.ui.*
import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.compose.runtime.CompositionLocalProvider
import androidx.core.app.ActivityOptionsCompat
import android.view.KeyCharacterMap
import android.view.KeyEvent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.click
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performMultiModalInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.withKeyDown
import androidx.compose.ui.test.withKeysDown
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowKeyCharacterMap
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.platform.storage.AtomicDocument

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CoachComposerTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private val rooms = mutableListOf<EngineRoomFixture>()

    @After
    fun closeRooms() = rooms.forEach(EngineRoomFixture::close)

    private fun signedIn(scope: CoroutineScope, localCoach: LocalCoach = LocalCoach(File(tmp.root, "coach.json"))): EngineRoomFixture =
        EngineRoomFixture(tmp.newFolder(), scope, rest = FakeGymRest(), localCoach = localCoach).also { room ->
            rooms += room
            runBlocking { room.select("user-a") }
        }

    @Test fun pickerResultReturnsToItsLaunchingChatAndCannotCrossAnAccountChange() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val room = signedIn(scope)
        val store = room.store.coach
        store.freshChat(id = "first")
        store.freshChat(id = "second")
        var chat by mutableStateOf("first")
        var requestCode = 0
        val registry = object : ActivityResultRegistry() {
            override fun <I, O> onLaunch(code: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) {
                requestCode = code
            }
        }
        val registryOwner = object : ActivityResultRegistryOwner { override val activityResultRegistry = registry }
        val file = File(tmp.root, "picked.png")
        file.outputStream().use { Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.PNG, 100, it) }
        compose.setContent {
            CompositionLocalProvider(LocalActivityResultRegistryOwner provides registryOwner) {
                CoachComposer(store, chat, "", false, { _, _ -> }, null, null, true)
            }
        }
        compose.onNodeWithContentDescription("Add photo").performClick()
        compose.runOnIdle { chat = "second" }
        compose.runOnIdle { org.junit.Assert.assertTrue(registry.dispatchResult(requestCode, Uri.fromFile(file))) }
        compose.waitUntil(10_000) { org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle(); store.draft("first").photo != null }
        assertEquals(CoachDraft(), store.draft("second"))
        compose.onNodeWithContentDescription("Add photo").performClick()
        compose.runOnIdle { runBlocking { room.select("user-b") }; store.freshChat(id = "second") }
        compose.runOnIdle { org.junit.Assert.assertTrue(registry.dispatchResult(requestCode, Uri.fromFile(file))) }
        compose.waitForIdle()
        assertEquals(CoachDraft(), store.draft("second"))
        assertEquals(null, LocalCoach(File(tmp.root, "coach.json")).draft("user-a", "second").photo)
        scope.cancel()
    }

    @Test fun attachedPhotoShowsItsAccountsCaptionAndCanBeSentWithoutTextThenRemoved() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val disk = LocalCoach(File(tmp.root, "captions.json"))
        var owner by mutableStateOf<String?>(null)
        val store = CoachStore({ owner }, { emptySet() }, {}, { null }, disk,
            works.windmill.platform.telemetry.Telemetry.None, System::nanoTime, scope)
        val chat = "caption-chat"
        store.freshChat(id = chat)
        var sent: Pair<String, CoachAttachment?>? = null
        compose.setContent { CoachComposer(store, chat, "", false, { text, photo -> sent = text to photo }, null, null, true) }
        compose.onNodeWithContentDescription("Send").assertDoesNotExist()
        compose.onNodeWithText("Sent to Coach. Saved only on this phone.").assertDoesNotExist()
        val photo = CoachAttachment("attachment-caption", "image/png", 1, 1, 3)
        compose.runOnIdle { store.saveDraft(chat, CoachDraft(photo = photo)) }
        compose.onNodeWithText("Sent to Coach. Saved only on this phone.").assertIsDisplayed()
        compose.onNodeWithText("Saved only in this chat.").assertDoesNotExist()
        compose.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
        assertEquals("" to photo, sent)
        compose.onNodeWithContentDescription("Remove photo").performClick()
        compose.onNodeWithText("Sent to Coach. Saved only on this phone.").assertDoesNotExist()
        compose.onNodeWithContentDescription("Send").assertDoesNotExist()
        compose.runOnIdle { owner = "alice"; store.freshChat(id = chat); store.saveDraft(chat, CoachDraft("Caption", photo)) }
        compose.onNodeWithText("Saved only in this chat.").assertIsDisplayed()
        compose.onNodeWithText("Sent to Coach. Saved only on this phone.").assertDoesNotExist()
        compose.onNodeWithContentDescription("Remove photo").performClick()
        compose.onNodeWithText("Saved only in this chat.").assertDoesNotExist()
        compose.onNodeWithContentDescription("Send").assertIsEnabled()
        assertEquals(CoachDraft("Caption"), store.draft(chat))
        scope.cancel()
    }

    @Test fun anonymousSendUsesItsExistingFourThousandByteBoundWithoutChangingTheBuffer() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = CoachStore({ null }, { emptySet() }, {}, { null }, LocalCoach(File(tmp.root, "anonymous.json")),
            works.windmill.platform.telemetry.Telemetry.None, System::nanoTime, scope)
        val chat = store.freshChat()
        compose.setContent { CoachComposer(store, chat, "", false, { _, _ -> error("No automatic Send") }, null, null, true) }
        val field = compose.onNodeWithContentDescription("Question")
        field.performTextReplacement("x".repeat(4_001))
        compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
        assertEquals("x".repeat(4_001), field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        field.performTextReplacement("x".repeat(4_000))
        compose.onNodeWithContentDescription("Send").assertIsEnabled()
        assertEquals("x".repeat(4_000), field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        scope.cancel()
    }

    @Test fun aDisabledLocalHistoryComposerRetainsTextAndPhotoWithoutEditingOrSending() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        val draft = CoachDraft("Retained draft", photo)
        store.coach.saveDraft("thread-a", draft)
        compose.setContent { CoachComposer(store.coach, "thread-a", "", false, { _, _ -> error("Read-only history sent a message") },
            null, null, true, enabled = false) }
        compose.onNodeWithContentDescription("Question").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Add photo").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Remove photo").assertIsNotEnabled().performClick()
        assertEquals(draft, store.coach.draft("thread-a"))
        assertEquals(draft, LocalCoach(File(tmp.root, "coach.json")).draft("user-a", "thread-a"))
        scope.cancel()
    }

    @Test
    fun touchDoubleTapSelectsAWordAndDraftNotificationsPreserveItUntilAnExternalClear() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val draft = CoachDraft("alpha bravo charlie")
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        store.coach.saveDraft("thread-a", draft)
        compose.setContent {
            CoachComposer(store.coach, "thread-a", "", false, { _, _ -> }, null, null, true)
        }
        val field = compose.onNodeWithContentDescription("Question")
        field.performClick()
        val layouts = mutableListOf<TextLayoutResult>()
        field.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val layout = layouts.single()
        val textTop = (field.fetchSemanticsNode().boundsInRoot.height - layout.size.height) / 2f
        val textLeft = (field.fetchSemanticsNode().boundsInRoot.width - layout.size.width) / 2f
        val word = layout.getBoundingBox(8).center + Offset(textLeft, textTop)
        field.performTouchInput { advanceEventTime(500); doubleClick(word, delayMillis = 150) }
        assertEquals(TextRange(6, 11), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])

        compose.runOnIdle { store.coach.saveDraft("another-thread", CoachDraft("Unrelated draft")) }
        assertEquals(TextRange(6, 11), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        compose.runOnIdle { store.coach.saveDraft("thread-a", draft.copy(photo = photo)) }
        compose.onNodeWithContentDescription("Remove photo").assertIsDisplayed()
        assertEquals(TextRange(6, 11), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        compose.onNodeWithContentDescription("Remove photo").performClick()
        assertEquals(draft, store.coach.draft("thread-a"))
        assertEquals(TextRange(6, 11), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])

        compose.runOnIdle { store.coach.saveDraft("thread-a", CoachDraft()) }
        assertEquals("", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        assertEquals(CoachDraft(), LocalCoach(File(tmp.root, "coach.json")).draft("user-a", "thread-a"))
        scope.cancel()
    }

    @Test
    fun latestEditAndPhotoSurviveUploadCancellationAndHiddenInputWhileAsking() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        store.coach.saveDraft("thread-a", CoachDraft("Old caption", photo))
        var busy by mutableStateOf(false)
        var upload by mutableStateOf<Float?>(null)
        val sent = mutableListOf<CoachDraft>()
        compose.setContent {
            CoachComposer(store.coach, "thread-a", "", busy,
                onSend = { text, attachment -> sent += CoachDraft(text, attachment); busy = true; upload = .25f },
                onStop = { busy = false; upload = null }, upload = upload, retainDraft = true)
        }
        val field = compose.onNodeWithContentDescription("Question")
        field.performTextReplacement("Latest caption")
        compose.onNodeWithContentDescription("Send").performClick()
        assertEquals(listOf(CoachDraft("Latest caption", photo)), sent)
        assertEquals(CoachDraft("Latest caption", photo), LocalCoach(File(tmp.root, "coach.json")).draft("user-a", "thread-a"))
        assertEquals("Latest caption", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        field.assertIsNotEnabled()

        compose.onNodeWithContentDescription("Cancel upload").performClick()
        assertEquals("Latest caption", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        compose.onNodeWithContentDescription("Remove photo").assertIsDisplayed()
        compose.onNodeWithContentDescription("Send").performClick()
        compose.runOnIdle { upload = null }
        assertEquals("", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        compose.onNodeWithContentDescription("Remove photo").assertDoesNotExist()
        assertEquals(CoachDraft("Latest caption", photo), LocalCoach(File(tmp.root, "coach.json")).draft("user-a", "thread-a"))

        compose.onNodeWithContentDescription("Stop response").performClick()
        assertEquals("Latest caption", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        compose.onNodeWithContentDescription("Remove photo").assertIsDisplayed()
        assertEquals(List(2) { CoachDraft("Latest caption", photo) }, sent)
        scope.cancel()
    }

    @Test
    fun threadAndAccountChangesKeepEachDraftWithItsOwner() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val room = signedIn(scope)
        val store = room.store
        store.coach.saveDraft("thread-a", CoachDraft("First thread"))
        store.coach.saveDraft("thread-b", CoachDraft("Second thread"))
        var thread by mutableStateOf("thread-a")
        var account by mutableStateOf("user-a")
        compose.setContent {
            key(account) {
                CoachComposer(store.coach, thread, "", false, { _, _ -> }, null, null, true)
            }
        }
        val field = compose.onNodeWithContentDescription("Question")
        field.performTextReplacement("First thread edited")
        compose.runOnIdle { thread = "thread-b" }
        assertEquals("Second thread", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        field.performTextReplacement("Second thread edited")
        compose.runOnIdle { thread = "thread-a" }
        assertEquals("First thread edited", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)

        compose.runOnIdle {
            runBlocking { room.select("user-b") }
            account = "user-b"
        }
        assertEquals("", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        field.performTextReplacement("Other account")
        compose.waitForIdle()
        val disk = LocalCoach(File(tmp.root, "coach.json"))
        assertEquals(CoachDraft("First thread edited"), disk.draft("user-a", "thread-a"))
        assertEquals(CoachDraft("Second thread edited"), disk.draft("user-a", "thread-b"))
        assertEquals(CoachDraft("Other account"), disk.draft("user-b", "thread-a"))
        scope.cancel()
    }

    @Test
    fun aFailedDraftWriteCannotSilentlySendTheUnsavedEdit() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        var diskAvailable = true
        val localCoach = LocalCoach(File(tmp.root, "coach.json")) { file, text ->
            if (!diskAvailable) throw IOException("Disk full")
            AtomicDocument.write(file, text)
        }
        val store = signedIn(scope, localCoach).store
        val sent = mutableListOf<CoachDraft>()
        compose.setContent {
            CoachComposer(store.coach, "thread-a", "", false,
                { text, photo -> sent += CoachDraft(text, photo) }, null, null, false)
        }
        val field = compose.onNodeWithContentDescription("Question")
        compose.runOnIdle { diskAvailable = false }
        field.performTextReplacement("Unsaved question")
        compose.onNodeWithText("Your draft couldn’t be saved. Try again.").assertIsDisplayed()
        assertEquals("Unsaved question", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        compose.onNodeWithContentDescription("Send").performClick()
        assertEquals(emptyList<CoachDraft>(), sent)
        assertEquals(CoachDraft("Unsaved question"), store.coach.draft("thread-a"))
        assertEquals(CoachDraft(), localCoach.draft("user-a", "thread-a"))

        compose.runOnIdle { diskAvailable = true }
        field.performTextReplacement("Saved question")
        compose.onNodeWithContentDescription("Send").performClick()
        assertEquals(listOf(CoachDraft("Saved question")), sent)
        assertEquals("", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        assertEquals(CoachDraft(), LocalCoach(File(tmp.root, "coach.json")).draft("user-a", "thread-a"))
        scope.cancel()
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    @Config(shadows = [CoachShortcutKeys::class])
    fun keyboardUndoAndRedoImmediatelySendAndPersistTheVisibleText() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = signedIn(scope).store
        store.coach.saveDraft("thread-a", CoachDraft("First question"))
        val sent = mutableListOf<CoachDraft>()
        compose.setContent {
            CoachComposer(store.coach, "thread-a", "", false,
                { text, photo -> sent += CoachDraft(text, photo) }, null, null, true)
        }
        val field = compose.onNodeWithContentDescription("Question")
        field.performTextReplacement("Second question")
        val send = compose.onNodeWithContentDescription("Send").fetchSemanticsNode().boundsInRoot.center
        compose.onNode(isRoot() and hasAnyDescendant(hasContentDescription("Question"))).performMultiModalInput {
            key { withKeyDown(Key.CtrlLeft) { pressKey(Key.Z) } }
            touch { click(send) }
        }
        assertEquals("First question", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        assertEquals(listOf(CoachDraft("First question")), sent)
        assertEquals(CoachDraft("First question"), LocalCoach(File(tmp.root, "coach.json")).draft("user-a", "thread-a"))

        field.performClick()
        compose.onNode(isRoot() and hasAnyDescendant(hasContentDescription("Question"))).performMultiModalInput {
            key { withKeysDown(listOf(Key.CtrlLeft, Key.ShiftLeft)) { pressKey(Key.Z) } }
            touch { click(send) }
        }
        assertEquals("Second question", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        assertEquals(listOf(CoachDraft("First question"), CoachDraft("Second question")), sent)
        assertEquals(CoachDraft("Second question"), LocalCoach(File(tmp.root, "coach.json")).draft("user-a", "thread-a"))
        scope.cancel()
    }
}

@Implements(KeyCharacterMap::class)
class CoachShortcutKeys : ShadowKeyCharacterMap() {
    companion object {
        @JvmStatic
        @Implementation(methodName = "nativeGetCharacter")
        fun shortcutCharacter(pointer: Long, keyCode: Int, metaState: Int): Char {
            // Robolectric's character map ignores Ctrl and otherwise types the shortcut letter.
            if (metaState and KeyEvent.META_CTRL_ON != 0) return '\u0000'
            return ShadowKeyCharacterMap.nativeGetCharacter(pointer, keyCode, metaState)
        }
    }
}
