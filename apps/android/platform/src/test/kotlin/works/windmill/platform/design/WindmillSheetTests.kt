package works.windmill.platform.design

import android.graphics.Insets
import android.view.View
import android.view.WindowInsets
import androidx.activity.BackEventCompat
import androidx.activity.ComponentDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog

@OptIn(ExperimentalMaterial3Api::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class WindmillSheetTests {
    @get:Rule val compose = createComposeRule()

    private var open by mutableStateOf(true)
    private var busy by mutableStateOf(false)
    private var dismissed = 0
    private var stepped = 0
    private lateinit var sheetView: View

    private fun sheet(onBack: (() -> Unit)? = null) {
        compose.setContent {
            val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
            if (open) WindmillSheet(onDismissRequest = { dismissed++; open = false }, sheetState = state, onBack = onBack) {
                BackHandler(enabled = busy) {}
                Text("Sheet body")
            }
        }
        compose.onNodeWithText("Sheet body").assertExists()
    }

    private val back get() = (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher

    @Test
    fun withTheKeyboardUpATallSheetStopsBelowTheStatusBar() {
        compose.setContent {
            val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
            WindmillSheet(onDismissRequest = {}, sheetState = state,
                dragHandle = { Box(Modifier.fillMaxWidth().height(24.dp).testTag("handle")) }) {
                sheetView = LocalView.current
                Column(Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                    Box(Modifier.fillMaxWidth().height(2000.dp))
                    Text("Focused field")
                }
            }
        }
        compose.onNodeWithTag("handle", useUnmergedTree = true).assertExists()
        val statusBar = 63
        val keyboard = 700
        val insets = WindowInsets.Builder()
            .setInsets(WindowInsets.Type.statusBars(), Insets.of(0, statusBar, 0, 0))
            .setVisible(WindowInsets.Type.statusBars(), true)
            .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, keyboard))
            .setVisible(WindowInsets.Type.ime(), true).build()
        compose.runOnIdle { sheetView.dispatchApplyWindowInsets(insets) }
        compose.waitForIdle()
        val sheetTop = compose.onNodeWithTag("handle", useUnmergedTree = true).fetchSemanticsNode().boundsInWindow.top
        val windowHeight = ShadowDialog.getLatestDialog().window!!.decorView.height
        assertTrue("the handle starts at or below the status bar: $sheetTop", sheetTop >= statusBar)
        assertTrue("and the sheet still fills the room above the keyboard: $sheetTop", sheetTop <= statusBar + 1)
        assertTrue(windowHeight > keyboard + statusBar)
    }

    @Test
    fun backSlidesTheSheetDownAndDismissesIt() {
        sheet()
        compose.runOnIdle { back.onBackPressed() }
        compose.waitUntil(5_000) { dismissed == 1 }
        compose.onNodeWithText("Sheet body").assertDoesNotExist()
    }

    @Test
    fun aGestureStartedWhileTheSheetSlidesDownCannotStopItsDismissal() {
        sheet()
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { back.onBackPressed() }
        compose.mainClock.advanceTimeBy(100)
        compose.runOnIdle {
            back.dispatchOnBackStarted(BackEventCompat(0f, 600f, 0f, BackEventCompat.EDGE_LEFT))
            back.dispatchOnBackCancelled()
        }
        compose.mainClock.autoAdvance = true
        compose.waitUntil(5_000) { dismissed > 0 }
        compose.waitForIdle()
        assertEquals(1, dismissed)
        compose.onNodeWithText("Sheet body").assertDoesNotExist()
    }

    @Test
    fun aCancelledGestureKeepsTheSheet() {
        sheet()
        compose.runOnIdle {
            back.dispatchOnBackStarted(BackEventCompat(0f, 600f, 0f, BackEventCompat.EDGE_LEFT))
            back.dispatchOnBackProgressed(BackEventCompat(160f, 600f, .6f, BackEventCompat.EDGE_LEFT))
            back.dispatchOnBackCancelled()
        }
        compose.waitForIdle()
        compose.onNodeWithText("Sheet body").assertExists()
        assertEquals(0, dismissed)
    }

    @Test
    fun aBusyHandlerTheContentRegistersSwallowsBack() {
        busy = true
        sheet()
        compose.runOnIdle { back.onBackPressed() }
        compose.waitForIdle()
        compose.onNodeWithText("Sheet body").assertExists()
        assertEquals(0, dismissed)
    }

    @Test
    fun aSheetWithItsOwnBackMeaningGetsItInsteadOfTheClose() {
        sheet(onBack = { stepped++ })
        compose.runOnIdle { back.onBackPressed() }
        compose.waitForIdle()
        compose.onNodeWithText("Sheet body").assertExists()
        assertEquals(1 to 0, stepped to dismissed)
    }
}
