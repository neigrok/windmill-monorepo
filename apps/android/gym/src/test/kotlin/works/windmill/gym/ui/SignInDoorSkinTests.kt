package works.windmill.gym.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.MemorySessions
import works.windmill.platform.auth.SignInDoor
import works.windmill.platform.design.CapsuleFill
import works.windmill.platform.design.LocalWindmillPalette
import works.windmill.platform.design.LocalWindmillDark

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SignInDoorSkinTests {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun theAccountDoorChangesFromInstrumentToDaylightWithTheSystemMode() {
        val auth = AuthStore("http://localhost/".toHttpUrl(), MemorySessions())
        val dark = mutableStateOf(true)
        compose.setContent {
            CompositionLocalProvider(LocalWindmillDark provides dark.value) {
                GymMaterial { SignInDoor(auth) }
            }
        }

        val capsule = compose.onNode(hasText("Email me a code") and hasClickAction())
        capsule.assert(SemanticsMatcher.expectValue(CapsuleFill, GymSkin.Instrument.accent))

        compose.runOnIdle { dark.value = false }
        capsule.assert(SemanticsMatcher.expectValue(CapsuleFill, GymSkin.Daylight.accent))

        compose.runOnIdle { dark.value = true }
        capsule.assert(SemanticsMatcher.expectValue(CapsuleFill, GymSkin.Instrument.accent))
    }

    @Test
    fun nestedAndSiblingRoomsKeepIndependentPalettesWhenTheOuterModeChanges() {
        val outerDark = mutableStateOf(true)
        val seen = mutableMapOf<String, List<Color>>()
        @Composable
        fun probe(name: String) {
            val gym = LocalGymColors.current
            val shell = LocalWindmillPalette.current
            val native = MaterialTheme.colorScheme
            val colors = listOf(gym.accent, shell.accent, native.primary,
                gym.canvas, shell.canvas, native.background)
            SideEffect { seen[name] = colors }
        }
        compose.setContent {
            CompositionLocalProvider(LocalWindmillDark provides outerDark.value) {
                GymMaterial {
                    probe("outer")
                    CompositionLocalProvider(LocalWindmillDark provides false) {
                        GymMaterial { probe("nested") }
                    }
                    probe("sibling")
                }
            }
        }
        val instrument = listOf(Color(0xFF5FCDB4), Color(0xFF5FCDB4), Color(0xFF5FCDB4),
            Color(0xFF0B1111), Color(0xFF0B1111), Color(0xFF0B1111))
        val daylight = listOf(Color(0xFF4C4374), Color(0xFF4C4374), Color(0xFF4C4374),
            Color(0xFFEBE7E3), Color(0xFFEBE7E3), Color(0xFFEBE7E3))
        compose.runOnIdle {
            assertEquals(mapOf("outer" to instrument, "nested" to daylight, "sibling" to instrument), seen)
            outerDark.value = false
        }
        compose.runOnIdle {
            assertEquals(mapOf("outer" to daylight, "nested" to daylight, "sibling" to daylight), seen)
            outerDark.value = true
        }
        compose.runOnIdle {
            assertEquals(mapOf("outer" to instrument, "nested" to daylight, "sibling" to instrument), seen)
        }
    }

}
