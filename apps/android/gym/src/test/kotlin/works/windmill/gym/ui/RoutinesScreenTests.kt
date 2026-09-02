package works.windmill.gym.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.filterToOne
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalSource
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
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

    private fun routine(id: String, name: String, position: Int) = Routine(
        id = id, name = name, position = position, revision = 1,
        entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5,
            targetReps = 5, targetWeightKg = 82.5)))

    private fun proposal(id: String, routineId: String, name: String, createdAtMs: Long) = Proposal(
        id = id, routineId = routineId, state = ProposalState.Pending,
        summary = "Heavier triples.", changeCount = 1, createdAtMs = createdAtMs,
        source = ProposalSource(agent = "Claude"), baseRevision = 1,
        baseName = name, name = name,
        changes = listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted,
            exerciseId = "bench-press", before = ProposalTargets(5, 5, 82.5),
            after = ProposalTargets(5, 3, 87.5))))

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
        compose.onNodeWithText(ConnectedLog.connect).assertDoesNotExist()
        compose.onNodeWithText("Gym settings").assertIsDisplayed()

        compose.onNodeWithText("Just start logging").performClick()
        compose.runOnIdle { assertEquals(listOf("start"), doors) }
        scope.cancel()
    }

    // A device-local clock can support an omission, never an assertion. The tabs are not mounted while
    // a session is open, and offline this room cannot read the account the other phone is training on
    // — so the head counts the program and claims nothing about what is running.
    @Test
    fun testTheHeadCountsTheProgramAndClaimsNothingAboutASessionItCannotSee() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        home(scope, mutableListOf(), mutableListOf())

        compose.onNodeWithText("1 routine").assertIsDisplayed()
        compose.onNodeWithText("nothing running", substring = true).assertDoesNotExist()
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
        // Two nodes say it and that is the point: the swipe's lane behind the row and the overflow
        // item spend ONE word for one act, so Law 1's per-row test is satisfied by the same Delete.
        compose.onAllNodesWithText("Delete").assertCountEquals(2)
        compose.onAllNodesWithText("Delete").filterToOne(hasClickAction()).assertIsDisplayed()
        compose.onNodeWithText("Duplicate").performClick()

        compose.runOnIdle {
            assertEquals(1, drafts.size)
            assertEquals("a copy is not the routine, so it carries no id", null, drafts.single().id)
            assertEquals("and the lifter names it themselves", "", drafts.single().name)
            assertEquals(listOf("bench-press"), drafts.single().entries.map { it.exerciseId })
            assertEquals("nothing else fired", emptyList<String>(), doors)
        }

        compose.onNodeWithContentDescription("More for Push Day").performClick()
        compose.onAllNodesWithText("Delete").filterToOne(hasClickAction()).performClick()
        compose.runOnIdle {
            assertEquals("the same act the swipe makes, and the room withholds it",
                listOf("delete:$routineId"), doors)
        }
        scope.cancel()
    }

    // One proposal, one rendering. The newest waiting proposal is the standing card at the head, and
    // the routine it is about wears the accent border and NO chip; every other waiting routine keeps
    // the chip that is its only rendering.
    @Test
    fun testTheRoutineTheStandingCardIsAboutDrawsNoChipOfItsOwn() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.written["rt_1"] = routine("rt_1", "Push Day", position = 0)
        server.written["rt_2"] = routine("rt_2", "Pull Day", position = 1)
        server.propose(proposal("prop_1", "rt_1", "Push Day", createdAtMs = 9_000))
        server.propose(proposal("prop_2", "rt_2", "Pull Day", createdAtMs = 1_000))
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { server },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam"),
            ))
        }
        val reviewed = mutableListOf<String>()
        compose.setContent {
            RoutinesScreen(
                store = store,
                isSignedIn = true,
                lookedAt = emptySet(),
                seat = "s",
                onJustStart = {},
                onBuild = {},
                onOpenRoutine = {},
                onDeleteRoutine = {},
                onReview = { reviewed += it.id },
                onOpenSettings = {},
                onSignIn = {},
            )
        }

        compose.runOnIdle {
            assertEquals(listOf("prop_1", "prop_2"), store.pendingProposals.map { it.id })
        }
        compose.onNodeWithText("Proposal · Push Day").assertIsDisplayed()
        compose.onNodeWithText("Push Day · 1 change · waiting").assertIsDisplayed()
        compose.onAllNodesWithText("1 proposal").assertCountEquals(1)

        compose.onNodeWithText("1 proposal").performClick()
        compose.runOnIdle {
            assertEquals("the one chip left belongs to the routine without the card",
                listOf("prop_2"), reviewed)
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

    // The routine page's one primary is under the thumb: pinned in the Scaffold's bottom bar, out of
    // the scrolling body, and it starts the workout.
    @Test
    fun testStartWorkoutIsPinnedOutOfTheScrollAndStartsTheRoutine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val started = mutableListOf<String>()
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
        val routineId = store.routines.single().id
        compose.setContent {
            RoutineScreen(
                routineId = routineId,
                store = store,
                isSignedIn = false,
                backTo = "Routines",
                onBack = {},
                onStart = { started += it },
                onBuild = {},
                onOpenMovement = {},
                lookedAt = emptySet(),
                onReview = {},
                onOpenThread = {},
            )
        }

        compose.onNodeWithText("Start workout").assertIsDisplayed()
        compose.onNode(hasText("Start workout") and hasAnyAncestor(hasScrollAction())).assertDoesNotExist()
        compose.onNode(hasText("Bench Press") and hasAnyAncestor(hasScrollAction())).assertExists()
        val band = compose.onNodeWithText("Start workout").fetchSemanticsNode()
        val body = compose.onNodeWithText("Bench Press").fetchSemanticsNode()
        assertTrue("the band sits under the body", band.positionInRoot.y > body.positionInRoot.y)

        compose.onNodeWithText("Start workout").performClick()
        compose.runOnIdle { assertEquals(listOf(routineId), started) }
        scope.cancel()
    }
}
