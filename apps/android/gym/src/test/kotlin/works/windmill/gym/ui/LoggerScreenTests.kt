package works.windmill.gym.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.FinishOutcome
import works.windmill.gym.store.GymResult
import works.windmill.sync.engine.nextPush

// The quiet ledger logger: the words the old screen drew are now said by the controls that own them,
// and each pin here reads a control by its name. Signed in and synced with the account's log, so a
// set that is logged lands and the last-time read has somewhere to come from.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LoggerScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun logger(
        scope: CoroutineScope,
        history: Boolean = false,
        logged: Boolean = false,
        warmup: Boolean = false,
        lastTimeDown: Boolean = false,
        unanswered: Boolean = false,
        haptics: HapticFeedback? = null,
        preferences: GymPreferences = GymPreferences(),
    ): EngineRoomFixture {
        // No delete window here, so a deleted set settles the moment it is deleted.
        val room = EngineRoomFixture(tmp.newFolder(), scope, undoWindowMs = 0)
        val server = EngineRoomFixture.server()
        // On the wall clock, which the screen's own clocks read; last time is from yesterday.
        val today = System.currentTimeMillis()
        room.now = if (history) today - 86_400_000 else today
        runBlocking {
            room.select("u1")
            // Unread, the account's log cannot say a movement was never trained, so the last-time read misses.
            if (!lastTimeDown) room.pull(server)
            if (preferences != GymPreferences()) assertNull(room.store.savePreferences(preferences))
            if (history) {
                val pushB = (room.store.saveRoutine(RoutineDraft(name = "Push B").adding("bench-press")) as GymResult.Ok).value
                room.store.start(pushB.id)
                room.store.choose("bench-press")
                room.store.logSet(80.0, 6)
                room.now += 60_000
                assertTrue(room.store.finish() is FinishOutcome.Closed)
                room.now = today
            }
            room.store.start(null)
            room.store.choose("bench-press")
            room.store.choose("barbell-row")
            room.store.choose("cable-fly")
            room.store.choose("bench-press")
            if (unanswered) room.sync(server)
            if (warmup) room.store.logSet(40.0, 10, SetKind.Warmup)
            if (logged) room.store.logSet(60.0, 5)
            // The set's send went out and never came back, so it may already be on the log.
            if (unanswered) {
                room.engine.releaseHeld(true)
                room.engine.nextPush()
            } else if (logged || warmup || history) room.sync(server)
            room.store.refreshEngine()
        }
        room.store.observeEngine()
        compose.setContent {
            CompositionLocalProvider(LocalHapticFeedback provides (haptics ?: LocalHapticFeedback.current)) {
                LoggerScreen(store = room.store, isSignedIn = true, say = {}, onFinish = {}, onSignIn = {}, onSettings = {})
            }
        }
        return room
    }

    // The rack fixture: Lower A, whose back squat is the ramp 60 × 5 · 80 × 5 · 90 × 3 · 100 × 1 ·
    // 80 × 5, with the first two sets landed as planned. Signed out, so the plan is the routine the
    // device holds, every set is on this device, and nothing here depends on a server.
    private fun rack(scope: CoroutineScope): EngineRoomFixture {
        val room = EngineRoomFixture(tmp.newFolder(), scope)
        room.now = System.currentTimeMillis()
        runBlocking {
            room.select(null)
            val lowerA = (room.store.saveRoutine(
                RoutineDraft(name = "Lower A")
                    .adding("back-squat")
                    .targeting("back-squat", listOf(
                        SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0)))
            ) as GymResult.Ok).value
            room.store.start(lowerA.id)
            room.store.choose("back-squat")
            room.store.logSet(60.0, 5)
            room.store.logSet(80.0, 5)
        }
        room.store.observeEngine()
        compose.setContent {
            LoggerScreen(store = room.store, isSignedIn = false, say = {}, onFinish = {}, onSignIn = {}, onSettings = {})
        }
        return room
    }

    // The ledger's rows top to bottom, each as what it says to TalkBack and whether it is a door.
    private fun ledger(): List<Pair<String, Boolean>> = compose
        .onAllNodes(SemanticsMatcher("a ledger row") { node ->
            node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty()
                .any { Regex("^(Set \\d+|Warmup), .*").matches(it) }
        })
        .fetchSemanticsNodes()
        .sortedBy { it.boundsInRoot.top }
        .map { it.config[SemanticsProperties.ContentDescription].first() to (SemanticsActions.OnClick in it.config) }

    private fun place() = compose.onNode(hasContentDescription("Exercise 1 of 3"))

    // The head is pinned above the ledger: a landed set scrolls the rows, never the name, the place or
    // the walk's glyphs off the screen — and the rack under the ledger does not move by a pixel.
    private fun theHeadStandsStillWhenASetLands() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope).use {
            val rack = compose.onNodeWithText("Log set").assertIsDisplayed().getBoundsInRoot()
            val head = place().assertIsDisplayed().getBoundsInRoot()
            val next = compose.onNode(hasContentDescription("Next movement")).assertIsDisplayed().getBoundsInRoot()
            assertEquals(listOf(GymTap.minimum, GymTap.minimum), listOf(next.width, next.height))

            repeat(3) {
                compose.onNodeWithText("Log set").performClick()
                compose.waitForIdle()
            }

            compose.onAllNodes(hasContentDescription("logged", substring = true)).assertCountEquals(3)
            assertEquals("the head did not move", head, place().assertIsDisplayed().getBoundsInRoot())
            assertEquals("the rack did not move", rack, compose.onNodeWithText("Log set").getBoundsInRoot())
            assertEquals("the movement action remains 48dp", GymTap.minimum,
                compose.onNodeWithText("Add movement").performScrollTo().assertIsDisplayed().getBoundsInRoot().height)
        } } finally { scope.cancel() }
    }

    @Test
    @Config(sdk = [35], qualifiers = "w411dp-h683dp-xhdpi")
    fun theHeadStandsStillWhenASetLandsAtTheEmulatorsFrame() = theHeadStandsStillWhenASetLands()

    @Test
    @Config(sdk = [35], qualifiers = "w360dp-h780dp-xhdpi")
    fun theHeadStandsStillWhenASetLandsOnTheSmallestFrame() = theHeadStandsStillWhenASetLands()

    // A set deleted from its own fix sheet leaves the ledger once its window settles, and the set in
    // hand counts it gone.
    @Test
    fun aSetDeletedFromTheLedgerStaysOffItWhenTheWindowSettles() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, logged = true).use { room ->
            assertEquals(listOf("Set 1, logged, 60 kg, 5 reps" to true, "Set 2, current" to false), ledger())

            compose.onNode(hasContentDescription("Set 1, logged, 60 kg, 5 reps")).performClick()
            compose.onNodeWithText("Delete set").performClick()
            compose.waitForIdle()

            compose.runOnIdle { assertTrue("the window settled", room.store.withheld.isEmpty()) }
            assertEquals(listOf("Set 1, current" to false), ledger())
        } } finally { scope.cancel() }
    }

    // Last time fills the rack; nothing on the screen draws last time itself.
    @Test
    fun lastTimePrefillsTheRackAndDrawsNothingOfItsOwn() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, history = true).use {
            compose.onNode(hasContentDescription("Weight 80 kg")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()
            compose.onAllNodes(hasText("Last time", substring = true)).assertCountEquals(0)
            compose.onAllNodes(hasContentDescription("Last time", substring = true)).assertCountEquals(0)
            compose.onAllNodes(hasText("80 × 6")).assertCountEquals(0)
        } } finally { scope.cancel() }
    }

    // A last-time read that missed leaves the rack at the bar and says nothing of history.
    @Test
    fun aFailedLastTimeReadLeavesTheRackAtTheBar() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, lastTimeDown = true).use {
            compose.onNode(hasContentDescription("Weight 20 kg")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Reps 5")).assertIsDisplayed()
            compose.onAllNodes(hasText("Last time", substring = true)).assertCountEquals(0)
            compose.onAllNodes(hasText("Didn’t load")).assertCountEquals(0)
        } } finally { scope.cancel() }
    }

    // A set whose send went out and never came back may already be on the log, so its fix is filed
    // behind that send: the row is still a door, and offline the sheet saves at once, the ledger
    // draws the correction, and the set stays on this device until the log answers.
    @Test
    fun aRowMaybeOnTheLogIsADoorWhoseFixSavesOffline() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, logged = true, unanswered = true).use { room ->
            compose.runOnIdle { assertEquals(1, room.store.stalled.size) }
            val row = compose.onNode(hasContentDescription("Set 1, logged, 60 kg, 5 reps, on this device"))
            row.assertIsDisplayed()
            row.assertHasClickAction()

            row.performClick()
            compose.onNodeWithText("Fix set").assertIsDisplayed()
            compose.onNodeWithText("+").performClick()
            compose.onNodeWithText("Save fix").performClick()
            compose.waitForIdle()

            compose.onNodeWithText("Fix set").assertDoesNotExist()
            compose.onNode(hasContentDescription("Set 1, logged, 60 kg, 6 reps, on this device")).assertIsDisplayed()
            compose.runOnIdle {
                assertEquals(listOf(6), room.store.sets.map { it.reps })
                assertEquals(setOf(room.store.sets.single().id), room.store.stalled)
                assertEquals("the correction stands in the replica", room.store.sets,
                    room.training.details().single().sets)
                assertEquals("and waits behind the send that never came back",
                    listOf(Triple("sent", room.store.sets.single().id, 5L), Triple("ready", room.store.sets.single().id, 6L)),
                    room.outbox().map { entry ->
                        val write = entry.member("intent").member("d").arr().single()
                        Triple(entry.member("state").str(), write.member("id").str(), write.member("f").member("reps").arr().first().long())
                    })
            }
        } } finally { scope.cancel() }
    }

    @Test
    fun anInFlightSetShowsTheDeviceMarkerAndOnlyAFailedDeliveryShowsTheBand() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, logged = true, unanswered = true).use { room ->
            compose.onNode(hasContentDescription("Set 1, logged, 60 kg, 5 reps, on this device")).assertIsDisplayed()
            compose.onAllNodes(hasText("saved on this device only", substring = true)).assertCountEquals(0)
            compose.runOnIdle {
                room.training.reportDelivery(room.engine.activeReplica(), works.windmill.sync.engine.Reply.Unreachable)
                runBlocking { room.store.refreshEngine() }
            }
            compose.onNodeWithText("1 set is saved on this device only. They’ll sync when you’re online.").assertIsDisplayed()
            compose.runOnIdle {
                room.training.reportDelivery(room.engine.activeReplica(), works.windmill.sync.engine.Reply.Answer(
                    works.windmill.sync.engine.SyncResponse(200, works.windmill.sync.core.Json.objectOf())))
                runBlocking { room.store.refreshEngine() }
            }
            compose.onAllNodes(hasText("saved on this device only", substring = true)).assertCountEquals(0)
            compose.onNode(hasContentDescription("Set 1, logged, 60 kg, 5 reps, on this device")).assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    @Test
    fun loggingUsesWorkingKindAndStaysSilentWithLegacyConfirmationEnabled() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val sensations = mutableListOf<HapticFeedbackType>()
        val preferences = GymPreferences(confirmHaptic = true, confirmSound = true)
        try { logger(scope, preferences = preferences, haptics = object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
                sensations += hapticFeedbackType
            }
        }).use { room ->
            compose.onNode(hasContentDescription("Set kind")).assertDoesNotExist()
            compose.onNodeWithText("Kind").assertDoesNotExist()
            compose.onNodeWithText("Log set").performClick()
            compose.runOnIdle {
                assertEquals(listOf(SetKind.Working), room.store.sets.map { it.kind })
                assertEquals(preferences, room.store.preferences)
                assertEquals(emptyList<HapticFeedbackType>(), sensations)
            }
        } } finally { scope.cancel() }
    }

    // The ledger: what landed recedes and is a door, the set in hand names its target and repeats none
    // of the rack's numbers, the sets after it wait in plain ink — and only a landed row is a door. The
    // rack reads the CURRENT slot.
    @Test
    fun theLedgerDrawsEveryRowAndTheRackReadsTheCurrentOne() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { rack(scope).use {
            compose.onNode(hasContentDescription("Weight 90 kg")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Reps 3")).assertIsDisplayed()
            assertEquals(
                listOf(
                    "Set 1, logged, 60 kg, 5 reps, on this device" to true,
                    "Set 2, logged, 80 kg, 5 reps, on this device" to true,
                    "Set 3, current, target 90 kg, 3 reps" to false,
                    "Set 4, planned, 100 kg, 1 rep" to false,
                    "Set 5, planned, 80 kg, 5 reps" to false,
                ),
                ledger(),
            )
            compose.onNode(hasContentDescription("Set 3, current, target 90 kg, 3 reps"))
                .assert(hasText("target 90 × 3"))
                .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Role))
            compose.onAllNodes(hasText("Set 3")).assertCountEquals(1)

            compose.onNodeWithText("Log set").performClick()
            compose.waitForIdle()
            compose.onNode(hasContentDescription("Weight 100 kg")).assertIsDisplayed()
            compose.onNode(hasContentDescription("Reps 1")).assertIsDisplayed()
            assertEquals(
                listOf(
                    "Set 1, logged, 60 kg, 5 reps, on this device" to true,
                    "Set 2, logged, 80 kg, 5 reps, on this device" to true,
                    "Set 3, logged, 90 kg, 3 reps, on this device" to true,
                    "Set 4, current, target 100 kg, 1 rep" to false,
                    "Set 5, planned, 80 kg, 5 reps" to false,
                ),
                ledger(),
            )
            compose.onNode(hasContentDescription("Set 4, current, target 100 kg, 1 rep")).assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    // A set logged past the plan is a plain logged row, and the set in hand counts on past the plan
    // with no target — the log is right where it and the plan disagree.
    @Test
    fun aSetLoggedPastThePlanLeavesTheSetInHandWithNoTarget() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { rack(scope).use {
            repeat(4) {
                compose.onNodeWithText("Log set").performClick()
                compose.waitForIdle()
            }

            compose.onAllNodes(hasText("target ", substring = true)).assertCountEquals(0)
            assertEquals(
                listOf(
                    "Set 1, logged, 60 kg, 5 reps, on this device" to true,
                    "Set 2, logged, 80 kg, 5 reps, on this device" to true,
                    "Set 3, logged, 90 kg, 3 reps, on this device" to true,
                    "Set 4, logged, 100 kg, 1 rep, on this device" to true,
                    "Set 5, logged, 80 kg, 5 reps, on this device" to true,
                    "Set 6, logged, 80 kg, 5 reps, on this device" to true,
                    "Set 7, current" to false,
                ),
                ledger(),
            )
            compose.onNode(hasContentDescription("Set 7, current")).assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    // A warmup reads W, takes no number, and is a door like every landed row.
    @Test
    fun aWarmupReadsWAndIsNotCounted() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, warmup = true, logged = true).use {
            assertEquals(
                listOf(
                    "Warmup, logged, 40 kg, 10 reps" to true,
                    "Set 1, logged, 60 kg, 5 reps" to true,
                    "Set 2, current" to false,
                ),
                ledger(),
            )
            compose.onNode(hasContentDescription("Warmup, logged, 40 kg, 10 reps")).assert(hasText("W"))
        } } finally { scope.cancel() }
    }

    // A landed row is the drawn, named door to the fix.
    @Test
    fun aLoggedRowOpensTheFixSheet() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, logged = true).use {
            val row = compose.onNode(hasContentDescription("Set 1, logged, 60 kg, 5 reps"))
            row.assertIsDisplayed()
            row.assertHasClickAction()
            row.assert(hasText("60") and hasText("5") and hasText("✓"))
            assertTrue("the row is a whole touch target", row.getBoundsInRoot().height >= GymTap.minimum)
            row.performClick()
            compose.onNodeWithText("Fix set").assertIsDisplayed()
        } } finally { scope.cancel() }
    }

    // The elapsed clock and the target are distinct, without a reset action.
    @Test
    fun aLandedSetShowsBothQuietClocksWithoutAResetAction() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope, logged = true).use {
            compose.onNodeWithText("Rest").assertDoesNotExist()
            compose.onNode(hasContentDescription("Workout time,", substring = true)).assertIsDisplayed()
            compose.onNode(hasContentDescription("Since last set,", substring = true)).assertIsDisplayed()
            compose.onNodeWithText("Rest target").assertDoesNotExist()
            compose.onNode(hasContentDescription("clear the rest", substring = true)).assertDoesNotExist()
        } } finally { scope.cancel() }
    }

    // The ladder's four labels come from the golden by weight band; nothing here is a fixed ±1/±5.
    // And the pills are equal: none of the four is the small one any more.
    @Test
    fun theLadderLabelsComeFromTheGoldenAndThePillsAreEqual() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope).use {
            val atTheBar = Ladder.labels(20.0)
            val widths = atTheBar.map { label ->
                compose.onNode(hasText(label) and hasClickAction()).assertIsDisplayed().getBoundsInRoot().width
            }
            assertEquals("four equal pills, and they are $widths", 1, widths.toSet().size)

            compose.onNode(hasText("+2.5") and hasClickAction()).performClick()
            compose.onNode(hasContentDescription("Weight 22.5 kg")).assertIsDisplayed()
            Ladder.labels(22.5).forEach { label ->
                compose.onNode(hasText(label) and hasClickAction()).assertIsDisplayed()
            }
        } } finally { scope.cancel() }
    }

    // The set in hand is named once, by its ledger row; a free session draws no target and no
    // `no target`.
    @Test
    fun theSetInHandIsNamedOnceAndAFreeSessionHasNoTarget() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope).use {
            assertEquals(listOf("Set 1, current" to false), ledger())
            compose.onAllNodes(hasText("Set 1")).assertCountEquals(1)
            compose.onAllNodes(hasText("SET 1")).assertCountEquals(0)
            compose.onAllNodes(hasText("no target")).assertCountEquals(0)
            compose.onAllNodes(hasText("target ", substring = true)).assertCountEquals(0)
        } } finally { scope.cancel() }
    }

    // The primary says its verb and nothing else — the two numerals stand directly above it.
    @Test
    fun theLogButtonEchoesNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { logger(scope).use {
            compose.onNodeWithText("Log set").assertIsDisplayed().assertHasClickAction()
            compose.onAllNodes(hasText("Log set  ·  ", substring = true)).assertCountEquals(0)
            compose.onNodeWithText("Add movement").assertIsDisplayed().assertHasClickAction()
            compose.onNode(hasContentDescription("Gym settings")).assertIsDisplayed().assertHasClickAction()
            compose.onNode(hasContentDescription("one rep fewer")).assertHasClickAction()
            compose.onNode(hasContentDescription("one rep more")).assertHasClickAction()
            compose.onNode(hasContentDescription("Reps 5")).assertIsDisplayed().assertHasClickAction()
        } } finally { scope.cancel() }
    }
}
