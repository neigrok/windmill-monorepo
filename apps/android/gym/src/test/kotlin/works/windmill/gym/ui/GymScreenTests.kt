package works.windmill.gym.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import android.view.View
import androidx.core.view.drawToBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.dp
import org.robolectric.annotation.GraphicsMode
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class GymScreenTests {
    @get:Rule val compose = createComposeRule()

    @Test fun browserReturnUsesTheLatestSignedInAccountAndStopsWhenTheScreenLeaves() {
        val app = object : LifecycleOwner {
            override val lifecycle = LifecycleRegistry(this)
        }
        app.lifecycle.currentState = Lifecycle.State.RESUMED
        var account by mutableStateOf<String?>(null)
        var visible by mutableStateOf(true)
        val reads = mutableListOf<String>()
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides app) {
                if (visible) {
                    val owner = account
                    ReadsAgainOnReturn { owner?.let { reads += it } }
                }
            }
        }
        fun browserReturn() = compose.runOnIdle {
            app.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
            app.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
            app.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START)
            app.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        }
        browserReturn()
        assertEquals(emptyList<String>(), reads)
        compose.runOnIdle { account = "A" }
        browserReturn()
        compose.runOnIdle { account = "B" }
        browserReturn()
        browserReturn()
        assertEquals(listOf("A", "B", "B"), reads)
        compose.runOnIdle {
            app.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
            app.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        }
        assertEquals(listOf("A", "B", "B"), reads)
        compose.runOnIdle { visible = false }
        browserReturn()
        assertEquals(listOf("A", "B", "B"), reads)
    }

    // 00.1: the bar sits on the canvas at rest and takes the card ground once its content scrolls under it.
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Test fun theTopBarTintsOnceItsContentScrollsUnderIt() {
        var ground = Color.Unspecified to Color.Unspecified
        lateinit var view: View
        compose.setContent {
            view = LocalView.current
            GymMaterial {
                val skin = LocalGymColors.current
                ground = skin.canvas to skin.surface
                GymScreen(title = "Routines") {
                    LazyColumn(Modifier.fillMaxSize().testTag("rows")) {
                        items(60) { Text("Row $it", Modifier.height(56.dp)) }
                    }
                }
            }
        }
        fun bar(): Int {
            val box = compose.onNodeWithTag("gym-top-bar").fetchSemanticsNode().boundsInRoot
            return compose.runOnIdle { view.drawToBitmap().getPixel(box.right.toInt() - 4, box.center.y.toInt()) }
        }
        assertEquals(ground.first.toArgb(), bar())
        compose.onNodeWithTag("rows").performTouchInput { swipeUp() }
        compose.waitForIdle()
        assertEquals(ground.second.toArgb(), bar())
        repeat(3) { compose.onNodeWithTag("rows").performTouchInput { swipeDown() } }
        compose.waitForIdle()
        assertEquals("back at the top, the bar is canvas again", ground.first.toArgb(), bar())
    }
}
