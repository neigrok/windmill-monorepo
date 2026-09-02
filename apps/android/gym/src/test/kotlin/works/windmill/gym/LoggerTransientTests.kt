package works.windmill.gym

import android.os.SystemClock
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.DpRect
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Ladder
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.Withheld
import works.windmill.gym.ui.GymMaterial
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

// The room's transient over the logger. A set's way back is said for nine seconds, and for those
// nine seconds it must cover no control of the rack: the logger hosts it over its own reading
// region, its foot on the hairline, and the rack grows no inset for it — nothing moves.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h731dp-xhdpi")
class LoggerTransientTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val account = Account(
        api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
        user = User(id = "u1", email = "sam@example.com", name = "Sam"),
    )

    // ONE fake log: the room connects the store again on mount and reads the open session back off it.
    private fun live(scope: CoroutineScope): TrainingStore {
        val server = FakeTraining()
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json"), clock = SystemClock::uptimeMillis),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            now = SystemClock::uptimeMillis,
            mintSession = { "ses_1" },
            mintSet = Ids::set,
            sync = { server },
        )
        runBlocking {
            store.connect(account)
            store.start(null)
            store.choose("bench-press")
        }
        return store
    }

    private fun DpRect.overlaps(other: DpRect) =
        left < other.right && other.left < right && top < other.bottom && other.top < bottom

    private fun bounds(matcher: SemanticsMatcher) = compose.onNode(matcher).getBoundsInRoot()

    @Test
    fun testTheWayBackStandsOverTheReadingRegionAndCoversNoControlOfTheRack() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = live(scope)
        compose.setContent { GymMaterial { GymRoom(account, store) } }
        compose.waitForIdle()
        val logBefore = compose.onNodeWithText("Log set").assertIsDisplayed().getBoundsInRoot()

        compose.onNodeWithText("Log set").performClick()
        val said = "20 kg × 5 logged."
        compose.waitUntil(10_000) { compose.onAllNodesWithText(said).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(said).assertIsDisplayed()
        compose.onNodeWithText(Withheld.undo).assertIsDisplayed()

        // The snackbar's own box — the live region Material declares around it, margin included.
        val transient = compose
            .onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion), useUnmergedTree = true)
            .getBoundsInRoot()
        val rack = listOf(
            "Weight 20 kg", "one rep fewer", "Reps 5", "one rep more",
        ).map { it to bounds(hasContentDescription(it)) } +
            Ladder.labels(20.0).map { it to bounds(hasText(it) and hasClickAction()) } +
            ("Log set" to compose.onNodeWithText("Log set").getBoundsInRoot())
        rack.forEach { (name, control) ->
            assertFalse("the transient $transient covers $name at $control", transient.overlaps(control))
        }
        assertEquals("Log set moved for the transient", logBefore, compose.onNodeWithText("Log set").getBoundsInRoot())
        compose.runOnIdle { assertEquals("the set landed", 1, store.sets.size) }
        scope.cancel()
    }
}
