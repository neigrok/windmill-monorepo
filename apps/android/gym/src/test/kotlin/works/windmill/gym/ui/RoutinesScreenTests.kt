package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
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
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RoutinesScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun home(
        scope: CoroutineScope,
        doors: MutableList<String>,
        drafts: MutableList<RoutineDraft>,
    ): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { null },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = null,
            ))
            store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press"))
        }
        compose.setContent {
            RoutinesScreen(
                store = store,
                isSignedIn = true,
                lookedAt = emptySet(),
                seat = "s",
                onJustStart = { doors += "start" },
                onBuild = { drafts += it },
                onOpenRoutine = { doors += "open:$it" },
                onDeleteRoutine = { doors += "delete:$it" },
                onReview = { doors += "review" },
                onOpenSettings = { doors += "settings" },
                onSignIn = { doors += "signIn" },
            )
        }
        return store
    }

    // The reach band holds what a lifter does with a bar in their hands; planning work rides the top
    // bar, where nobody has to reach one-handed. And the connect pitch is not on this screen at all.
    @Test
    fun testTheBandStartsTheWorkoutAndTheNewRoutineActionIsInTheTopBar() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        val drafts = mutableListOf<RoutineDraft>()
        home(scope, doors, drafts)

        compose.onNodeWithText("Just start logging").assertIsDisplayed()
        compose.onNodeWithText("New routine").assertDoesNotExist()
        compose.onNodeWithContentDescription("New routine").assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.head).assertDoesNotExist()
        compose.onNodeWithText(ConnectedLog.connect).assertDoesNotExist()
        compose.onNodeWithText("Gym settings").assertIsDisplayed()

        compose.onNodeWithText("Just start logging").performClick()
        compose.runOnIdle { assertEquals(listOf("start"), doors) }
        scope.cancel()
    }

    // The overflow carries BOTH now, and that is what satisfies Law 1 for this row's swipe for free:
    // Delete is a real button a screen reader can reach, so the swipe declares no custom action of
    // its own. Duplicate stays here rather than on a second swipe action, which would hide the row's
    // own name behind the lane while a lifter decided.
    @Test
    fun testTheRowsOverflowOffersDuplicateAndTheDeleteItsSwipeAlsoMakes() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        val drafts = mutableListOf<RoutineDraft>()
        val store = home(scope, doors, drafts)
        val routineId = store.routines.single().id

        compose.onNodeWithContentDescription("More for Push Day").performClick()
        compose.onNodeWithText("Duplicate").assertIsDisplayed()
        compose.onNodeWithText("Delete routine").assertIsDisplayed()
        compose.onNodeWithText("Duplicate").performClick()

        compose.runOnIdle {
            assertEquals(1, drafts.size)
            assertEquals("a copy is not the routine, so it carries no id", null, drafts.single().id)
            assertEquals("and the lifter names it themselves", "", drafts.single().name)
            assertEquals(listOf("bench-press"), drafts.single().entries.map { it.exerciseId })
            assertEquals("nothing else fired", emptyList<String>(), doors)
        }

        compose.onNodeWithContentDescription("More for Push Day").performClick()
        compose.onNodeWithText("Delete routine").performClick()
        compose.runOnIdle {
            assertEquals("the same act the swipe makes, and the room withholds it",
                listOf("delete:$routineId"), doors)
        }
        scope.cancel()
    }

    @Test
    fun testARoutineTilesBodyTapOpensTheRoutineAndStartsNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
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
                lookedAt = emptySet(),
                seat = "",
                onJustStart = { doors += "start" },
                onBuild = { doors += "build" },
                onOpenRoutine = { doors += "open:$it" },
                onDeleteRoutine = { doors += "delete:$it" },
                onReview = { doors += "review" },
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
