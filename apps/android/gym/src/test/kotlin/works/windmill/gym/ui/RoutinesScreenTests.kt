package works.windmill.gym.ui

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.filterToOne
import androidx.compose.ui.test.getUnclippedBoundsInRoot
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.Config
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.sync.ProposeRoutine
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingStore

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class RoutinesScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun home(
        room: EngineRoomFixture,
        doors: MutableList<String>,
        drafts: MutableList<RoutineDraft>,
    ): TrainingStore {
        runBlocking {
            room.select(null)
            room.store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press"))
        }
        compose.setContent {
            RoutinesScreen(
                store = room.store,
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
        return room.store
    }

    private fun routine(id: String, name: String, position: Int) = RoutineDraft(
        name = name, position = position, creationId = id,
        entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", sets = List(5) { SetTarget(5, 82.5) })))

    // A proposal is the log's, so another phone on the account writes it and the room pulls it.
    private fun propose(device: EngineRoomFixture, id: String, routineId: String, name: String) {
        val runner = ActionRunner(device.engine, device.engine.registry, FixedZone(0),
            object : ActionContext { override var insideRun = false })
        assertTrue(runner.run(ProposeRoutine(Id(id, works.windmill.gym.domain.sync.Proposal),
            Id(routineId, works.windmill.gym.domain.sync.Routine), name,
            listOf(works.windmill.gym.domain.sync.RoutineEntry(Id("bench-press", works.windmill.gym.domain.sync.Exercise),
                List(5) { works.windmill.gym.domain.sync.SetTarget(3, 87.5) })), "Heavier triples.")) is Outcome.Committed)
    }

    @Test
    fun testTheBandStartsTheWorkoutAndTheNewRoutineActionIsInTheTopBar() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val doors = mutableListOf<String>()
            val drafts = mutableListOf<RoutineDraft>()
            home(room, doors, drafts)

            compose.onNodeWithText("Start logging").assertIsDisplayed()
            val newRoutine = compose.onNodeWithText("New routine")
            newRoutine.assertIsDisplayed().assert(!hasAnyAncestor(hasScrollAction()))
            newRoutine.performClick()
            compose.runOnIdle { assertEquals(listOf(RoutineDraft(position = 1)), drafts) }
            compose.onNodeWithText(ConnectedLog.action).assertDoesNotExist()
            compose.onNodeWithText("Gym settings").assertDoesNotExist()

            compose.onNodeWithText("Start logging").performClick()
            compose.runOnIdle { assertEquals(listOf("start"), doors) }
        } } finally { scope.cancel() }
    }

    @Test
    fun testTheHeadCountsTheProgramAndClaimsNothingAboutASessionItCannotSee() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            home(room, mutableListOf(), mutableListOf())

            compose.onNodeWithText("1 routine").assertDoesNotExist()
            compose.onNodeWithText("nothing running", substring = true).assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    @Test
    fun testTheRowDeclaresItsDeleteAsACustomActionNamedWithTheRoutine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val doors = mutableListOf<String>()
            val drafts = mutableListOf<RoutineDraft>()
            val store = home(room, doors, drafts)
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
        } } finally { scope.cancel() }
    }

    @Test
    fun testTheRowStandsOnTheRoomsRowFloor() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            home(room, mutableListOf(), mutableListOf())

            val bounds = compose.onNode(hasClickAction() and hasText("Push Day")).getBoundsInRoot()
            assertEquals(68.dp, bounds.height)
        } } finally { scope.cancel() }
    }

    @Test
    fun testTheRoutineTheStandingCardIsAboutDrawsNoChipOfItsOwn() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val server = EngineRoomFixture.server()
            EngineRoomFixture(tmp.newFolder(), scope).use { other -> runBlocking {
                other.select("u1"); other.pull(server)
                assertTrue(other.store.saveRoutine(routine("routine_push", "Push Day", position = 0)) is GymResult.Ok)
                assertTrue(other.store.saveRoutine(routine("routine_pull", "Pull Day", position = 1)) is GymResult.Ok)
                other.sync(server)
                propose(other, "proposal_pull", "routine_pull", "Pull Day")
                other.sync(server)
                other.now += 8_000
                propose(other, "proposal_push", "routine_push", "Push Day")
                other.sync(server)
            } }
            runBlocking { room.select("u1"); room.pull(server); room.store.refreshEngine() }
            val store = room.store
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
                assertEquals(listOf("proposal_push", "proposal_pull"), store.pendingProposals.map { it.id })
            }
            compose.onNodeWithText("Proposal · Push Day").assertIsDisplayed()
            compose.onNodeWithText("1 change").assertIsDisplayed()
            compose.onAllNodesWithText("1 proposal").assertCountEquals(1)

            compose.onNodeWithText("1 proposal").performClick()
            compose.runOnIdle {
                assertEquals("the one chip left belongs to the routine without the card",
                    listOf("proposal_pull"), reviewed)
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun testARoutineTilesBodyTapOpensTheRoutineAndStartsNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val store = room.store
            val kept = runBlocking {
                room.select(null)
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
        } } finally { scope.cancel() }
    }

    @Test
    fun testStartWorkoutIsPinnedOutOfTheScrollAndStartsTheRoutine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val started = mutableListOf<String>()
            val store = room.store
            runBlocking {
                room.select(null)
                store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press").adding("barbell-row"))
            }
            val routineId = store.routines.single().id
            compose.setContent {
                RoutineSheet(
                    routineId = routineId,
                    store = store,
                    onDismiss = {},
                    onStart = { started += it },
                    onBuild = {},
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
        } } finally { scope.cancel() }
    }

    @Test
    @Config(qualifiers = "w320dp-h915dp-xhdpi")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun compactDetailGrowsForLongMovementNamesAtDoubleTextAndKeepsPinnedActions() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val firstName = "Single arm supported dumbbell row with a long movement name"
            val secondName = "Standing overhead press with a long movement name"
            val server = EngineRoomFixture.server()
            EngineRoomFixture(tmp.newFolder(), scope).use { other -> runBlocking {
                other.select("u1"); other.pull(server)
                assertTrue(other.store.create(firstName, "barbell", id = "long-row") is GymResult.Ok)
                assertTrue(other.store.create(secondName, "barbell", id = "long-press") is GymResult.Ok)
                assertTrue(other.store.saveRoutine(RoutineDraft(name = "Compact detail", position = 0, creationId = "routine_compact",
                    entries = listOf(
                        RoutineEntry(1, "long-row", listOf(SetTarget(8, 20.0))),
                        RoutineEntry(2, "long-press", listOf(SetTarget(6, 10.0))),
                    ))) is GymResult.Ok)
                other.sync(server)
            } }
            runBlocking { room.select("u1"); room.pull(server); room.store.refreshEngine() }
            val edited = mutableListOf<RoutineDraft>()
            compose.setContent {
                CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                    RoutineSheet("routine_compact", room.store, {}, {}, { edited += it })
                }
            }
            val first = compose.onNodeWithText(firstName).performScrollTo().assertIsDisplayed()
            assertTrue("the long entry expands instead of clipping into 68dp: ${first.getUnclippedBoundsInRoot()}",
                first.getUnclippedBoundsInRoot().height > 68.dp)
            compose.onNodeWithText("Rest 1:30").assertDoesNotExist()
            compose.onNodeWithText(secondName).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("Start workout").assertIsDisplayed()
            compose.onNodeWithText("Edit routine").assertIsDisplayed().performClick()
            compose.runOnIdle {
                assertEquals(listOf(RoutineDraft.of(room.training.program().single { it.id == "routine_compact" })), edited)
            }
        } } finally { scope.cancel() }
    }
}
