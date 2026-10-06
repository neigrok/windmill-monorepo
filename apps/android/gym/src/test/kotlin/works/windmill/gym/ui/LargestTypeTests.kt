package works.windmill.gym.ui

import androidx.compose.foundation.layout.Box
import kotlinx.coroutines.launch
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarDuration
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.DpRect
import org.junit.Assert.assertEquals
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
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
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SetTarget
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
import works.windmill.gym.domain.sync.ProposeRoutine
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.sync.modelserver.ModelServer
import works.windmill.gym.domain.sync.Exercise as EngineExercise
import works.windmill.gym.domain.sync.Proposal as EngineProposal
import works.windmill.gym.domain.sync.Routine as EngineRoutine
import works.windmill.gym.domain.sync.RoutineEntry as EngineEntry
import works.windmill.gym.domain.sync.SetTarget as EngineTarget

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

    @Test
    fun bothHourClocksStayReadableAtTwoHundredPercentOnANarrowScreen() {
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                GymMaterial {
                    Box(Modifier.width(320.dp).padding(horizontal = 20.dp)) {
                        WorkoutClockRow(works.windmill.gym.domain.WorkoutClocks(
                            works.windmill.gym.domain.Session("session", 0),
                            listOf(works.windmill.gym.domain.TrainingSet("set", "bench", weightKg = 60.0, reps = 5, completedAtMs = 3_600_000)),
                            36_123_000,
                        ))
                    }
                }
            }
        }
        val workout = compose.onNode(hasContentDescription("Workout time, 10:02:03")).assertIsDisplayed().getBoundsInRoot()
        val sinceSet = compose.onNode(hasContentDescription("Since last set, 9:02:03")).assertIsDisplayed().getBoundsInRoot()
        listOf(workout, sinceSet).forEach { bounds ->
            assertTrue("clock fits in280dp content: $bounds", bounds.left >= 20.dp && bounds.right <= 300.dp)
            assertTrue("clock keeps readable height: $bounds", bounds.height >= 28.dp)
        }
        assertTrue("clock pair wraps without overlap", sinceSet.top >= workout.bottom)
    }

    // What is left for the region the block is pinned against. Below this a lifter reads a thread —
    // or a diff they are about to be held to — through a slot.
    private val floor = 120.dp

    // Signed in and read from the account's log, with Coach's door open.
    private fun store(scope: CoroutineScope, server: ModelServer = EngineRoomFixture.server()): EngineRoomFixture {
        val room = EngineRoomFixture(tmp.newFolder(), scope, rest = FakeGymRest())
        room.now = System.currentTimeMillis()
        runBlocking {
            room.select("u1")
            room.pull(server)
        }
        room.store.observeEngine()
        return room
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
        try { store(scope).use { room ->
            compose.setContent {
                CompositionLocalProvider(LocalDensity provides Density(density = 2f, fontScale = 2f)) {
                    AskScreen(
                        store = room.store,
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
        } } finally { scope.cancel() }
    }

    // The band grew a fourth stacked row this wave — the gate's refusal, in a slot held open in both
    // states — over a diff that does not get a floor of its own. Measured in a 700dp sheet with the
    // gate SHUT: the band is 272dp (Apply 56 · the refusal 57 · the atomic promise 57 · Turn this
    // down 46) and the diff keeps 317dp, still scrolling.
    @Test
    fun theReviewBandLeavesTheDiffReadableAtFontScaleTwoWithTheGateShut() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        try { store(scope, server).use { room ->
            // A day of eight presses at three fives, on the account's log.
            val presses = listOf("bench-press", "incline-bench-press", "close-grip-bench-press", "overhead-press",
                "push-press", "dumbbell-bench-press", "incline-dumbbell-press", "dumbbell-shoulder-press")
            val routine = runBlocking {
                val saved = (room.store.saveRoutine(presses.fold(RoutineDraft(name = "Push Day")) { draft, press ->
                    draft.adding(press).targeting(press, List(3) { SetTarget(5) })
                }) as GymResult.Ok).value
                room.sync(server)
                saved
            }
            // Coach proposes triples across the whole day: eight retargeted lines, from the account's side.
            val coachScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
            try { EngineRoomFixture(tmp.newFolder(), coachScope).use { coach -> runBlocking {
                coach.now = room.now
                coach.select("u1")
                coach.pull(server)
                val runner = ActionRunner(coach.engine, coach.engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
                assertTrue(runner.run(ProposeRoutine(Id("proposal1", EngineProposal), Id(routine.id, EngineRoutine), "Push Day",
                    presses.map { press -> EngineEntry(Id(press, EngineExercise), List(5) { EngineTarget(3) }) },
                    "Heavier triples across the whole day.")) is Outcome.Committed)
                coach.sync(server)
                assertEquals("the log took the proposal", emptyList<Any>(), coach.engine.notices("gym").notices.value)
            } } } finally { coachScope.cancel() }
            room.pull(server)
            runBlocking { room.store.refreshEngine() }

            compose.setContent {
                CompositionLocalProvider(LocalDensity provides Density(density = 2f, fontScale = 2f)) {
                    Box(Modifier.fillMaxWidth().height(700.dp)) {
                        ReviewSheet(
                            proposalId = "proposal1", routineId = routine.id, store = room.store,
                            onAsk = null, onDecided = {},
                        )
                    }
                }
            }

            val scroller = compose.onNode(hasScrollAction()).fetchSemanticsNode()
            val left = with(compose.density) { scroller.size.height.toDp() }
            assertTrue("the diff is $left at fontScale 2.0", left >= floor)

            val apply = compose.onNodeWithText("Apply all 8").fetchSemanticsNode()
            val atomic = compose.onNodeWithText("All eight or none. Nothing is applied until you tap.")
                .fetchSemanticsNode()
            val turnDown = compose.onNodeWithText(Proposal.turnDownVerb).fetchSemanticsNode()
            assertTrue("the whole band stands under the diff and none of it is cut off",
                apply.positionInRoot.y >= scroller.positionInRoot.y + scroller.size.height &&
                    turnDown.positionInRoot.y + turnDown.size.height <=
                    with(compose.density) { 700.dp.toPx() })
            // The refusal is off the semantics tree in BOTH states (`4m`), so its slot is measured as the
            // gap it holds open between Apply and the atomic promise rather than fetched by its text:
            // 73dp here, the row's own 57 between the band's two 8dp gaps. Delete the row and this is 8.
            val slot = with(compose.density) {
                (atomic.positionInRoot.y - (apply.positionInRoot.y + apply.size.height)).toDp()
            }
            assertTrue("the refusal keeps its slot between Apply and the atomic promise, and it is $slot",
                slot >= 57.dp)
        } } finally { scope.cancel() }
    }

    // The logger's rack is pinned and never shrinks, so at the largest text it is the reading region
    // above it that compresses and then scrolls. On the smallest supported frame at fontScale 1.3,
    // with a set landed (clocks and strip both up): Log set ends inside the window, and each of the
    // four ladder labels sits inside its own pill — relative claims, never a point value.
    @Test
    @Config(sdk = [35], qualifiers = "w360dp-h780dp-xhdpi")
    fun theRackStaysInsideTheSmallestFrameAtFontScaleOnePointThree() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        try { store(scope, server).use { room ->
            runBlocking {
                room.store.start(null)
                room.store.choose("bench-press")
                room.store.logSet(60.0, 5)
                room.sync(server)
                room.store.refreshEngine()
            }
            compose.setContent {
                // The room's own faces, because it is their widths at 1.3 that are being measured.
                GymMaterial {
                    CompositionLocalProvider(LocalDensity provides Density(density = 2f, fontScale = 1.3f)) {
                        LoggerScreen(store = room.store, isSignedIn = true, say = {}, onFinish = {}, onSignIn = {},
                                     onSettings = {})
                    }
                }
            }

            compose.onNode(hasContentDescription("Weight 60 kg")).assertExists()
            val window = compose.onRoot().getBoundsInRoot()
            // A node pushed off the frame reports an EMPTY rect, so `inside` has to mean drawn as well.
            val log = compose.onNodeWithText("Log set").assertIsDisplayed().getBoundsInRoot()
            assertTrue("Log set ends at ${log.bottom} in a window ${window.bottom} tall",
                log.height > 0.dp && log.bottom <= window.bottom)
            Ladder.labels(60.0).forEach { label ->
                // A label inside a bounded pill measures the pill's width whatever its glyphs need, so
                // the claim is read off the text engine's own paragraph: one line, whose unbroken
                // width fits inside the pill it sits in.
                val laid = mutableListOf<TextLayoutResult>()
                compose.onNode(hasText(label), useUnmergedTree = true).fetchSemanticsNode()
                    .config[SemanticsActions.GetTextLayoutResult].action?.invoke(laid)
                val line = laid.single()
                val pill = compose.onNode(hasText(label) and hasClickAction()).getBoundsInRoot()
                val pillPx = with(compose.density) { pill.width.toPx() }
                val needs = line.multiParagraph.maxIntrinsicWidth
                assertTrue("$label needs ${needs}px inside a pill ${pillPx}px wide",
                    line.lineCount == 1 && needs <= pillPx)
            }
        } } finally { scope.cancel() }
    }

    // A logger over a walk of two, stood on the 411 × 731 phone with the 24 dp status bar and the
    // 24 dp gesture bar the device takes off that frame — Robolectric's window has no insets, so
    // without them this measures a phone 48 dp taller than the one in hand.
    private fun loggerOnThePhone(scope: CoroutineScope, server: ModelServer, fontScale: Float,
                                 walk: List<String> = listOf("bench-press", "deadlift"),
                                 transient: SnackbarHostState? = null): EngineRoomFixture {
        val room = store(scope, server)
        runBlocking {
            room.store.start(null)
            walk.forEach { room.store.choose(it) }
            room.store.choose(walk.first())
        }
        compose.setContent {
            GymMaterial {
                CompositionLocalProvider(LocalDensity provides Density(density = 2f, fontScale = fontScale)) {
                    Box(Modifier.padding(top = 24.dp, bottom = 24.dp)) {
                        LoggerScreen(store = room.store, isSignedIn = true, say = {}, onFinish = {}, onSignIn = {},
                                     onSettings = {}, transient = transient)
                    }
                }
            }
        }
        return room
    }

    // Each set lands on the account's log before the next is logged, as on a phone with signal.
    private fun logSets(room: EngineRoomFixture, server: ModelServer, count: Int) = repeat(count) {
        compose.onNodeWithText("Log set").performClick()
        compose.waitForIdle()
        compose.runOnIdle { room.sync(server) }
        compose.waitForIdle()
    }

    private fun scroller() =
        compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)).getBoundsInRoot()

    private fun inside(inner: DpRect, outer: DpRect) = inner.top >= outer.top && inner.bottom <= outer.bottom

    // At fontScale 1.0 on the 411 × 731 phone the head, the place and both rows are drawn once a set
    // lands, each row fully INSIDE the ledger rather than clipped by it — while Log set stands
    // exactly where it stood before the set landed.
    @Test
    @Config(sdk = [35], qualifiers = "w411dp-h731dp-xhdpi")
    fun theWholeLedgerShowsAfterASetLandsOnTheSmallPhoneAtFontScaleOne() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        try { loggerOnThePhone(scope, server, fontScale = 1f).use { room ->
            val logBefore = compose.onNodeWithText("Log set").assertIsDisplayed().getBoundsInRoot()

            logSets(room, server, 1)

            compose.onNodeWithText("Bench Press").assertIsDisplayed()
            compose.onNode(hasContentDescription("Exercise 1 of 2")).assertIsDisplayed()
            val region = scroller()
            listOf("Set 1, logged, 20 kg, 5 reps", "Set 2, current").forEach { said ->
                val row = compose.onNode(hasContentDescription(said, substring = true)).assertIsDisplayed().getBoundsInRoot()
                assertTrue("$said at $row is clipped by the ledger $region", inside(row, region))
            }
            assertEquals("Log set moved", logBefore, compose.onNodeWithText("Log set").getBoundsInRoot())
        } } finally { scope.cancel() }
    }

    // At fontScale 1.3 the ledger overflows after a few sets, and every landed set brings the set in
    // hand into view just above the rack: the ledger is at the current row, not at the first set.
    @Test
    @Config(sdk = [35], qualifiers = "w411dp-h731dp-xhdpi")
    fun aLandedSetBringsTheSetInHandIntoViewWhereTheLargestTextOverflows() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        try { loggerOnThePhone(scope, server, fontScale = 1.3f).use { room ->
            logSets(room, server, 5)

            val ledger = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange))
            assertTrue("the ledger overflows",
                ledger.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].maxValue() > 0f)
            val current = compose.onNode(hasContentDescription("Set 6, current")).assertIsDisplayed().getBoundsInRoot()
            val region = scroller()
            assertTrue("the set in hand $current is clipped by the ledger $region", inside(current, region))
            compose.onNodeWithText("Log set").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    // A free session has nothing planned after the set in hand, only Add movement, the next thing a
    // lifter may want: every landed set brings the set in hand AND Add movement into view.
    @Test
    @Config(sdk = [35], qualifiers = "w411dp-h731dp-xhdpi")
    fun addMovementStaysInViewAsSetsLandInAFreeSingleMovementSession() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        try { loggerOnThePhone(scope, server, fontScale = 1.3f, walk = listOf("bench-press")).use { room ->
            logSets(room, server, 6)

            val ledger = compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange))
            assertTrue("the ledger overflows",
                ledger.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].maxValue() > 0f)
            val region = scroller()
            val current = compose.onNode(hasContentDescription("Set 7, current")).assertIsDisplayed().getBoundsInRoot()
            val add = compose.onNodeWithText("Add movement").assertIsDisplayed().getBoundsInRoot()
            assertTrue("the set in hand $current is clipped by the ledger $region", inside(current, region))
            assertTrue("Add movement $add is clipped by the ledger $region", add.height > 0.dp && inside(add, region))
        } } finally { scope.cancel() }
    }

    // A transient rises over the ledger's foot, where the set in hand is parked; the rows gain its
    // height at their end and the set in hand moves up out from under it.
    @Test
    @Config(sdk = [35], qualifiers = "w411dp-h731dp-xhdpi")
    fun theSetInHandStaysAboveATransient() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val transient = SnackbarHostState()
        val server = EngineRoomFixture.server()
        try { loggerOnThePhone(scope, server, fontScale = 1.3f, transient = transient).use { room ->
            logSets(room, server, 6)

            scope.launch { transient.showSnackbar("Set deleted", actionLabel = "Undo", duration = SnackbarDuration.Indefinite) }
            compose.waitForIdle()

            val bar = compose.onNodeWithTag("Transient").assertIsDisplayed().getBoundsInRoot()
            val current = compose.onNode(hasContentDescription("Set 7, current")).assertIsDisplayed().getBoundsInRoot()
            assertTrue("the transient stands at $bar", bar.height > 0.dp)
            assertTrue("the set in hand $current is under the transient $bar", current.bottom <= bar.top)
            assertTrue("the set in hand $current is clipped by the ledger ${scroller()}", inside(current, scroller()))
        } } finally { scope.cancel() }
    }

    // From set 10 on the index has two digits, and at a large scale the set column still holds it and
    // its ✓ unclipped, while every row keeps its kg under the column label.
    @Test
    @Config(sdk = [35], qualifiers = "w411dp-h731dp-xhdpi")
    fun aTwoDigitSetKeepsItsTickAtOneThirtyPercent() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        try { loggerOnThePhone(scope, server, fontScale = 1.3f).use { room ->
            logSets(room, server, 10)

            fun laid(node: SemanticsNodeInteraction): TextLayoutResult {
                val results = mutableListOf<TextLayoutResult>()
                node.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(results)
                return results.single()
            }
            fun unclipped(text: TextLayoutResult) = text.lineCount == 1 && !text.multiParagraph.didExceedMaxLines &&
                text.size.width >= kotlin.math.ceil(text.multiParagraph.maxIntrinsicWidth)
            val ticks = compose.onAllNodes(hasText("✓"), useUnmergedTree = true)
            ticks.assertCountEquals(10)
            (0 until 10).forEach { at ->
                val tick = laid(ticks[at])
                assertTrue("✓ $at is ${tick.size.width}px wide and needs ${tick.multiParagraph.maxIntrinsicWidth}px", unclipped(tick))
            }
            val ten = laid(compose.onNode(hasText("10"), useUnmergedTree = true))
            assertTrue("10 is ${ten.size.width}px wide and needs ${ten.multiParagraph.maxIntrinsicWidth}px", unclipped(ten))

            compose.onNode(hasContentDescription("Set 10, logged", substring = true)).assertIsDisplayed()
            // The column label is the topmost "kg"; the rack's units sit below the ledger.
            val label = compose.onAllNodes(hasText("kg"), useUnmergedTree = true).fetchSemanticsNodes()
                .minBy { it.positionInRoot.y }.positionInRoot.x
            val ledgerFoot = with(compose.density) { scroller().bottom.toPx() }
            val weights = compose.onAllNodes(hasText("20"), useUnmergedTree = true).fetchSemanticsNodes()
                .filter { it.positionInRoot.y < ledgerFoot }
            assertEquals(10, weights.size)
            assertEquals(List(10) { label }, weights.map { it.positionInRoot.x })
        } } finally { scope.cancel() }
    }
}
