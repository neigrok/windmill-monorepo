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
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
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
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalSource
import works.windmill.gym.domain.ProposalIntent
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.SetKind
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.ProposalRead
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class ReviewSheetTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun store(scope: CoroutineScope, server: TrainingSyncing, routine: String = "Push Day"): Pair<TrainingStore, Routine> {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { server },
        )
        val kept = runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam"),
            ))
            (store.saveRoutine(RoutineDraft(name = routine).adding("bench-press")) as GymResult.Ok).value
        }
        return store to kept
    }

    private fun retarget(exerciseId: String, position: Int) = ProposalChange(
        position = position, kind = ChangeKind.Retargeted, exerciseId = exerciseId,
        before = ProposalTargets(List(3) { SetTarget(5) }), after = ProposalTargets(List(5) { SetTarget(3) }))

    private fun kept(exerciseId: String, position: Int) = ProposalChange(
        position = position, kind = ChangeKind.Kept, exerciseId = exerciseId,
        before = ProposalTargets(List(3) { SetTarget(8) }), after = ProposalTargets(List(3) { SetTarget(8) }))

    private fun proposal(
        routine: Routine,
        changes: List<ProposalChange>,
        summary: String = "Heavier triples.",
        source: ProposalSource = ProposalSource(door = "ask"),
    ) = Proposal(
        id = "prop_1", routineId = routine.id, state = ProposalState.Pending,
        summary = summary, changeCount = changes.count { it.kind != ChangeKind.Kept }, createdAtMs = 1_000,
        source = source, baseRevision = routine.revision,
        baseName = routine.name, name = routine.name, changes = changes,
    )

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
                    proposalId = "prop_1",
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
        val server = FakeTraining()
        val (store, kept) = store(scope, server)
        server.propose(proposal(kept, listOf(retarget("bench-press", 1))))
        val decided = mutableListOf<Proposal>()
        sheet(store, kept, decided)

        compose.onNodeWithText("Turn this down?").assertDoesNotExist()
        compose.onNodeWithText("Turn this down").performClick()
        compose.onNodeWithText("Turn this down?").assertIsDisplayed()
        compose.onNodeWithText("Nothing changes.")
            .assertIsDisplayed()

        compose.onNode(hasText("Keep it") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithText("Turn this down?").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals("closing the dialog decides nothing",
                emptyList<String>(), server.calls.filter { it == "dismissProposal" })
        }

        compose.onNodeWithText("Turn this down").performClick()
        compose.onNode(hasText("Turn down") and hasAnyAncestor(isDialog())).performClick()
        compose.runOnIdle {
            assertEquals("the confirmed tap is the one that settles it",
                listOf("dismissProposal"), server.calls.filter { it == "dismissProposal" })
            assertEquals(ProposalState.Dismissed, server.ledger.getValue("prop_1").state)
            assertEquals("the receipt is the server's reply", listOf("Turned down · nothing changed."),
                decided.map { it.receipt })
        }
        scope.cancel()
    }

    @Test
    fun applyIsUnreachableUntilTheDiffHasBeenSeenToItsEndAndTheBandHoldsOneButton() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (store, kept) = store(scope, server)
        server.propose(proposal(kept, (1..12).map { retarget("ex-$it", it) }))
        val decided = mutableListOf<Proposal>()
        sheet(store, kept, decided, heightDp = 360)

        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsDisplayed()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsNotEnabled()
        compose.onNodeWithText("Apply all 12").assertIsDisplayed()
        compose.onNodeWithText("Later").assertDoesNotExist()
        compose.onNodeWithText("Turn this down").assertIsDisplayed()

        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).performClick()

        compose.runOnIdle {
            assertEquals(listOf("applyProposal"), server.calls.filter { it == "applyProposal" })
            assertEquals(listOf("Applied · Push Day · 12 changes"), decided.map { it.receipt })
        }
        scope.cancel()
    }

    @Test
    fun aShortDiffFitsWithoutScrollingAndApplyIsLiveAtOnce() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (store, kept) = store(scope, server)
        // No model prose, so no kicker: the diff is one counted row and fits the window whole.
        server.propose(proposal(kept, listOf(retarget("bench-press", 1)), summary = ""))
        sheet(store, kept, mutableListOf())

        compose.onNodeWithText("Coach wrote:").assertDoesNotExist()
        compose.onNodeWithText("1 change to Push Day.").assertIsDisplayed()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()
        scope.cancel()
    }

    @Test
    fun aLaterLargerProposalMustBeReadToItsOwnEndBeforeItCanBeApplied() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val reply = CompletableDeferred<Unit>()
        val reads = mutableListOf<String>()
        val wire = object : TrainingSyncing by server {
            override suspend fun proposal(id: String): Proposal? {
                reads += id
                if (id == "prop_larger") reply.await()
                return server.proposal(id)
            }
        }
        val (store, routine) = store(scope, wire)
        val short = proposal(routine, listOf(retarget("bench-press", 1)), summary = "")
        val larger = proposal(routine, (1..12).map { retarget("ex-$it", it) }).copy(id = "prop_larger")
        server.propose(short)
        val opened = mutableStateOf(short.id)
        val decided = mutableListOf<Proposal>()
        compose.setContent {
            Box(Modifier.height(540.dp)) {
                ReviewSheet(opened.value, routine.id, store, null, { decided += it })
            }
        }
        compose.onNodeWithText("Apply").assertIsEnabled()
        compose.runOnIdle { server.propose(larger); opened.value = larger.id }
        compose.onNodeWithText("Apply").assertDoesNotExist()
        compose.onNodeWithText("Apply all 12").assertDoesNotExist()
        compose.runOnIdle { reply.complete(Unit) }
        compose.onNodeWithText("Apply all 12").assertIsNotEnabled().performClick()
        compose.runOnIdle {
            assertEquals(emptyList<Proposal>(), decided)
            assertEquals(emptyList<String>(), server.calls.filter { it == "applyProposal" })
            assertEquals(listOf(short.id, larger.id), reads)
        }
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText("Apply all 12").assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(listOf(larger.copy(state = ProposalState.Applied, settledAtMs = server.settledAtMs)), decided)
            assertEquals(short, server.ledger.getValue(short.id))
            assertEquals(listOf("applyProposal"), server.calls.filter { it == "applyProposal" })
        }
        scope.cancel()
    }

    @Test
    fun aFailedProposalReadOffersRetryWithoutInventingADiffOrMakingADecision() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val reply = CompletableDeferred<Unit>()
        var reads = 0
        val wire = object : TrainingSyncing by server {
            override suspend fun proposal(id: String): Proposal? {
                reads += 1
                if (reads == 1) throw IOException("no connection")
                reply.await()
                return server.proposal(id)
            }
        }
        val (store, routine) = store(scope, wire)
        val pending = proposal(routine, listOf(retarget("bench-press", 1)), summary = "Exact server prose.")
        server.propose(pending)
        val program = store.allRoutines
        val decided = mutableListOf<Proposal>()
        sheet(store, routine, decided)
        compose.onNodeWithText("the log didn’t answer — that proposal could not be read").assertIsDisplayed()
        compose.onNodeWithText("Exact server prose.").assertDoesNotExist()
        compose.onNodeWithText("Apply").assertDoesNotExist()
        compose.onNodeWithText("Turn this down").assertDoesNotExist()
        compose.onNodeWithText("Try again").performClick()
        compose.onNodeWithText("Apply").assertDoesNotExist()
        compose.runOnIdle { reply.complete(Unit) }
        compose.onNodeWithText("Exact server prose.").assertIsDisplayed()
        compose.onNodeWithText("Apply").assertIsEnabled()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(2, reads)
            assertEquals(program, store.allRoutines)
            assertEquals(mapOf(pending.id to pending), server.ledger)
            assertEquals(emptyList<Proposal>(), decided)
            assertEquals(emptyList<String>(), server.calls.filter { it in setOf("applyProposal", "dismissProposal") })
        }
        scope.cancel()
    }

    @Test
    fun startingAWorkoutRemovesBothDecisionActionsUntilThatWorkoutFinishes() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (store, routine) = store(scope, server)
        val pending = proposal(routine, listOf(retarget("bench-press", 1)), summary = "")
        server.propose(pending)
        val decided = mutableListOf<Proposal>()
        sheet(store, routine, decided)
        compose.onNodeWithText("Apply").assertIsEnabled()
        val live = compose.runOnIdle { runBlocking { (store.start(routine.id) as GymResult.Ok).value } }
        compose.onNodeWithText("Finish this session").assertIsDisplayed()
        compose.onNodeWithText("Apply").assertDoesNotExist()
        compose.onNodeWithText("Turn this down").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(live, store.session)
            assertEquals(mapOf(pending.id to pending), server.ledger)
            assertEquals(emptyList<Proposal>(), decided)
            assertEquals(emptyList<String>(), server.calls.filter { it in setOf("applyProposal", "dismissProposal") })
            runBlocking { assertTrue(store.finish() is FinishOutcome.Closed) }
        }
        compose.onNodeWithText("Finish this session").assertDoesNotExist()
        compose.onNodeWithText("Apply").assertIsEnabled()
        compose.onNodeWithText("Turn this down").assertIsEnabled()
        compose.runOnIdle { assertEquals(mapOf(pending.id to pending), server.ledger) }
        scope.cancel()
    }

    @Test
    fun removingAWholeRoutineExplainsTheScopeAndKeepsItsEntirePerformedLog() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (store, routine) = store(scope, server)
        val closed = runBlocking {
            assertTrue(store.start(routine.id) is GymResult.Ok)
            store.choose("bench-press")
            store.logSet(20.0, 8, SetKind.Warmup)
            store.logSet(60.0, 5)
            (store.finish() as FinishOutcome.Closed).detail
        }
        assertEquals(listOf(Triple(SetKind.Warmup, 20.0, 8), Triple(SetKind.Working, 60.0, 5)),
            closed.sets.map { Triple(it.kind, it.weightKg, it.reps) })
        val sessions = server.stored.toMap()
        val sets = server.sets.mapValues { it.value.toList() }
        val removal = proposal(routine, emptyList(), summary = "Remove this routine from the program.")
            .copy(intent = ProposalIntent.Remove, changeCount = 1)
        server.propose(removal)
        val decided = mutableListOf<Proposal>()
        val displayed = mutableStateOf(store)
        compose.setContent {
            key(displayed.value) {
                Box(Modifier.height(900.dp)) {
                    ReviewSheet(removal.id, routine.id, displayed.value, null, { decided += it })
                }
            }
        }
        compose.onNode(hasText("Remove Push Day") and !hasClickAction()).assertIsDisplayed()
        compose.onNodeWithText("The whole routine is removed from your program. Every set you logged against it stays in the log.")
            .assertIsDisplayed()
        compose.waitUntil { store.logged.any { it.id == closed.session.id } }
        val logged = store.logged
        compose.onNode(hasText("Remove Push Day") and hasClickAction()).assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(listOf(removal.copy(state = ProposalState.Applied, settledAtMs = server.settledAtMs)), decided)
            assertEquals(emptyList<Routine>(), store.allRoutines)
            assertEquals(emptyMap<String, Routine>(), server.written)
            assertEquals(sessions, server.stored)
            assertEquals(sets, server.sets)
            assertEquals(logged, store.logged)
            runBlocking { assertEquals(GymResult.Ok(closed), store.sessionDetail(closed.session.id)) }
            runBlocking { assertEquals(ProposalRead.Found(decided.single()), store.proposal(removal.id)) }
            assertEquals(emptyMap<String, Proposal>(), server.ledger)
            assertEquals(listOf("applyProposal"), server.calls.filter { it == "applyProposal" })
        }
        compose.onNode(hasText("Remove Push Day") and hasClickAction()).assertDoesNotExist()
        compose.onNodeWithText("Turn this down").assertDoesNotExist()
        compose.onNodeWithText(requireNotNull(decided.single().receipt)).assertIsDisplayed()
        val cold = TrainingStore(SetQueue(File(tmp.root, "queue.json")), DeviceCopy(File(tmp.root, "catalog.json")),
            LocalLog(File(tmp.root, "local.json")), LocalPreferences(File(tmp.root, "prefs.json")),
            LocalBodyweight(File(tmp.root, "bodyweight.json")), scope, sync = { server })
        compose.runOnIdle {
            runBlocking {
                cold.connect(Account(WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                    User("u1", "sam@example.com", "Sam")))
                assertEquals(ProposalRead.Gone, cold.proposal(removal.id))
            }
            displayed.value = cold
        }
        compose.onNodeWithText(ProposalRead.Gone.line).assertIsDisplayed()
        compose.onNodeWithText("Try again").assertDoesNotExist()
        compose.onNodeWithText("Coach wrote:").assertDoesNotExist()
        compose.onNodeWithText("Remove Push Day").assertDoesNotExist()
        compose.onNodeWithText(requireNotNull(decided.single().receipt)).assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(sessions, server.stored)
            assertEquals(sets, server.sets)
            assertEquals(logged, cold.logged)
        }
        scope.cancel()
    }

    @Test
    fun keptRowsCollapseToACountWhereTheyStandAndTheProseSitsUnderItsKicker() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (store, kept) = store(scope, server)
        server.propose(proposal(kept, listOf(
            kept("back-squat", 1),
            kept("deadlift", 2),
            retarget("bench-press", 3),
            kept("chin-up", 4),
        )))
        sheet(store, kept, mutableListOf())

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
        val server = FakeTraining()
        val (store, kept) = store(scope, server)
        server.propose(proposal(kept, listOf(retarget("bench-press", 1)),
            source = ProposalSource(door = "mcp", agent = "Claude Desktop")))
        sheet(store, kept, mutableListOf())

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
        val server = FakeTraining()
        val (store, kept) = store(scope, server)
        server.propose(proposal(kept, (1..10).map { retarget("ex-$it", it) } + (11..16).map { kept("kept-$it", it) }))
        sheet(store, kept, mutableListOf(), heightDp = 360)

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
    // phone — on Apply's state and again on the drawn row beneath it — where iOS hides its row with
    // `.accessibilityHidden` and the web with `aria-hidden`. The count is taken over every property a
    // screen reader speaks, on the MERGED tree, which is the tree the accessibility bridge walks.
    @Test
    fun theShutBandExposesTheGatesRefusalOnExactlyOneNode() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (store, kept) = store(scope, server)
        server.propose(proposal(kept, (1..10).map { retarget("ex-$it", it) }))
        sheet(store, kept, mutableListOf(), heightDp = 360)

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

    // Read off `seen` ALONE and never off the disabled predicate: Apply is dim while the apply is on
    // the wire too, and a sentence bound to THAT would be telling a lifter to read further while the
    // write was already going.
    @Test
    fun theGateSentenceIsGoneWhileTheApplyIsInFlightThoughApplyIsStillDim() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (store, kept) = store(scope, server)
        val inFlight = CompletableDeferred<Unit>()
        server.onApply = { inFlight.await() }
        server.propose(proposal(kept, (1..12).map { retarget("ex-$it", it) }))
        val decided = mutableListOf<Proposal>()
        sheet(store, kept, decided, heightDp = 360)

        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).performClick()

        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsNotEnabled()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription))

        inFlight.complete(Unit)
        compose.runOnIdle { assertEquals(listOf("Applied · Push Day · 12 changes"), decided.map { it.receipt }) }
        scope.cancel()
    }

    // The promise sits in the band between Apply and turning down, where iOS already draws it —
    // never below the turn-down row, and never in the scrolling body where it scrolls away.
    @Test
    fun theAtomicPromiseStandsInTheBandBetweenApplyAndTurningDown() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (store, kept) = store(scope, server)
        server.propose(proposal(kept, listOf(retarget("bench-press", 1), retarget("chin-up", 2))))
        sheet(store, kept, mutableListOf())

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
        val server = FakeTraining()
        val (store, kept) = store(scope, server)
        server.propose(proposal(kept, (1..10).map { retarget("ex-$it", it) } + (11..16).map { kept("kept-$it", it) }))
        sheet(store, kept, mutableListOf(), heightDp = 360)

        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsNotEnabled()
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()

        compose.onNodeWithText("and 6 lines unchanged").performScrollTo().performClick()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsNotEnabled()
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()
        scope.cancel()
    }

    // B13: the log's three reasons for a superseded proposal reach the refusal slot byte-exact, and so
    // does the dismiss variant. The sheet re-reads after each and offers the tap again.
    @Test
    fun theLogsOwnSupersededSentenceReachesTheRefusalSlotByteExact() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (store, kept) = store(scope, server)
        server.propose(proposal(kept, listOf(retarget("bench-press", 1)), summary = ""))
        sheet(store, kept, mutableListOf())
        fun superseded(sentence: String) =
            WindmillApiException.Refused(409, Refusal(message = sentence, code = "proposal-superseded"))

        listOf(
            "that routine changed after this proposal was written, so it was not applied",
            "a newer proposal replaced this one, so it was not applied",
            "this proposal was superseded before it was applied",
        ).forEach { sentence ->
            server.refuseApply = superseded(sentence)
            // The refusal line lengthens the band, so the diff's end is seen again before each tap.
            compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
            compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertIsEnabled()
            compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).performClick()
            compose.onNodeWithText(sentence).assertIsDisplayed()
        }
        compose.onNodeWithText("the routine moved after this was written", substring = true).assertDoesNotExist()

        server.refuseDismiss = superseded("a newer proposal replaced this one, so it was not turned down")
        compose.onNodeWithText("Turn this down").performClick()
        compose.onNode(hasText("Turn down") and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithText("a newer proposal replaced this one, so it was not turned down").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(ProposalState.Pending, server.ledger.getValue("prop_1").state)
        }
        scope.cancel()
    }

    // A scheme whose shape held and whose one set moved prints that set, as one row, and it is no
    // door: a week's progression on a top set is one line.
    @Test
    fun oneMovedSetPrintsAsOneRowThatDoesNotUnfold() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (store, lowerA) = store(scope, server, routine = "Lower A")
        server.propose(proposal(lowerA, listOf(setFourMoved()), summary = ""))
        sheet(store, lowerA, mutableListOf())

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
        val server = FakeTraining()
        val (store, lowerA) = store(scope, server, routine = "Lower A")
        server.propose(proposal(lowerA, listOf(reshaped()), summary = ""))
        sheet(store, lowerA, mutableListOf())

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
        val server = FakeTraining()
        val (store, lowerA) = store(scope, server, routine = "Lower A")
        val grown = ProposalChange(
            position = 1, kind = ChangeKind.Retargeted, exerciseId = "back-squat",
            before = ProposalTargets(List(3) { SetTarget(5, 80.0) }),
            after = ProposalTargets(ramp))
        server.propose(proposal(lowerA, listOf(grown), summary = ""))
        sheet(store, lowerA, mutableListOf())

        compose.onNode((hasStateDescription("collapsed") or hasStateDescription("expanded")) and hasClickAction()).performClick()
        assertEquals(listOf("set 3 · 80 × 5 → 90 × 3"), rowSaying("set 3"))
        assertEquals(listOf("set 4 · — → 100 × 1"), rowSaying("set 4"))
        assertEquals(listOf("set 5 · — → 80 × 5"), rowSaying("set 5"))
        scope.cancel()
    }

    @Test
    fun theCardCarriesOneAffordanceAndReadsStillWaitingAfterAReviewDecidedNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (_, kept) = store(scope, server)
        val waiting = proposal(kept, listOf(retarget("bench-press", 1), retarget("deadlift", 2)))
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
        val server = FakeTraining()
        val (_, kept) = store(scope, server)
        val waiting = proposal(kept, listOf(retarget("bench-press", 1)))
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


    // A VERDICT, not a row: `superseded` is decided against the routine as the ACCOUNT holds it, so a
    // window taking the row off the routines home may not make a proposal decidable again. Reached by
    // deleting a routine and opening the same proposal from the Coach tab inside the nine seconds.
    @Test
    fun aSupersededProposalStaysSupersededWhileAWindowHoldsItsRoutine() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (store, kept) = store(scope, server)
        server.propose(proposal(kept, listOf(retarget("bench-press", 1)))
            .copy(baseRevision = kept.revision - 1))
        sheet(store, kept, mutableListOf())

        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText(supersededSentence).assertIsDisplayed()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertDoesNotExist()

        compose.runOnIdle { store.withhold(Deletion.Routine(kept.id, kept.name)) }

        compose.runOnIdle {
            assertEquals("the row is off the routines home", emptyList<String>(),
                         store.routines.map { it.id })
            assertEquals("and the program still holds the revision this is judged against",
                         listOf(kept.id), store.allRoutines.map { it.id })
        }
        compose.onNodeWithText(supersededSentence).assertIsDisplayed()
        compose.onNode(hasText("Apply") or hasText("Apply all", substring = true)).assertDoesNotExist()
        scope.cancel()
    }
}

private const val supersededSentence =
    "This routine has changed since the proposal was written, so it can no longer be applied — nothing here was. What the routine now says is what stands."
