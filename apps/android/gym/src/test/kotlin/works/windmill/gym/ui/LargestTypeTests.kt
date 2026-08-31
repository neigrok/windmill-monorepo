package works.windmill.gym.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.AskExchange
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalChange
import works.windmill.gym.domain.ProposalSource
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.ProposalTargets
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
import works.windmill.platform.net.WindmillApi

// Two blocks in this room are PINNED outside a scroller — Coach's doors under a cap, and the review
// band under the diff — and both grew a sentence. A block that grows can starve the region it is
// pinned against, and at fontScale 2.0 every sentence in it is roughly twice as tall.
//
// The rest of the suite cannot see that. Robolectric's default LEGACY graphics stubs the font
// metrics: the 110-character ceiling sentence measures 110px wide and 35px tall — one pixel per
// character — so nothing there ever wraps and no height measured there is real. `@GraphicsMode`
// NATIVE gives this one file the real text engine, which is what makes these two numbers evidence
// rather than arithmetic. That is the whole reason this file is separate: the annotation changes
// what every case in a class measures.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LargestTypeTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    // What is left for the region the block is pinned against. Below this a lifter reads a thread —
    // or a diff they are about to be held to — through a slot.
    private val floor = 120.dp

    private fun store(scope: CoroutineScope, server: FakeTraining = FakeTraining()): TrainingStore {
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
        return store
    }

    // The cap-reached sentence reads at the END OF THE THREAD, inside the scroller, and under this
    // ceiling only the two doors are pinned — the day's promise is not the rule that stopped the
    // question, so it is not drawn here at all. Measured here: 283.5dp of thread left at fontScale
    // 2.0, with the 21-word ceiling sentence scrolling as part of the conversation it ended.
    @Test
    fun theCeilingSentenceScrollsWithTheThreadAndLeavesTheConversationReadableAtFontScaleTwo() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val ceiling = "this account has reached its AI ceiling for the last 30 days. Coach will " +
            "answer again as that window rolls on"
        val store = store(scope)
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(density = 2f, fontScale = 2f)) {
                AskScreen(
                    store = store,
                    thread = listOf(AskExchange(question = "what’s stalled?", trouble = ceiling)),
                    receipts = emptyList(), lookedAt = emptySet(), asking = false,
                    cap = AskCap.Ceiling, onAsk = {}, onRetry = {}, onAskNew = {}, seed = "",
                    origin = "https://windmill.works", backTo = null, onBack = null,
                    onThreads = {}, onNotes = {}, onReview = {},
                )
            }
        }

        val scroller = compose.onNode(hasScrollAction()).fetchSemanticsNode()
        val left = with(compose.density) { scroller.size.height.toDp() }
        assertTrue("the thread is $left at fontScale 2.0", left >= floor)

        val sentence = compose.onNodeWithText(ceiling).fetchSemanticsNode()
        assertTrue("and the sentence is inside it, not pinned on top of it",
            sentence.positionInRoot.y >= scroller.positionInRoot.y)
        // And under THIS ceiling the promise is not drawn at all: ten a day is the day's rule, and
        // pinned under the sentence refusing the question it would read as the reason for it.
        compose.onNodeWithText(Ask.allowance).assertDoesNotExist()
        scope.cancel()
    }

    // The band grew a fourth stacked row this wave — the gate's refusal, in a slot held open in both
    // states — over a diff that does not get a floor of its own. Measured in a 700dp sheet with the
    // gate SHUT: the band is 272dp (Apply 56 · the refusal 57 · the atomic promise 57 · Turn this
    // down 46) and the diff keeps 317dp, still scrolling.
    @Test
    fun theReviewBandLeavesTheDiffReadableAtFontScaleTwoWithTheGateShut() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = store(scope, server)
        val routine = runBlocking {
            (store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) as GymResult.Ok).value
        }
        server.propose(Proposal(
            id = "prop_1", routineId = routine.id, state = ProposalState.Pending,
            summary = "Heavier triples across the whole day.",
            changeCount = 8, createdAtMs = 1_000, source = ProposalSource(door = "ask"),
            baseRevision = routine.revision, baseName = "Push Day", name = "Push Day",
            changes = (1..8).map {
                ProposalChange(position = it, kind = ChangeKind.Retargeted, exerciseId = "bench-press",
                    before = ProposalTargets(sets = 3, reps = 5), after = ProposalTargets(sets = 5, reps = 3))
            },
        ))
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(density = 2f, fontScale = 2f)) {
                Box(Modifier.fillMaxWidth().height(700.dp)) {
                    ReviewSheet(
                        proposalId = "prop_1", routineId = routine.id, store = store,
                        onAsk = null, onDecided = {},
                    )
                }
            }
        }

        val scroller = compose.onNode(hasScrollAction()).fetchSemanticsNode()
        val left = with(compose.density) { scroller.size.height.toDp() }
        assertTrue("the diff is $left at fontScale 2.0", left >= floor)

        val apply = compose.onNodeWithText(Proposal.apply).fetchSemanticsNode()
        val hint = compose.onNodeWithText(Proposal.applyHint).fetchSemanticsNode()
        val turnDown = compose.onNodeWithText(Proposal.turnDownVerb).fetchSemanticsNode()
        assertTrue("the whole band stands under the diff and none of it is cut off",
            apply.positionInRoot.y >= scroller.positionInRoot.y + scroller.size.height &&
                turnDown.positionInRoot.y + turnDown.size.height <=
                with(compose.density) { 700.dp.toPx() })
        assertTrue("the refusal keeps its slot between Apply and the atomic promise",
            hint.positionInRoot.y > apply.positionInRoot.y &&
                hint.positionInRoot.y < turnDown.positionInRoot.y)
        scope.cancel()
    }
}
