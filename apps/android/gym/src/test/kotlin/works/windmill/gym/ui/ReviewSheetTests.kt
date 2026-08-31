package works.windmill.gym.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
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
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
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

    private fun store(scope: CoroutineScope, server: FakeTraining): Pair<TrainingStore, Routine> {
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
            (store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) as GymResult.Ok).value
        }
        return store to kept
    }

    private fun retarget(exerciseId: String, position: Int) = ProposalChange(
        position = position, kind = ChangeKind.Retargeted, exerciseId = exerciseId,
        before = ProposalTargets(sets = 3, reps = 5), after = ProposalTargets(sets = 5, reps = 3))

    private fun kept(exerciseId: String, position: Int) = ProposalChange(
        position = position, kind = ChangeKind.Kept, exerciseId = exerciseId,
        before = ProposalTargets(sets = 3, reps = 8), after = ProposalTargets(sets = 3, reps = 8))

    private fun proposal(
        routine: Routine,
        changes: List<ProposalChange>,
        summary: String = "Heavier triples.",
        source: ProposalSource = ProposalSource(door = "ask"),
    ) = Proposal(
        id = "prop_1", routineId = routine.id, state = ProposalState.Pending,
        summary = summary, changeCount = changes.count { it.kind != ChangeKind.Kept }, createdAtMs = 1_000,
        source = source, baseRevision = routine.revision,
        baseName = "Push Day", name = "Push Day", changes = changes,
    )

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
        compose.onNodeWithText("Nothing changes, and it stays in the routine’s history as a record.")
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

        compose.onNodeWithText("Apply").assertIsDisplayed()
        compose.onNodeWithText("Apply").assertIsNotEnabled()
        compose.onNodeWithText("Apply all 12").assertDoesNotExist()
        compose.onNodeWithText("Later").assertDoesNotExist()
        compose.onNodeWithText("Turn this down").assertIsDisplayed()

        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText("Apply").assertIsEnabled()
        compose.onNodeWithText("Apply").performClick()

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
        compose.onNodeWithText("Apply").assertIsEnabled()
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
        compose.onNodeWithText("from Claude Desktop · ", substring = true).assertIsDisplayed()
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

        val shut = compose.onNodeWithText("Apply").getUnclippedBoundsInRoot()
        compose.onNodeWithText("Apply").assert(hasStateDescription(Proposal.applyHint))

        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText("Apply").assertIsEnabled()
        assertEquals("the slot is held: Apply does not move when the gate opens",
            shut, compose.onNodeWithText("Apply").getUnclippedBoundsInRoot())
        compose.onNodeWithText("Apply").assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription))

        // And it comes BACK: what grew has not been seen, so the reason returns with the gate.
        compose.onNodeWithText("and 6 lines unchanged").performScrollTo().performClick()
        compose.onNodeWithText("Apply").assertIsNotEnabled()
        compose.onNodeWithText("Apply").assert(hasStateDescription(Proposal.applyHint))
        assertEquals("and the slot is held in that direction too",
            shut, compose.onNodeWithText("Apply").getUnclippedBoundsInRoot())
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

        compose.onNodeWithText("Apply").assertIsNotEnabled()
        val saying = compose.onAllNodes(saying(Proposal.applyHint)).fetchSemanticsNodes()
        assertEquals("the shut band's merged tree:\n${compose.onRoot().printToString()}",
            1, saying.size)
        assertEquals("and the one node is the control that is refusing",
            listOf("Apply"), saying.single().config[SemanticsProperties.Text].map { it.text })

        // Open, nothing says it at all: the reason is gone from the state as well as from the row.
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText("Apply").assertIsEnabled()
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
        compose.onNodeWithText("Apply").assertIsEnabled()
        compose.onNodeWithText("Apply").performClick()

        compose.onNodeWithText("Apply").assertIsNotEnabled()
        compose.onNodeWithText("Apply").assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription))

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
        val apply = compose.onNodeWithText("Apply").getUnclippedBoundsInRoot()
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

        compose.onNodeWithText("Apply").assertIsNotEnabled()
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText("Apply").assertIsEnabled()

        compose.onNodeWithText("and 6 lines unchanged").performScrollTo().performClick()
        compose.onNodeWithText("Apply").assertIsNotEnabled()
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText("Apply").assertIsEnabled()
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
            compose.onNodeWithText("Apply").assertIsEnabled()
            compose.onNodeWithText("Apply").performClick()
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
        compose.onNodeWithText("Push Day · 2 changes · still waiting").assertIsDisplayed()
        compose.onNodeWithText("Review").performClick()
        compose.runOnIdle { assertEquals(listOf("review"), doors) }
        scope.cancel()
    }

    // The eyebrow carries a name the lifter typed, so it takes what is left of the row and ellipses
    // — it never measures the row out from under the stamp beside it. The card is drawn in a narrow
    // frame because the test font gives every glyph the same tiny advance: on a phone the row runs
    // out of room to a long name, here it runs out of room to a short frame, and the measurement is
    // the same one either way.
    @Test
    fun aNameTooLongForTheRowEllipsesTheEyebrowAndLeavesTheStampItsRoom() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val (_, kept) = store(scope, server)
        val waiting = proposal(kept, listOf(retarget("bench-press", 1)))
        val long = "Push day, heavy singles, then the long accessory block"
        compose.setContent {
            Box(Modifier.width(64.dp)) {
                ProposalCard(waiting, long, nowMs = 2_000, stillWaiting = true, onReview = {})
            }
        }

        compose.onNodeWithText(Readout.whenLogged(1_000, 2_000)).assertIsDisplayed()
        compose.onNodeWithText("Proposal · $long").assertIsDisplayed()
        scope.cancel()
    }
}
