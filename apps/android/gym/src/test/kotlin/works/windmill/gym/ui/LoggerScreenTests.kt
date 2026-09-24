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
import java.io.File
import java.io.IOException
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
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
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

// The quiet ledger logger: the words the old screen drew are now said by the controls that own them,
// and each pin here reads a control by its name. Signed in against the fake log, so a set that is
// logged lands and the last-time read has somewhere to come from.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class LoggerScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val day = 1_754_000_000_000L

    private fun logger(
        scope: CoroutineScope,
        lastTime: LastTime? = null,
        logged: Boolean = false,
        warmup: Boolean = false,
        lastTimeDown: Boolean = false,
        offline: Boolean = false,
        haptics: HapticFeedback? = null,
        preferences: GymPreferences = GymPreferences(),
    ): TrainingStore {
        val server = FakeTraining().apply { settings = preferences }
        server.catalog = listOf(
            Exercise(id = "bench-press", name = "Bench Press"),
            Exercise(id = "barbell-row", name = "Barbell Row"),
            Exercise(id = "cable-fly", name = "Cable Fly"),
        )
        lastTime?.let { server.lastTimes["bench-press"] = it }
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            mintSession = { "ses_1" },
            mintSet = Ids::set,
            // No delete window here, so a deleted set settles the moment it is deleted.
            undoWindowMs = 0,
            sync = { if (!it.isSignedIn) null else if (lastTimeDown) down(server) else server },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = User(id = "u1", email = "sam@example.com", name = "Sam")))
            store.start(null)
            store.choose("bench-press")
            store.choose("barbell-row")
            store.choose("cable-fly")
            store.choose("bench-press")
            // Offline AFTER the connect: the set logged next stays owed, on this device only.
            if (offline) server.online = false
            if (warmup) store.logSet(40.0, 10, SetKind.Warmup)
            if (logged) store.logSet(60.0, 5)
        }
        compose.setContent {
            CompositionLocalProvider(LocalHapticFeedback provides (haptics ?: LocalHapticFeedback.current)) {
                LoggerScreen(store = store, isSignedIn = true, say = {}, onFinish = {}, onSignIn = {}, onSettings = {})
            }
        }
        return store
    }

    // The rack fixture: Lower A, whose back squat is the ramp 60 × 5 · 80 × 5 · 90 × 3 · 100 × 1 ·
    // 80 × 5, with the first two sets landed as planned. Signed out, so the plan is the routine the
    // device holds, every set is on this device, and nothing here depends on a server.
    private fun rack(scope: CoroutineScope): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            mintSession = { "ses_1" },
            mintSet = Ids::set,
            sync = { null },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = null))
            val lowerA = (store.saveRoutine(
                RoutineDraft(name = "Lower A")
                    .adding("back-squat")
                    .targeting("back-squat", listOf(
                        SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0)))
            ) as GymResult.Ok).value
            store.start(lowerA.id)
            store.choose("back-squat")
            store.logSet(60.0, 5)
            store.logSet(80.0, 5)
        }
        compose.setContent {
            LoggerScreen(store = store, isSignedIn = false, say = {}, onFinish = {}, onSignIn = {}, onSettings = {})
        }
        return store
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

    // The fake log with its last-time read down and nothing else.
    private fun down(server: FakeTraining): TrainingSyncing = object : TrainingSyncing by server {
        override suspend fun lastTime(exerciseId: String): LastTime = throw IOException("the log is down")
    }

    private fun place() = compose.onNode(hasContentDescription("Exercise 1 of 3"))

    // The head is pinned above the ledger: a landed set scrolls the rows, never the name, the place or
    // the walk's glyphs off the screen — and the rack under the ledger does not move by a pixel.
    private fun theHeadStandsStillWhenASetLands() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope)
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
        scope.cancel()
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
        val store = logger(scope, logged = true)
        assertEquals(listOf("Set 1, logged, 60 kg, 5 reps" to true, "Set 2, current" to false), ledger())

        compose.onNode(hasContentDescription("Set 1, logged, 60 kg, 5 reps")).performClick()
        compose.onNodeWithText("Delete set").performClick()
        compose.waitForIdle()

        compose.runOnIdle { assertTrue("the window settled", store.withheld.isEmpty()) }
        assertEquals(listOf("Set 1, current" to false), ledger())
        scope.cancel()
    }

    // Last time fills the rack; nothing on the screen draws last time itself.
    @Test
    fun lastTimePrefillsTheRackAndDrawsNothingOfItsOwn() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val history = LastTime(
            exerciseId = "bench-press",
            session = Session(id = "ses_0", startedAtMs = day, finishedAtMs = day + 1),
            routine = "Push B",
            sets = listOf(TrainingSet(id = "p1", exerciseId = "bench-press", weightKg = 80.0, reps = 6,
                                      kind = SetKind.Working, completedAtMs = day)),
        )
        logger(scope, lastTime = history)

        compose.onNode(hasContentDescription("Weight 80 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 6")).assertIsDisplayed()
        compose.onAllNodes(hasText("Last time", substring = true)).assertCountEquals(0)
        compose.onAllNodes(hasContentDescription("Last time", substring = true)).assertCountEquals(0)
        compose.onAllNodes(hasText("80 × 6")).assertCountEquals(0)
        scope.cancel()
    }

    // A last-time read that missed leaves the rack at the bar and says nothing of history.
    @Test
    fun aFailedLastTimeReadLeavesTheRackAtTheBar() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope, lastTimeDown = true)

        compose.onNode(hasContentDescription("Weight 20 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 5")).assertIsDisplayed()
        compose.onAllNodes(hasText("Last time", substring = true)).assertCountEquals(0)
        compose.onAllNodes(hasText("Didn’t load")).assertCountEquals(0)
        scope.cancel()
    }

    // A set whose send went out and never came back may already be on the log, so its fix goes to
    // the log and nowhere else: the row is still a door, and offline the sheet says the fix did not
    // go while the ledger keeps the body the log may hold.
    @Test
    fun aRowMaybeOnTheLogIsADoorWhoseFixSaysItDidNotGoOffline() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope, logged = true, offline = true)
        compose.runOnIdle { assertEquals(1, store.stalled.size) }
        val row = compose.onNode(hasContentDescription("Set 1, logged, 60 kg, 5 reps, on this device"))
        row.assertIsDisplayed()
        row.assertHasClickAction()

        row.performClick()
        compose.onNodeWithText("Fix set").assertIsDisplayed()
        compose.onNodeWithText("+").performClick()
        compose.onNodeWithText("Save fix").performClick()
        compose.waitForIdle()

        compose.onNodeWithText("The log didn’t answer — that set wasn’t changed.").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(listOf(5), store.sets.map { it.reps })
            assertEquals(1, store.stalled.size)
        }
        scope.cancel()
    }

    @Test
    fun loggingUsesWorkingKindAndStaysSilentWithLegacyConfirmationEnabled() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val sensations = mutableListOf<HapticFeedbackType>()
        val preferences = GymPreferences(confirmHaptic = true, confirmSound = true)
        val store = logger(scope, preferences = preferences, haptics = object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
                sensations += hapticFeedbackType
            }
        })

        compose.onNode(hasContentDescription("Set kind")).assertDoesNotExist()
        compose.onNodeWithText("Kind").assertDoesNotExist()
        compose.onNodeWithText("Log set").performClick()
        compose.runOnIdle {
            assertEquals(listOf(SetKind.Working), store.sets.map { it.kind })
            assertEquals(preferences, store.preferences)
            assertEquals(emptyList<HapticFeedbackType>(), sensations)
        }
        scope.cancel()
    }

    // The ledger: what landed recedes and is a door, the set in hand names its target and repeats none
    // of the rack's numbers, the sets after it wait in plain ink — and only a landed row is a door. The
    // rack reads the CURRENT slot.
    @Test
    fun theLedgerDrawsEveryRowAndTheRackReadsTheCurrentOne() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        rack(scope)

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
        scope.cancel()
    }

    // A set logged past the plan is a plain logged row, and the set in hand counts on past the plan
    // with no target — the log is right where it and the plan disagree.
    @Test
    fun aSetLoggedPastThePlanLeavesTheSetInHandWithNoTarget() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        rack(scope)

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
        scope.cancel()
    }

    // A warmup reads W, takes no number, and is a door like every landed row.
    @Test
    fun aWarmupReadsWAndIsNotCounted() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope, warmup = true, logged = true)

        assertEquals(
            listOf(
                "Warmup, logged, 40 kg, 10 reps" to true,
                "Set 1, logged, 60 kg, 5 reps" to true,
                "Set 2, current" to false,
            ),
            ledger(),
        )
        compose.onNode(hasContentDescription("Warmup, logged, 40 kg, 10 reps")).assert(hasText("W"))
        scope.cancel()
    }

    // A landed row is the drawn, named door to the fix.
    @Test
    fun aLoggedRowOpensTheFixSheet() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope, logged = true)

        val row = compose.onNode(hasContentDescription("Set 1, logged, 60 kg, 5 reps"))
        row.assertIsDisplayed()
        row.assertHasClickAction()
        row.assert(hasText("60") and hasText("5") and hasText("✓"))
        assertTrue("the row is a whole touch target", row.getBoundsInRoot().height >= GymTap.minimum)
        row.performClick()
        compose.onNodeWithText("Fix set").assertIsDisplayed()
        scope.cancel()
    }

    // The elapsed clock and the target are distinct, without a reset action.
    @Test
    fun aLandedSetShowsBothQuietClocksWithoutAResetAction() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope, logged = true)

        compose.onNodeWithText("Rest").assertDoesNotExist()
        compose.onNode(hasContentDescription("Workout time,", substring = true)).assertIsDisplayed()
        compose.onNode(hasContentDescription("Since last set,", substring = true)).assertIsDisplayed()
        compose.onNodeWithText("Rest target").assertDoesNotExist()
        compose.onNode(hasContentDescription("clear the rest", substring = true)).assertDoesNotExist()
        scope.cancel()
    }

    // The ladder's four labels come from the golden by weight band; nothing here is a fixed ±1/±5.
    // And the pills are equal: none of the four is the small one any more.
    @Test
    fun theLadderLabelsComeFromTheGoldenAndThePillsAreEqual() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope)

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
        scope.cancel()
    }

    // The set in hand is named once, by its ledger row; a free session draws no target and no
    // `no target`.
    @Test
    fun theSetInHandIsNamedOnceAndAFreeSessionHasNoTarget() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope)

        assertEquals(listOf("Set 1, current" to false), ledger())
        compose.onAllNodes(hasText("Set 1")).assertCountEquals(1)
        compose.onAllNodes(hasText("SET 1")).assertCountEquals(0)
        compose.onAllNodes(hasText("no target")).assertCountEquals(0)
        compose.onAllNodes(hasText("target ", substring = true)).assertCountEquals(0)
        scope.cancel()
    }

    // The primary says its verb and nothing else — the two numerals stand directly above it.
    @Test
    fun theLogButtonEchoesNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope)

        compose.onNodeWithText("Log set").assertIsDisplayed().assertHasClickAction()
        compose.onAllNodes(hasText("Log set  ·  ", substring = true)).assertCountEquals(0)
        compose.onNodeWithText("Add movement").assertIsDisplayed().assertHasClickAction()
        compose.onNode(hasContentDescription("Gym settings")).assertIsDisplayed().assertHasClickAction()
        compose.onNode(hasContentDescription("one rep fewer")).assertHasClickAction()
        compose.onNode(hasContentDescription("one rep more")).assertHasClickAction()
        compose.onNode(hasContentDescription("Reps 5")).assertIsDisplayed().assertHasClickAction()
        scope.cancel()
    }
}
