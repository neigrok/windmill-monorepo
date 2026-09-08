package works.windmill.gym.ui

import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.MemorySessions
import works.windmill.platform.auth.SignInDoor
import works.windmill.platform.design.CapsuleFill
import works.windmill.platform.design.WindmillColor

// The shell's door is one composable; composed under the room's Skin it wears the room's colours.
// Gold in this room means a personal record, so the capsule is verdigris here.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SignInDoorSkinTests {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun theDoorUnderTheGymSkinFillsItsCapsuleWithVerdigrisNotGold() {
        val auth = AuthStore("http://localhost/".toHttpUrl(), MemorySessions())
        compose.setContent { GymMaterial { SignInDoor(auth) } }

        val capsule = compose.onNode(hasText("Email me a code") and hasClickAction())
        capsule.assert(SemanticsMatcher.expectValue(CapsuleFill, GymSkin.accent))

        val fill = capsule.fetchSemanticsNode().config[CapsuleFill]
        assertEquals(GymSkin.accent, fill)
        assertNotEquals(WindmillColor.gold400, fill)
    }
}
