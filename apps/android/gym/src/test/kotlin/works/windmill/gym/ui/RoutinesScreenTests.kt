package works.windmill.gym.ui

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.filterToOne
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
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
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalSource
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.SetTarget
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
                onSignIn = { doors += "signIn" },
            )
        }
        return store
    }

    private fun routine(id: String, name: String, position: Int) = Routine(
        id = id, name = name, position = position, revision = 1,
        entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", sets = List(5) { SetTarget(5, 82.5) })))

    private fun proposal(id: String, routineId: String, name: String, createdAtMs: Long) = Proposal(
        id = id, routineId = routineId, state = ProposalState.Pending,
        summary = "Heavier triples.", changeCount = 1, createdAtMs = createdAtMs,
        source = ProposalSource(agent = "Claude"), baseRevision = 1,
        baseName = name, name = name,
        changes = listOf(ProposalChange(position = 1, kind = ChangeKind.Retargeted,
            exerciseId = "bench-press", before = ProposalTargets(List(5) { SetTarget(5, 82.5) }),
            after = ProposalTargets(List(5) { SetTarget(3, 87.5) }))))

    @Test
    fun testTheBandStartsTheWorkoutAndTheNewRoutineActionIsInTheTopBar() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        val drafts = mutableListOf<RoutineDraft>()
        home(scope, doors, drafts)

        compose.onNodeWithText("Start logging").assertIsDisplayed()
        val newRoutine = compose.onNodeWithText("New routine")
        newRoutine.assertIsDisplayed().assert(!hasAnyAncestor(hasScrollAction()))
        newRoutine.performClick()
        compose.runOnIdle { assertEquals(listOf(RoutineDraft(position = 1)), drafts) }
        compose.onNodeWithText(ConnectedLog.action).assertDoesNotExist()
        compose.onNodeWithText("Gym settings").assertDoesNotExist()

        compose.onNodeWithText("Start logging").performClick()
        compose.runOnIdle { assertEquals(listOf("start"), doors) }
        scope.cancel()
    }

    @Test
    fun testTheHeadCountsTheProgramAndClaimsNothingAboutASessionItCannotSee() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        home(scope, mutableListOf(), mutableListOf())

        compose.onNodeWithText("1 routine").assertDoesNotExist()
        compose.onNodeWithText("nothing running", substring = true).assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun testTheRowDeclaresItsDeleteAsACustomActionNamedWithTheRoutine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val doors = mutableListOf<String>()
        val drafts = mutableListOf<RoutineDraft>()
        val store = home(scope, doors, drafts)
        val routineId = store.routines.single().id

        compose.onNodeWithContentDescription("More for Push Day").assertIsDisplayed()
        compose.onAllNodesWithText("Delete").assertCountEquals(1)

        val row = compose.onNode(hasClickAction() and hasText("Push Day")).fetchSemanticsNode()
        val actions = row.config[SemanticsActions.CustomActions]
        assertEquals(listOf("Delete Push Day"), actions.map { it.label })

        compose.runOnIdle { actions.single { it.label == "Delete Push Day" }.action() }
        compose.runOnIdle {
            assertEquals("the same act the swipe makes, and the room withholds it",
                listOf("delete:$routineId"), doors)
            assertEquals("nothing else fired", emptyList<RoutineDraft>(), drafts)
        }
        scope.cancel()
    }

    @Test
    fun testTheRowStandsOnTheRoomsRowFloor() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        home(scope, mutableListOf(), mutableListOf())

        val bounds = compose.onNode(hasClickAction() and hasText("Push Day")).getBoundsInRoot()
        assertEquals(68.dp, bounds.height)
        scope.cancel()
    }

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
                onSignIn = {},
            )
        }

        compose.runOnIdle {
            assertEquals(listOf("prop_1", "prop_2"), store.pendingProposals.map { it.id })
        }
        compose.onNodeWithText("Proposal · Push Day").assertIsDisplayed()
        compose.onNodeWithText("1 change").assertIsDisplayed()
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
            store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press").adding("barbell-row"))
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
        val first = compose.onNodeWithText("Bench Press").getBoundsInRoot()
        val second = compose.onNodeWithText("Barbell Row").getBoundsInRoot()
        assertTrue("compact movement rows retain their target", first.height >= 68.dp)
        assertTrue("the detail uses compact row rhythm", second.top - first.top < 105.dp)

        compose.onNodeWithText("Start workout").performClick()
        compose.runOnIdle { assertEquals(listOf(routineId), started) }
        scope.cancel()
    }

    @Test
    @Config(qualifiers = "w320dp-h915dp-xhdpi")
    fun compactDetailGrowsForLongMovementNamesAtDoubleTextAndKeepsPinnedActions() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try {
            val firstName = "Single arm supported dumbbell row with a long movement name"
            val secondName = "Standing overhead press with a long movement name"
            val server = FakeTraining().apply {
                catalog = listOf(Exercise("long-row", firstName), Exercise("long-press", secondName))
                settings = GymPreferences(restSeconds = null)
                written["rt_compact"] = Routine("rt_compact", "Compact detail", 0, 1, entries = listOf(
                    RoutineEntry(1, "long-row", listOf(SetTarget(8, 20.0)), restSeconds = 90),
                    RoutineEntry(2, "long-press", listOf(SetTarget(6, 10.0))),
                ))
            }
            val store = TrainingStore(SetQueue(File(tmp.root, "queue.json")), DeviceCopy(File(tmp.root, "catalog.json")),
                LocalLog(File(tmp.root, "local.json")), LocalPreferences(File(tmp.root, "prefs.json")),
                LocalBodyweight(File(tmp.root, "bodyweight.json")), scope, sync = { server })
            runBlocking { store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }),
                User("u1", "sam@example.com", "Sam"))) }
            val opened = mutableListOf<String>()
            compose.setContent {
                CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                    RoutineScreen("rt_compact", store, true, "Routines", {}, {}, {}, { opened += it }, emptySet(), {}, {})
                }
            }
            val first = compose.onNodeWithText(firstName).performScrollTo().assertIsDisplayed()
            assertTrue("the long entry expands instead of clipping into68dp: ${first.getBoundsInRoot()}", first.getBoundsInRoot().height > 68.dp)
            compose.onNodeWithText("Rest 1:30").assertIsDisplayed()
            first.performClick()
            compose.onNodeWithText(secondName).performScrollTo().assertIsDisplayed().performClick()
            compose.onNodeWithText("Start workout").assertIsDisplayed()
            compose.onNodeWithText("Edit routine").assertIsDisplayed()
            compose.runOnIdle { assertEquals(listOf("long-row", "long-press"), opened) }
        } finally { scope.cancel() }
    }
}
