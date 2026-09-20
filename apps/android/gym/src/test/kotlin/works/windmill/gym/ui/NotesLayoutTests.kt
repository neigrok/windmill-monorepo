package works.windmill.gym.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import java.io.File
import kotlinx.coroutines.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.domain.Notes
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.*
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NotesLayoutTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    @Test fun instrumentEditorKeepsSaveReachableAtDoubleTextAndKeyboardHeight() = editorAtDoubleText(true)
    @Test fun daylightEditorKeepsSaveReachableAtDoubleTextAndKeyboardHeight() = editorAtDoubleText(false)

    private fun editorAtDoubleText(dark: Boolean) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")),
            LocalLog(File(tmp.root, "log")), LocalPreferences(File(tmp.root, "prefs")),
            LocalBodyweight(File(tmp.root, "weight")), scope, sync = { server })
        runBlocking { store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }),
            User("a", "a@example.com", "A"))) }
        var saved = 0
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(2f, 2f), LocalWindmillDark provides dark) {
                GymMaterial { Box(Modifier.height(340.dp)) {
                    NoteEditorScreen(null, "", store, "Notes", {}, { saved++ })
                } }
            }
        }
        compose.onNodeWithContentDescription("Title field").performScrollTo()
            .performTextReplacement("Training notes for autumn races")
        compose.onNodeWithContentDescription("Body field").performScrollTo().performTextReplacement("é".repeat(251))
        compose.onNodeWithText(Notes.save).assertIsDisplayed().assertIsEnabled().performClick()
        compose.onNodeWithText("a note runs to 500 bytes").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Body field").performScrollTo().performTextReplacement("Short answers.\nKeep the date and number.")
        compose.onNodeWithText(Notes.honesty).performScrollTo().assertIsDisplayed()
        val save = compose.onNodeWithText(Notes.save).assertIsDisplayed()
        assertTrue(save.getBoundsInRoot().height >= 48.dp)
        val layouts = mutableListOf<TextLayoutResult>()
        save.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
        val layout = layouts.single()
        assertFalse(layout.didOverflowHeight)
        for (line in 0 until layout.lineCount) {
            assertFalse(layout.isLineEllipsized(line))
            assertTrue(layout.getLineRight(line) - layout.getLineLeft(line) <= layout.size.width + 1)
        }
        assertEquals(Notes.save.length, layout.getLineEnd(layout.lineCount - 1))
        save.performClick()
        compose.runOnIdle {
            assertEquals(1, saved)
            assertEquals("Training notes for autumn races", server.notebook.single().title)
            assertEquals("Short answers.\nKeep the date and number.", server.notebook.single().body)
        }
        scope.cancel()
    }
}
