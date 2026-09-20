package works.windmill.gym.ui

import androidx.compose.runtime.*
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
}
