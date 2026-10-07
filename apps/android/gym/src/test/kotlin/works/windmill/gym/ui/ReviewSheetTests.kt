package works.windmill.gym.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.printToString
import androidx.compose.ui.unit.dp
import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import works.windmill.domain.kit.Id
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalIntent
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.sync.ProposalRules
import works.windmill.gym.domain.sync.SeedExercises
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.ProposalRead
import works.windmill.gym.store.TrainingStore
import works.windmill.sync.core.Json
import works.windmill.sync.modelserver.ModelServer
import works.windmill.sync.modelserver.ServerCall
import works.windmill.gym.domain.sync.Exercise as SyncExercise
import works.windmill.gym.domain.sync.RoutineEntry as SyncEntry
import works.windmill.gym.domain.sync.SetTarget as SyncTarget

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class ReviewSheetTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val rooms = mutableListOf<EngineRoomFixture>()

    @After
    fun closeRooms() = rooms.forEach(EngineRoomFixture::close)

    private fun signedIn(scope: CoroutineScope): EngineRoomFixture =
        EngineRoomFixture(tmp.newFolder(), scope, rest = FakeGymRest()).also { room ->
            rooms += room
            runBlocking { room.select("u1") }
        }

    // The routine the diff was written against: every line it did not add, as it stood.
    private fun routineFor(room: EngineRoomFixture, server: ModelServer, name: String, changes: List<ProposalChange>): Routine = runBlocking {
        val draft = changes.filter { it.kind != ChangeKind.Added }
            .fold(RoutineDraft(name = name)) { draft, change -> draft.adding(change.exerciseId, change.before!!.sets) }
        (room.store.saveRoutine(draft) as GymResult.Ok).value.also { room.sync(server) }
    }

    // Coach, or a connected agent, writes the proposal on the server, and this phone pulls it.
    private fun propose(
        room: EngineRoomFixture,
        server: ModelServer,
        routine: Routine,
        changes: List<ProposalChange>,
        summary: String = "Heavier triples.",
        id: String = "proposal1",
        intent: ProposalIntent = ProposalIntent.Revise,
        door: String = "ask",
        agent: String = "",
        pull: Boolean = true,
    ): Proposal? {
        fun entry(exerciseId: String, sets: List<SetTarget>) =
            SyncEntry(Id(exerciseId, SyncExercise), sets.takeIf { it.isNotEmpty() }?.map { SyncTarget(it.reps, it.weightKg) })
        val proposed = if (intent == ProposalIntent.Remove) emptyList()
            else changes.filter { it.kind != ChangeKind.Removed }.map { entry(it.exerciseId, it.after!!.sets) }
        val diff = ProposalRules.changesBetween(routine.entries.map { entry(it.exerciseId, it.sets) }, proposed)
        fun slot(value: Json) = Json.array(value, Json.Null)
        val written = Json.objectOf("t" to Json.of("proposal"), "id" to Json.of(id), "born" to Json.Null,
            "life" to Json.array(Json.of("alive"), Json.Null), "f" to Json.objectOf(
                "routineId" to slot(Json.of(routine.id)), "intent" to slot(Json.of(intent.wire)),
                "proposedName" to slot(Json.of(if (intent == ProposalIntent.Remove) "" else routine.name)),
                "summary" to slot(Json.of(summary)), "changes" to slot(Json.Arr(diff.map { it.json })),
                "door" to slot(Json.of(door)), "connection" to slot(Json.of("")), "agent" to slot(Json.of(agent))))
        val reply = server.call(ServerCall(room.selected!!, null, "propose", Json.objectOf(),
            listOf(Json.objectOf("scope" to Json.of("self/gym"), "d" to Json.array(written)))), room.now)
        assertEquals(Json.of("ok"), reply?.get("s"))
        if (!pull) return null
        room.pull(server)
        val held = runBlocking { room.training.proposal(id) }
        assertEquals(changes, held?.changes)
        return held
    }

    // The proposal decisions waiting on this phone for the server.
    private fun decisions(room: EngineRoomFixture) = room.outbox().mapNotNull { it["intent"]?.get("cmd")?.get("name")?.str() }
        .filter { it == "gym.applyProposal" || it == "gym.dismissProposal" }

    // A decision waits for the server's receipt: the phone syncs, and the sheet hears back. Answers the
    // instant the server settled it.
    private fun receipt(room: EngineRoomFixture, server: ModelServer, decided: List<Proposal>): Long {
        val at = compose.runOnIdle { room.now.also { room.sync(server) } }
        compose.waitUntil(5_000) {
            shadowOf(Looper.getMainLooper()).idle()
            decided.isNotEmpty()
        }
        return at
    }

    private fun retarget(exerciseId: String, position: Int) = ProposalChange(
        position = position, kind = ChangeKind.Retargeted, exerciseId = exerciseId,
        before = ProposalTargets(List(3) { SetTarget(5) }), after = ProposalTargets(List(5) { SetTarget(3) }))

    private fun kept(exerciseId: String, position: Int, sets: List<SetTarget> = List(3) { SetTarget(8) }) = ProposalChange(
        position = position, kind = ChangeKind.Kept, exerciseId = exerciseId,
        before = ProposalTargets(sets), after = ProposalTargets(sets))

    // Sixteen movements of the catalogue, none of them the bench press.
    private val movements = SeedExercises.all.map { it.id.record.string!! }.filterNot { it == "bench-press" }.take(16)

    private val ramp = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0))

    // The review fixture: the ramp's shape held and set 4 moved.
    private fun setFourMoved() = ProposalChange(
        position = 1, kind = ChangeKind.Retargeted, exerciseId = "back-squat",
        before = ProposalTargets(ramp),
        after = ProposalTargets(ramp.mapIndexed { at, set -> if (at == 3) SetTarget(1, 102.5) else set }))

    private fun reshaped() = ProposalChange(
        position = 1, kind = ChangeKind.Retargeted, exerciseId = "back-squat",
        before = ProposalTargets(List(5) { SetTarget(5, 80.0) }),
        after = ProposalTargets(ramp))

    // A row as the bridge reads it: every text on the merged node, in order.
    private fun rowSaying(text: String): List<String> =
        compose.onNode(hasText(text, substring = true)).fetchSemanticsNode().config[SemanticsProperties.Text].map { it.text }

    // Every property the bridge turns into speech: a node's own text, its description, and the state
    // it announces with it.
    private fun saying(sentence: String) = SemanticsMatcher("says “$sentence”") { node ->
        val said = node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } +
            node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty() +
            listOfNotNull(node.config.getOrNull(SemanticsProperties.StateDescription))
        sentence in said
    }

    private fun sheet(store: TrainingStore, routine: Routine, decided: MutableList<Proposal>, heightDp: Int = 900) {
        compose.setContent {
            Box(Modifier.height(heightDp.dp)) {
                ReviewSheet(
                    proposalId = "proposal1",
                    routineId = routine.id,
                    store = store,
                    onAsk = null,
                    onDecided = { decided += it },
                )
            }
        }
    }

    @Test
    fun turningAProposalDownIsConfirmedInThePinnedWordsAndKeepingItDecidesNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = listOf(retarget("bench-press", 1))
        val routine = routineFor(room, server, "Push Day", changes)
        propose(room, server, routine, changes)
        val decided = mutableListOf<Proposal>()
        sheet(room.store, routine, decided)

        compose.onNodeWithText("Turn this down?").assertDoesNotExist()
        compose.onNodeWithText("Turn this down").performClick()
        compose.onNodeWithText("Turn this down?").assertIsDisplayed()
        compose.onNodeWithText("Nothing changes.")
            .assertIsDisplayed()

        compose.onNode(hasText("Keep it") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithText("Turn this down?").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("closing the dialog decides nothing", emptyList<String>(), decisions(room))
        }

        compose.onNodeWithText("Turn this down").performClick()
        compose.onNode(hasText("Turn down") and hasAnyAncestor(isDialog())).performClick()
        compose.runOnIdle {
            assertEquals("the confirmed tap is the one that settles it", listOf("gym.dismissProposal"), decisions(room))
        }
        receipt(room, server, decided)
        compose.runOnIdle {
            assertEquals(ProposalState.Dismissed, runBlocking { room.training.proposal("proposal1") }?.state)
            assertEquals("the receipt is the server's reply", listOf("Turned down · nothing changed."),
                decided.map { it.receipt })
        }
        scope.cancel()
    }

    @Test
    fun applyIsUnreachableUntilTheDiffHasBeenSeenToItsEndAndTheBandHoldsOneButton() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = movements.take(12).mapIndexed { at, id -> retarget(id, at + 1) }
        val routine = routineFor(room, server, "Push Day", changes)
        propose(room, server, routine, changes)
        val decided = mutableListOf<Proposal>()
        sheet(room.store, routine, decided, heightDp = 360)

        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsDisplayed()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsNotEnabled()
        compose.onNodeWithText("Apply all 12").assertIsDisplayed()
        compose.onNodeWithText("Later").assertDoesNotExist()
        compose.onNodeWithText("Turn this down").assertIsDisplayed()

        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).performClick()

        compose.runOnIdle { assertEquals(listOf("gym.applyProposal"), decisions(room)) }
        receipt(room, server, decided)
        compose.runOnIdle { assertEquals(listOf("Applied · Push Day · 12 changes"), decided.map { it.receipt }) }
        scope.cancel()
    }

    @Test
    fun aShortDiffFitsWithoutScrollingAndApplyIsLiveAtOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = listOf(retarget("bench-press", 1))
        val routine = routineFor(room, server, "Push Day", changes)
        // No model prose, so no kicker: the diff is one counted row and fits the window whole.
        propose(room, server, routine, changes, summary = "")
        sheet(room.store, routine, mutableListOf())

        compose.onNodeWithText("Coach wrote:").assertDoesNotExist()
        compose.onNodeWithText("1 change to Push Day.").assertIsDisplayed()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()
        scope.cancel()
    }

    // The larger proposal is written after the shorter one on the same routine, so the server sets the
    // shorter one aside the moment the larger lands.
    @Test
    fun aLaterLargerProposalMustBeReadToItsOwnEndBeforeItCanBeApplied() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val twelve = movements.take(12)
        val shortChanges = listOf(retarget("bench-press", 1)) + twelve.mapIndexed { at, id -> kept(id, at + 2, List(3) { SetTarget(5) }) }
        val largerChanges = listOf(kept("bench-press", 1, List(3) { SetTarget(5) })) + twelve.mapIndexed { at, id -> retarget(id, at + 2) }
        val routine = routineFor(room, server, "Push Day", shortChanges)
        propose(room, server, routine, shortChanges, summary = "")
        val opened = mutableStateOf("proposal1")
        val decided = mutableListOf<Proposal>()
        compose.setContent {
            Box(Modifier.height(540.dp)) {
                ReviewSheet(opened.value, routine.id, room.store, null, { decided += it })
            }
        }
        compose.onNodeWithText("Apply").assertIsEnabled()
        val larger = compose.runOnIdle {
            propose(room, server, routine, largerChanges, id = "proposal2")!!.also { opened.value = it.id }
        }
        compose.onNodeWithText("Apply all 12").assertIsNotEnabled().performClick()
        compose.runOnIdle {
            assertEquals(emptyList<Proposal>(), decided)
            assertEquals(emptyList<String>(), decisions(room))
        }
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText("Apply all 12").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf("gym.applyProposal"), decisions(room)) }
        val at = receipt(room, server, decided)
        compose.runOnIdle {
            assertEquals(listOf(larger.copy(state = ProposalState.Applied, settledAtMs = at)), decided)
            assertEquals(ProposalState.Superseded, runBlocking { room.training.proposal("proposal1") }?.state)
        }
        scope.cancel()
    }

    @Test
    fun startingAWorkoutRemovesBothDecisionActionsUntilThatWorkoutFinishes() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = listOf(retarget("bench-press", 1))
        val routine = routineFor(room, server, "Push Day", changes)
        val pending = propose(room, server, routine, changes, summary = "")!!
        val store = room.store
        val decided = mutableListOf<Proposal>()
        sheet(store, routine, decided)
        compose.onNodeWithText("Apply").assertIsEnabled()
        val live = compose.runOnIdle { runBlocking { (store.start(routine.id) as GymResult.Ok).value } }
        compose.onNodeWithText("Finish this session").assertIsDisplayed()
        compose.onNodeWithText("Apply").assertDoesNotExist()
        compose.onNodeWithText("Turn this down").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(live, store.session)
            assertEquals(pending, runBlocking { room.training.proposal("proposal1") })
            assertEquals(emptyList<Proposal>(), decided)
            assertEquals(emptyList<String>(), decisions(room))
            runBlocking { assertTrue(store.finish() is FinishOutcome.Closed) }
        }
        compose.onNodeWithText("Finish this session").assertDoesNotExist()
        compose.onNodeWithText("Apply").assertIsEnabled()
        compose.onNodeWithText("Turn this down").assertIsEnabled()
        compose.runOnIdle { assertEquals(pending, runBlocking { room.training.proposal("proposal1") }) }
        scope.cancel()
    }

    @Test
    fun keptRowsCollapseToACountWhereTheyStandAndTheProseSitsUnderItsKicker() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = listOf(
            kept("back-squat", 1),
            kept("deadlift", 2),
            retarget("bench-press", 3),
            kept("chin-up", 4),
        )
        val routine = routineFor(room, server, "Push Day", changes)
        propose(room, server, routine, changes)
        sheet(room.store, routine, mutableListOf())

        compose.onNodeWithText("Coach wrote:").assertIsDisplayed()
        compose.onNodeWithText("Heavier triples.").assertIsDisplayed()
        compose.onNodeWithText("and 2 lines unchanged").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("and 1 line unchanged").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Back Squat").assertDoesNotExist()
        compose.onNodeWithText("Chin Up").assertDoesNotExist()

        compose.onNodeWithText("and 2 lines unchanged").assert(hasStateDescription("collapsed"))
        compose.onNodeWithText("and 2 lines unchanged").performScrollTo().performClick()
        compose.onNodeWithText("and 2 lines unchanged").assert(hasStateDescription("expanded"))
        compose.onNodeWithText("Back Squat").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Deadlift").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Chin Up").assertDoesNotExist()
        scope.cancel()
    }

    @Test
    fun theKickerNamesTheAgentThatWroteOverMcpAndNeverCallsItCoach() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = listOf(retarget("bench-press", 1))
        val routine = routineFor(room, server, "Push Day", changes)
        propose(room, server, routine, changes, door = "mcp", agent = "Claude Desktop")
        sheet(room.store, routine, mutableListOf())

        compose.onNodeWithText("Claude Desktop wrote:").assertIsDisplayed()
        compose.onNodeWithText("from Claude Desktop · ", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Coach wrote:").assertDoesNotExist()
        scope.cancel()
    }

    // The gate says WHY it is shut on the control that is refusing — the channel TalkBack reads —
    // and its slot is held open in BOTH directions, including the return, when a kept run unfolding
    // re-locks `seen`, so Apply never moves under the finger. Driven off `seen` ALONE: bound to the
    // disabled predicate the sentence would still be standing while the apply request was on the
    // wire. What the eye reads is the drawn row, which is off the semantics tree in both states and
    // measured by the slot it holds (`LargestTypeTests`).
    @Test
    fun theShutGateSaysWhyItIsShutAndItsSlotHoldsApplyStillWhenTheGateOpens() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = movements.take(10).mapIndexed { at, id -> retarget(id, at + 1) } +
            movements.drop(10).mapIndexed { at, id -> kept(id, at + 11) }
        val routine = routineFor(room, server, "Push Day", changes)
        propose(room, server, routine, changes)
        sheet(room.store, routine, mutableListOf(), heightDp = 360)

        val shut = compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).getUnclippedBoundsInRoot()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assert(hasStateDescription(Proposal.applyHint))

        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()
        assertEquals("the slot is held: Apply does not move when the gate opens",
            shut, compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).getUnclippedBoundsInRoot())
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription))

        // And it comes BACK: what grew has not been seen, so the reason returns with the gate.
        compose.onNodeWithText("and 6 lines unchanged").performScrollTo().performClick()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsNotEnabled()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assert(hasStateDescription(Proposal.applyHint))
        assertEquals("and the slot is held in that direction too",
            shut, compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).getUnclippedBoundsInRoot())
        scope.cancel()
    }

    // `4m`: ONE fact, ONE node. A reader walking the shut band met the refusal twice in a row on this
    // phone — on Apply's state and again on the drawn row beneath it — where the web hides its row
    // with `aria-hidden`. The count is taken over every property a
    // screen reader speaks, on the MERGED tree, which is the tree the accessibility bridge walks.
    @Test
    fun theShutBandExposesTheGatesRefusalOnExactlyOneNode() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = movements.take(10).mapIndexed { at, id -> retarget(id, at + 1) }
        val routine = routineFor(room, server, "Push Day", changes)
        propose(room, server, routine, changes)
        sheet(room.store, routine, mutableListOf(), heightDp = 360)

        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsNotEnabled()
        val saying = compose.onAllNodes(saying(Proposal.applyHint)).fetchSemanticsNodes()
        assertEquals("the shut band's merged tree:\n${compose.onRoot().printToString()}",
            1, saying.size)
        assertEquals("and the one node is the control that is refusing",
            listOf("Apply all 10"), saying.single().config[SemanticsProperties.Text].map { it.text })

        // Open, nothing says it at all: the reason is gone from the state as well as from the row.
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()
        assertEquals(0, compose.onAllNodes(saying(Proposal.applyHint)).fetchSemanticsNodes().size)
        scope.cancel()
    }

    // Read off `seen` ALONE and never off the disabled predicate: Apply is dim while the apply waits
    // for the server's receipt too, and a sentence bound to THAT would be telling a lifter to read
    // further while the write was already going.
    @Test
    fun theGateSentenceIsGoneWhileTheApplyIsInFlightThoughApplyIsStillDim() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = movements.take(12).mapIndexed { at, id -> retarget(id, at + 1) }
        val routine = routineFor(room, server, "Push Day", changes)
        propose(room, server, routine, changes)
        val decided = mutableListOf<Proposal>()
        sheet(room.store, routine, decided, heightDp = 360)

        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).performClick()

        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsNotEnabled()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription))

        receipt(room, server, decided)
        compose.runOnIdle { assertEquals(listOf("Applied · Push Day · 12 changes"), decided.map { it.receipt }) }
        scope.cancel()
    }

    // The promise sits in the band between Apply and turning down — never below the turn-down row, and never in the scrolling body where it scrolls away.
    @Test
    fun theAtomicPromiseStandsInTheBandBetweenApplyAndTurningDown() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = listOf(retarget("bench-press", 1), retarget("chin-up", 2))
        val routine = routineFor(room, server, "Push Day", changes)
        propose(room, server, routine, changes)
        sheet(room.store, routine, mutableListOf())

        val promise = "All two or none. Nothing is applied until you tap."
        compose.onNodeWithText(promise).assertIsDisplayed()
        val apply = compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).getUnclippedBoundsInRoot()
        val line = compose.onNodeWithText(promise).getUnclippedBoundsInRoot()
        val turnDown = compose.onNodeWithText(Proposal.turnDownVerb).getUnclippedBoundsInRoot()
        assertTrue("under Apply", apply.bottom <= line.top)
        assertTrue("and above turning down", line.bottom <= turnDown.top)
        scope.cancel()
    }

    // What grew has not been seen: a kept run opening below the fold takes Apply away again.
    @Test
    fun expandingAKeptRunTakesApplyAwayUntilTheEndIsSeenAgain() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = movements.take(10).mapIndexed { at, id -> retarget(id, at + 1) } +
            movements.drop(10).mapIndexed { at, id -> kept(id, at + 11) }
        val routine = routineFor(room, server, "Push Day", changes)
        propose(room, server, routine, changes)
        sheet(room.store, routine, mutableListOf(), heightDp = 360)

        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsNotEnabled()
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()

        compose.onNodeWithText("and 6 lines unchanged").performScrollTo().performClick()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsNotEnabled()
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()
        scope.cancel()
    }

    // A scheme whose shape held and whose one set moved prints that set, as one row, and it is no
    // door: a week's progression on a top set is one line.
    @Test
    fun oneMovedSetPrintsAsOneRowThatDoesNotUnfold() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = listOf(setFourMoved())
        val lowerA = routineFor(room, server, "Lower A", changes)
        propose(room, server, lowerA, changes, summary = "")
        sheet(room.store, lowerA, mutableListOf())

        compose.onNodeWithText("1 change to Lower A.").assertIsDisplayed()
        compose.onNodeWithText("Back Squat").assertIsDisplayed()
        assertEquals(listOf("set 4 · 100 × 1 → 102.5 × 1"), rowSaying("set 4"))
        compose.onNode(hasText("set 4 · 100 × 1 → 102.5 × 1")).assertHasNoClickAction()
        compose.onAllNodes(hasText("sets")).assertCountEquals(0)
        compose.onAllNodes(hasText(Readout.ladder(setFourMoved().after!!.sets))).assertCountEquals(0)
        scope.cancel()
    }

    // A scheme that changed shape prints both schemes in the readout formula and unfolds on tap to
    // the two ladders, set by set, what stands against what is proposed — folded until the tap,
    // because the card above is the skim and this is the document.
    @Test
    fun aReshapedSchemePrintsTheReadoutAndUnfoldsToBothLaddersOnTap() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = listOf(reshaped())
        val lowerA = routineFor(room, server, "Lower A", changes)
        propose(room, server, lowerA, changes, summary = "")
        sheet(room.store, lowerA, mutableListOf())

        assertEquals(listOf("5 × 5 · 80kg → 5 × 1–5 · 60–100kg"), rowSaying("5 × 5 · 80kg →"))
        compose.onNode(hasStateDescription("collapsed") or hasStateDescription("expanded")).assert(hasStateDescription("collapsed"))
        compose.onAllNodes(hasText("set 1")).assertCountEquals(0)

        compose.onNode((hasStateDescription("collapsed") or hasStateDescription("expanded")) and hasClickAction()).performClick()
        compose.onNode(hasStateDescription("collapsed") or hasStateDescription("expanded")).assert(hasStateDescription("expanded"))
        assertEquals(listOf("set 1 · 80 × 5 → 60 × 5"), rowSaying("set 1"))
        assertEquals(listOf("set 3 · 80 × 5 → 90 × 3"), rowSaying("set 3"))
        assertEquals(listOf("set 4 · 80 × 5 → 100 × 1"), rowSaying("set 4"))
        assertEquals(listOf("set 5 · 80 × 5 → 80 × 5"), rowSaying("set 5"))
        compose.onAllNodes(hasText("set 6")).assertCountEquals(0)

        compose.onNode((hasStateDescription("collapsed") or hasStateDescription("expanded")) and hasClickAction()).performClick()
        compose.onAllNodes(hasText("set 1")).assertCountEquals(0)
        scope.cancel()
    }

    // A ladder that grew: the side with no such set reads `—`.
    @Test
    fun anUnfoldedLadderReadsADashWhereASideHasNoSet() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val grown = ProposalChange(
            position = 1, kind = ChangeKind.Retargeted, exerciseId = "back-squat",
            before = ProposalTargets(List(3) { SetTarget(5, 80.0) }),
            after = ProposalTargets(ramp))
        val lowerA = routineFor(room, server, "Lower A", listOf(grown))
        propose(room, server, lowerA, listOf(grown), summary = "")
        sheet(room.store, lowerA, mutableListOf())

        compose.onNode((hasStateDescription("collapsed") or hasStateDescription("expanded")) and hasClickAction()).performClick()
        assertEquals(listOf("set 3 · 80 × 5 → 90 × 3"), rowSaying("set 3"))
        assertEquals(listOf("set 4 · — → 100 × 1"), rowSaying("set 4"))
        assertEquals(listOf("set 5 · — → 80 × 5"), rowSaying("set 5"))
        scope.cancel()
    }

    @Test
    fun theCardCarriesOneAffordanceAndReadsStillWaitingAfterAReviewDecidedNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = listOf(retarget("bench-press", 1), retarget("deadlift", 2))
        val routine = routineFor(room, server, "Push Day", changes)
        val waiting = propose(room, server, routine, changes)!!
        val doors = mutableListOf<String>()
        compose.setContent {
            ProposalCard(waiting, "Push Day", nowMs = 2_000, stillWaiting = true, onReview = { doors += "review" })
        }

        compose.onNodeWithText("Later").assertDoesNotExist()
        // The card is addressed by the routine it is about; who wrote it is the sheet's byline.
        compose.onNodeWithText("Proposal · Push Day").assertIsDisplayed()
        compose.onNodeWithText("Proposal · Coach").assertDoesNotExist()
        compose.onNodeWithText("Heavier triples.").assertIsDisplayed()
        compose.onNodeWithText("2 changes · still waiting").assertIsDisplayed()
        compose.onNodeWithText("Review").performClick()
        compose.runOnIdle { assertEquals(listOf("review"), doors) }
        scope.cancel()
    }

    @Test
    fun aLongRoutineNameWrapsWithoutLosingTheReviewAction() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = listOf(retarget("bench-press", 1))
        val routine = routineFor(room, server, "Push Day", changes)
        val waiting = propose(room, server, routine, changes)!!
        val long = "Push day, heavy singles, then the long accessory block"
        val opened = mutableListOf<String>()
        compose.setContent {
            Box(Modifier.width(320.dp)) {
                ProposalCard(waiting, long, nowMs = 2_000, stillWaiting = true, onReview = { opened += waiting.id })
            }
        }
        compose.onNodeWithText("Proposal · $long").assertIsDisplayed()
        compose.onNodeWithText("Review").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf(waiting.id), opened) }
        scope.cancel()
    }

    @Test
    fun anUnpulledProposalShowsNoDiffOrDecisionAndReadsWhenReopenedAfterPull() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = listOf(retarget("bench-press", 1))
        val routine = routineFor(room, server, "Push Day", changes)
        propose(room, server, routine, changes, summary = "Exact server prose.", pull = false)
        val program = room.store.allRoutines
        val decided = mutableListOf<Proposal>()
        val visit = mutableStateOf(0)
        compose.setContent {
            key(visit.value) {
                Box(Modifier.height(900.dp)) {
                    ReviewSheet("proposal1", routine.id, room.store, null, { decided += it })
                }
            }
        }
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        compose.onNodeWithText("Exact server prose.").assertDoesNotExist()
        compose.onNodeWithText("Apply").assertDoesNotExist()
        compose.onNodeWithText("Turn this down").assertDoesNotExist()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.runOnIdle { room.pull(server); visit.value++ }
        compose.onNodeWithText("Exact server prose.").assertIsDisplayed()
        compose.onNodeWithText("Apply").assertIsEnabled()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(program, room.store.allRoutines)
            assertEquals(ProposalState.Pending, runBlocking { room.training.proposal("proposal1") }?.state)
            assertEquals(emptyList<Proposal>(), decided)
            assertEquals(emptyList<String>(), decisions(room))
        }
        scope.cancel()
    }

    @Test
    fun removingAWholeRoutineExplainsTheScopeAndKeepsItsEntirePerformedLog() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val store = room.store
        val removal = listOf(ProposalChange(position = 1, kind = ChangeKind.Removed, exerciseId = "bench-press",
            before = ProposalTargets(List(3) { SetTarget(5) }), loggedSets = 2))
        val routine = routineFor(room, server, "Push Day", removal)
        val closed = runBlocking {
            assertTrue(store.start(routine.id) is GymResult.Ok)
            store.choose("bench-press")
            store.logSet(20.0, 8, SetKind.Warmup)
            store.logSet(60.0, 5)
            (store.finish() as FinishOutcome.Closed).detail
        }
        assertEquals(listOf(Triple(SetKind.Warmup, 20.0, 8), Triple(SetKind.Working, 60.0, 5)),
            closed.sets.map { Triple(it.kind, it.weightKg, it.reps) })
        room.sync(server)
        val history = room.training.details()
        val confirmed = history.single { it.session.id == closed.session.id }
        val pending = propose(room, server, routine, removal, summary = "Remove this routine from the program.",
            intent = ProposalIntent.Remove)!!
        val decided = mutableListOf<Proposal>()
        val displayed = mutableStateOf(store)
        compose.setContent {
            key(displayed.value) {
                Box(Modifier.height(900.dp)) {
                    ReviewSheet(pending.id, routine.id, displayed.value, null, { decided += it })
                }
            }
        }
        compose.onNode(hasText("Remove Push Day") and !hasClickAction()).assertIsDisplayed()
        compose.onNodeWithText("The whole routine is removed from your program. Every set you logged against it stays in the log.")
            .assertIsDisplayed()
        compose.waitUntil { store.logged.any { it.id == closed.session.id } }
        val logged = store.logged
        compose.onNode(hasText("Remove Push Day") and hasClickAction()).assertIsEnabled().performClick()
        receipt(room, server, decided)
        compose.runOnIdle {
            assertEquals(listOf(pending.copy(state = ProposalState.Applied)), decided)
            assertEquals(emptyList<Routine>(), store.allRoutines)
            assertEquals(emptyList<Routine>(), room.training.program())
            assertEquals(history, room.training.details())
            assertEquals(logged, store.logged)
            runBlocking { assertEquals(GymResult.Ok(confirmed), store.sessionDetail(closed.session.id)) }
            runBlocking { assertEquals(ProposalRead.Found(decided.single()), store.proposal(pending.id)) }
        }
        compose.onNode(hasText("Remove Push Day") and hasClickAction()).assertDoesNotExist()
        compose.onNodeWithText("Turn this down").assertDoesNotExist()
        compose.onNodeWithText(requireNotNull(decided.single().receipt)).assertIsDisplayed()
        val cold = EngineRoomFixture(room.directory, scope, room.engine.snapshot(), rest = FakeGymRest()).also { rooms += it }
        compose.runOnIdle {
            runBlocking {
                cold.selected = "u1"
                cold.store.connect(cold.account())
                assertEquals(ProposalRead.Gone, cold.store.proposal(pending.id))
            }
            displayed.value = cold.store
        }
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithText("Coach wrote:").assertDoesNotExist()
        compose.onNodeWithText("Remove Push Day").assertDoesNotExist()
        compose.onNodeWithText(requireNotNull(decided.single().receipt)).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(history, cold.training.details())
            assertEquals(logged, cold.store.logged)
        }
        scope.cancel()
    }

    @Test
    fun theEnginesSupersededRefusalReachesTheSheetWithoutAReceipt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val changes = listOf(retarget("bench-press", 1))
        val routine = routineFor(room, server, "Push Day", changes)
        propose(room, server, routine, changes, summary = "")
        val decided = mutableListOf<Proposal>()
        sheet(room.store, routine, decided)
        EngineRoomFixture(tmp.newFolder(), scope).use { other ->
            runBlocking {
                other.select("u1"); other.pull(server)
                val held = other.training.program().single()
                assertTrue(other.store.saveRoutine(RoutineDraft.of(held).named("Push Day B")) is GymResult.Ok)
                other.sync(server)
            }
        }
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).performClick()
        compose.runOnIdle { room.sync(server) }
        compose.waitUntil(5_000) {
            shadowOf(Looper.getMainLooper()).idle()
            compose.onAllNodes(hasText("That proposal has been replaced.")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("That proposal has been replaced.").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<Proposal>(), decided) }
        scope.cancel()
    }

    // A VERDICT, not a row: `superseded` is decided against the routine as the ACCOUNT holds it, so a
    // window taking the row off the routines home may not make a proposal decidable again. Reached by
    // deleting a routine and opening the same proposal from the Coach tab inside the nine seconds.
    @Test
    fun anOpenProposalStaysSupersededWhileAWindowHoldsItsChangedRoutine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        val room = signedIn(scope)
        val store = room.store
        val changes = listOf(retarget("bench-press", 1))
        val routine = routineFor(room, server, "Push Day", changes)
        propose(room, server, routine, changes)
        sheet(store, routine, mutableListOf())
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()
        val edited = runBlocking {
            (store.saveRoutine(RoutineDraft.of(routine).named("Push Day B")) as GymResult.Ok).value.also {
                room.sync(server)
                store.refreshEngine()
            }
        }
        assertEquals(ProposalState.Superseded, runBlocking { room.training.proposal("proposal1") }?.state)
        assertEquals(2, store.allRoutines.single().revision)

        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText(supersededSentence).assertIsDisplayed()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertDoesNotExist()

        compose.runOnIdle { store.withhold(Deletion.Routine(edited.id, edited.name)) }

        compose.runOnIdle {
            assertEquals("the row is off the routines home", emptyList<String>(),
                         store.routines.map { it.id })
            assertEquals("and the program still holds the revision this is judged against",
                         listOf(edited.id), store.allRoutines.map { it.id })
        }
        compose.onNodeWithText(supersededSentence).assertIsDisplayed()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertDoesNotExist()
        scope.cancel()
    }

}

private const val supersededSentence =
    "This routine has changed since the proposal was written, so it can no longer be applied — nothing here was. What the routine now says is what stands."
