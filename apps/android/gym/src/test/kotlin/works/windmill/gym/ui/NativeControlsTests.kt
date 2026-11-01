package works.windmill.gym.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.R

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class NativeControlsTests {
    @get:Rule val compose = createComposeRule()

    @Test fun buttonsForwardTheirOwnActionsAndRespectDisabledDestruction() {
        val calls = mutableListOf<String>()
        compose.setContent {
            GymMaterial {
                Column {
                    GymFab("New routine", { calls += "routine" })
                    GymExtendedFab("Weigh in", { calls += "weigh-in" }, painterResource(R.drawable.gym_native_monitor_weight))
                    GymErrorButton("Discard", { calls += "discard" }, enabled = false)
                    GymErrorTextButton("Delete note", { calls += "note" })
                }
            }
        }
        compose.onNodeWithContentDescription("New routine").performClick()
        compose.onNodeWithContentDescription("Weigh in").performClick()
        compose.onNodeWithText("Discard").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Delete note").performClick()
        compose.runOnIdle { assertEquals(listOf("routine", "weigh-in", "note"), calls) }
    }

    @Test fun menuEntriesLeaveTheDecisionWithTheirConsumer() {
        val calls = mutableListOf<String>()
        compose.setContent {
            GymMaterial {
                Box {
                    GymMenu(expanded = true, onDismissRequest = { calls += "dismiss" }) {
                        GymMenuItem("Delete routine", painterResource(R.drawable.gym_native_delete),
                            { calls += "delete" }, destructive = true)
                        GymMenuItem("Unavailable", painterResource(R.drawable.gym_native_add),
                            { calls += "unavailable" }, enabled = false)
                    }
                }
            }
        }
        compose.onNodeWithText("Unavailable").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Delete routine").performClick()
        compose.runOnIdle { assertEquals(listOf("delete"), calls) }
    }
}
