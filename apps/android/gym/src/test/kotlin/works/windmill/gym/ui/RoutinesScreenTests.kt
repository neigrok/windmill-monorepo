package works.windmill.gym.ui

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.store.DeviceCatalog
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApi

// THE TILE'S ONE GESTURE, proven by tapping it. The routine-first shape moved the start OFF the
// home list — the old shape's cost was asymmetric: a tap meant for the chevron started a workout
// nobody asked for — so the whole tile opens the routine's own page, where Start workout is a
// deliberate act made in front of the plan. The screen is composed for real and the tap is a real
// tap, because the wiring under a thumb is exactly what a pure test cannot hold still.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RoutinesScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun testARoutineTilesBodyTapOpensTheRoutineAndStartsNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCatalog = DeviceCatalog(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            scope = scope,
            sync = { null },
        )
        val kept = runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = null,
            ))
            (store.saveRoutine(RoutineDraft(name = "Push Day")
                .adding("bench-press")) as GymResult.Ok).value
        }

        val doors = mutableListOf<String>()
        compose.setContent {
            RoutinesScreen(
                store = store,
                isSignedIn = false,
                origin = "https://windmill.works",
                putOff = null,
                onJustStart = { doors += "start" },
                onBuild = { doors += "build" },
                onOpenRoutine = { doors += "open:$it" },
                onReview = { doors += "review" },
                onLater = { doors += "later" },
                onOpenSettings = { doors += "settings" },
                onSignIn = { doors += "signIn" },
            )
        }

        compose.onNodeWithText("Push Day").performClick()

        compose.runOnIdle {
            assertEquals("the tile's body opens the routine, and nothing else fires",
                listOf("open:${kept.id}"), doors)
        }
        scope.cancel()
    }
}
