package works.windmill.gym.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class EquipmentIconTests {
    @get:Rule val compose = createComposeRule()

    @Test
    fun approvedGlyphsKeepTheirNativeSlotAndPendingVariantsDoNotBorrowAnotherGlyph() {
        val approved = listOf("barbell", "dumbbell", "bodyweight", "machine")
        val pending = listOf("cable", "kettlebell", "unknown")
        compose.setContent {
            GymMaterial {
                Row {
                    (approved + pending).forEach { equipment ->
                        EquipmentIcon(equipment, Modifier.testTag(equipment))
                    }
                }
            }
        }
        approved.forEach { equipment ->
            compose.onNodeWithTag(equipment).assertWidthIsEqualTo(24.dp).assertHeightIsEqualTo(24.dp)
        }
        pending.forEach { compose.onNodeWithTag(it).assertDoesNotExist() }
    }
}
