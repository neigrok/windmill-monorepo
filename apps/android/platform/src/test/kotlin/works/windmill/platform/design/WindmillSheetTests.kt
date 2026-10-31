package works.windmill.platform.design

import androidx.activity.BackEventCompat
import androidx.activity.ComponentDialog
import androidx.activity.compose.BackHandler
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
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
    fun backSlidesTheSheetDownAndDismissesIt() {
        sheet()
        compose.runOnIdle { back.onBackPressed() }
        compose.waitUntil(5_000) { dismissed == 1 }
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
