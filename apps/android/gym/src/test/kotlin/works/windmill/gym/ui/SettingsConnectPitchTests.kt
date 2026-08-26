package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore

// The settings row is Android's only connect door since the routines-list card came off. A door that
// offers is a door that has to say who it is for: the precondition is the pitch's own honesty line
// and it came off with the card.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SettingsConnectPitchTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun settings(scope: CoroutineScope) {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { null },
        )
        compose.setContent {
            SettingsScreen(
                store = store,
                isSignedIn = true,
                origin = "https://windmill.works",
                backTo = "routines",
                onBack = {},
                onNotes = {},
                say = {},
            )
        }
    }

    @Test
    fun testTheOfferIsMadeWithItsPreconditionBesideIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        settings(scope)

        compose.onNodeWithText(ConnectedLog.connect).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.precondition).performScrollTo().assertIsDisplayed()
        scope.cancel()
    }
}
