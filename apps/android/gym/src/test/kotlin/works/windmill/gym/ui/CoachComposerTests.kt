package works.windmill.gym.ui

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
import okhttp3.HttpUrl.Companion.toHttpUrl
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
import works.windmill.gym.domain.CoachAttachment
import works.windmill.gym.domain.CoachDraft
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalCoach
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.storage.AtomicDocument

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CoachComposerTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    fun store(scope: CoroutineScope, localCoach: LocalCoach = LocalCoach(File(tmp.root, "coach.json"))): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { FakeTraining() },
            localCoach = localCoach,
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "user-a", email = "a@example.com", name = "A"),
            ))
        }
        return store
    }

    @Test
    fun touchDoubleTapSelectsAWordAndDraftNotificationsPreserveItUntilAnExternalClear() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope)
        val draft = CoachDraft("alpha bravo charlie")
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        store.saveCoachDraft("thread-a", draft)
        compose.setContent {
            CoachComposer(store, "thread-a", "", false, { _, _ -> }, null, null, true)
        }
        val field = compose.onNodeWithContentDescription("Question")
        field.performClick()
        val layouts = mutableListOf<TextLayoutResult>()
        field.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val layout = layouts.single()
        val textTop = (field.fetchSemanticsNode().boundsInRoot.height - layout.size.height) / 2f
        val word = layout.getBoundingBox(8).center + Offset(0f, textTop)
        field.performTouchInput { doubleClick(word) }
        assertEquals(TextRange(6, 11), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])

        compose.runOnIdle { store.saveCoachDraft("another-thread", CoachDraft("Unrelated draft")) }
        assertEquals(TextRange(6, 11), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        compose.runOnIdle { store.saveCoachDraft("thread-a", draft.copy(photo = photo)) }
        compose.onNodeWithText("Remove photo").assertIsDisplayed()
        assertEquals(TextRange(6, 11), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        compose.onNodeWithText("Remove photo").performClick()
        assertEquals(draft, store.coachDraft("thread-a"))
        assertEquals(TextRange(6, 11), field.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])

        compose.runOnIdle { store.abandonCoach("thread-a") }
        assertEquals("", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        assertEquals(CoachDraft(), LocalCoach(File(tmp.root, "coach.json")).draft("user-a", "thread-a"))
        scope.cancel()
    }

    @Test
    fun latestEditAndPhotoSurviveUploadCancellationAndHiddenInputWhileAsking() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope)
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        store.saveCoachDraft("thread-a", CoachDraft("Old caption", photo))
        var busy by mutableStateOf(false)
        var upload by mutableStateOf<Float?>(null)
        val sent = mutableListOf<CoachDraft>()
        compose.setContent {
            CoachComposer(store, "thread-a", "", busy,
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
        compose.onNodeWithText("Remove photo").assertIsDisplayed()
        compose.onNodeWithContentDescription("Send").performClick()
        compose.runOnIdle { upload = null }
        assertEquals("", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        compose.onNodeWithText("Remove photo").assertDoesNotExist()
        assertEquals(CoachDraft("Latest caption", photo), LocalCoach(File(tmp.root, "coach.json")).draft("user-a", "thread-a"))

        compose.onNodeWithContentDescription("Stop response").performClick()
        assertEquals("Latest caption", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        compose.onNodeWithText("Remove photo").assertIsDisplayed()
        assertEquals(List(2) { CoachDraft("Latest caption", photo) }, sent)
        scope.cancel()
    }

    @Test
    fun threadAndAccountChangesKeepEachDraftWithItsOwner() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope)
        store.saveCoachDraft("thread-a", CoachDraft("First thread"))
        store.saveCoachDraft("thread-b", CoachDraft("Second thread"))
        var thread by mutableStateOf("thread-a")
        var account by mutableStateOf("user-a")
        compose.setContent {
            key(account) {
                CoachComposer(store, thread, "", false, { _, _ -> }, null, null, true)
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
            runBlocking {
                store.connect(Account(
                    api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                    user = User(id = "user-b", email = "b@example.com", name = "B"),
                ))
            }
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
        val store = store(scope, localCoach)
        val sent = mutableListOf<CoachDraft>()
        compose.setContent {
            CoachComposer(store, "thread-a", "", false,
                { text, photo -> sent += CoachDraft(text, photo) }, null, null, false)
        }
        val field = compose.onNodeWithContentDescription("Question")
        compose.runOnIdle { diskAvailable = false }
        field.performTextReplacement("Unsaved question")
        compose.onNodeWithText("Your draft couldn’t be saved. Try again.").assertIsDisplayed()
        assertEquals("Unsaved question", field.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        compose.onNodeWithContentDescription("Send").performClick()
        assertEquals(emptyList<CoachDraft>(), sent)
        assertEquals(CoachDraft(), store.coachDraft("thread-a"))

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
        val store = store(scope)
        store.saveCoachDraft("thread-a", CoachDraft("First question"))
        val sent = mutableListOf<CoachDraft>()
        compose.setContent {
            CoachComposer(store, "thread-a", "", false,
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
