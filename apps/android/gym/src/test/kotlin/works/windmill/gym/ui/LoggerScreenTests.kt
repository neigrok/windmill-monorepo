package works.windmill.gym.ui

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import org.junit.Assert.assertTrue
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.LiveLines
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

// The quiet logger: the words the old screen drew are now said by the controls that own them, and
// each pin here reads a control by its name. Signed in against the fake log, so a set that is
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
        lastTimeDown: Boolean = false,
        offline: Boolean = false,
    ): TrainingStore {
        val server = FakeTraining()
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
            // No undo window here, so a logged set LANDS inside `logSet` rather than nine seconds
            // later: the pill pins want a set the log holds.
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
            if (logged) store.logSet(60.0, 5)
        }
        compose.setContent {
            LoggerScreen(store = store, isSignedIn = true, say = {}, onFinish = {}, onSignIn = {}, onSettings = {})
        }
        return store
    }

    // The fake log with its last-time read down and nothing else.
    private fun down(server: FakeTraining): TrainingSyncing = object : TrainingSyncing by server {
        override suspend fun lastTime(exerciseId: String): LastTime = throw IOException("the log is down")
    }

    private fun kindChip() = compose.onNode(hasContentDescription("Set kind"))

    private fun walk() = compose.onNode(hasContentDescription("Movement 1 of 3"))

    private fun addMovement() = compose.onNode(hasContentDescription("Add movement"))

    private fun pills() = compose.onAllNodes(hasContentDescription("Set 1, ", substring = true))

    // The dots and the `+` are pinned above the hairline, outside the scroller: a landed set's
    // clocks and strip push the head up, never the walk off the screen — and the rack under the
    // hairline does not move by a pixel.
    private fun theWalkStaysOnScreenWhenASetLands() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope)
        val rack = compose.onNodeWithText("Log set").assertIsDisplayed().getBoundsInRoot()
        walk().assertIsDisplayed()
        // A node the scroller has clipped still reads as displayed while a sliver of it shows, so
        // the claim is the whole button: its full height, at the bounds it had before the set.
        val add = addMovement().assertIsDisplayed().getBoundsInRoot()
        assertEquals(GymTap.minimum, add.height)

        compose.onNodeWithText("Log set").performClick()
        compose.waitForIdle()

        compose.onNode(hasContentDescription("resting  ·  ", substring = true)).assertIsDisplayed()
        pills().assertCountEquals(1)
        walk().assertIsDisplayed()
        assertEquals("the walk did not move", add, addMovement().assertIsDisplayed().getBoundsInRoot())
        assertEquals("the rack did not move", rack, compose.onNodeWithText("Log set").getBoundsInRoot())
        scope.cancel()
    }

    @Test
    @Config(sdk = [35], qualifiers = "w411dp-h683dp-xhdpi")
    fun theWalkStaysOnScreenWhenASetLandsAtTheEmulatorsFrame() = theWalkStaysOnScreenWhenASetLands()

    @Test
    @Config(sdk = [35], qualifiers = "w360dp-h780dp-xhdpi")
    fun theWalkStaysOnScreenWhenASetLandsOnTheSmallestFrame() = theWalkStaysOnScreenWhenASetLands()

    // A set deleted from the strip's own sheet stays off the strip once its window settles, and the
    // set line counts it gone.
    @Test
    fun aSetDeletedFromTheStripStaysOffItWhenTheWindowSettles() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope, logged = true)
        compose.onAllNodes(hasText("Set 2")).assertCountEquals(1)

        pills().onFirst().performClick()
        compose.onNodeWithText("Delete set").performClick()
        compose.waitForIdle()

        compose.runOnIdle { assertTrue("the window settled", store.withheld.isEmpty()) }
        pills().assertCountEquals(0)
        compose.onAllNodes(hasText("Set 1")).assertCountEquals(1)
        compose.onAllNodes(hasText("Set 2")).assertCountEquals(0)
        scope.cancel()
    }

    // A last time with a session and no set in it is no history: nothing is drawn, and nothing
    // crashes reaching for a set that is not there.
    @Test
    fun aLastTimeWithNoSetsDrawsNoChip() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val history = LastTime(
            exerciseId = "bench-press",
            session = Session(id = "ses_0", startedAtMs = day, finishedAtMs = day + 1),
            routine = "Push B",
            sets = emptyList(),
        )
        logger(scope, lastTime = history)

        compose.onNodeWithText("Log set").assertIsDisplayed()
        compose.onAllNodes(hasContentDescription("Last time", substring = true)).assertCountEquals(0)
        scope.cancel()
    }

    // The chip stands in for the coming WORKING set: last time's warmup is never its first set, the
    // second working set follows the first landing, and past the end the last working set stands.
    @Test
    fun theLastTimeChipSkipsLastTimesWarmupsAndFollowsTheWorkingCount() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val history = LastTime(
            exerciseId = "bench-press",
            session = Session(id = "ses_0", startedAtMs = day, finishedAtMs = day + 1),
            sets = listOf(
                TrainingSet(id = "p0", exerciseId = "bench-press", weightKg = 40.0, reps = 10,
                            kind = SetKind.Warmup, completedAtMs = day - 1),
                TrainingSet(id = "p1", exerciseId = "bench-press", weightKg = 80.0, reps = 5,
                            kind = SetKind.Working, completedAtMs = day),
                TrainingSet(id = "p2", exerciseId = "bench-press", weightKg = 82.5, reps = 3,
                            kind = SetKind.Working, completedAtMs = day + 1),
            ),
        )
        logger(scope, lastTime = history)
        val chip = compose.onNode(hasContentDescription("Last time · ", substring = true))
        chip.assert(hasText("80 kg × 5"))

        compose.onNodeWithText("Log set").performClick()
        compose.waitForIdle()
        chip.assert(hasText("82.5 kg × 3"))

        compose.onNodeWithText("Log set").performClick()
        compose.waitForIdle()
        chip.assert(hasText("82.5 kg × 3"))
        scope.cancel()
    }

    // A set still on this device is fixed in the queue it waits in: the pill is a door like any
    // other, the strip redraws the correction from the store, and the set is still owed — with the
    // corrected body.
    @Test
    fun aPillStillOnThisDeviceIsFixableAndTheStripDrawsTheFix() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope, logged = true, offline = true)
        compose.runOnIdle { assertEquals(1, store.stalled.size) }
        compose.onAllNodes(hasContentDescription("fix it once it lands", substring = true)).assertCountEquals(0)
        val pill = compose.onNode(hasContentDescription("Set 1, 60 × 5"))
        pill.assertIsDisplayed()
        pill.assertHasClickAction()
        compose.onNode(hasContentDescription(LiveLines.onThisDevice)).assertExists()

        pill.performClick()
        compose.onNodeWithText("Fix this set").assertIsDisplayed()
        compose.onNodeWithText("+").performClick()
        compose.onNodeWithText("Save the fix").performClick()
        compose.waitForIdle()

        compose.onNode(hasContentDescription("Set 1, 60 × 6")).assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(listOf(6), store.sets.map { it.reps })
            assertEquals("still owed, and the corrected body is what will land", 1, store.stalled.size)
        }
        scope.cancel()
    }

    private fun state(said: String) = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, said)

    // The four-segment row is gone; the kind is one chip whose menu holds the four, and it disarms
    // itself the moment a set lands so a warmup left on cannot file the working sets after it.
    @Test
    fun theKindChipPicksAKindAndDisarmsWhenASetLands() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = logger(scope)

        kindChip().assert(state("working"))
        kindChip().performClick()
        compose.onNodeWithText("warmup").performClick()
        kindChip().assert(state("warmup"))

        compose.onNodeWithText("Log set").performClick()
        compose.waitForIdle()
        compose.runOnIdle {
            assertEquals("the set went in as the kind the chip held", SetKind.Warmup, store.sets.single().kind)
        }
        kindChip().assert(state("working"))
        scope.cancel()
    }

    // No history is an absence: nothing is drawn for it, not a chip and not a sentence.
    @Test
    fun theLastTimeChipIsAbsentWithoutHistory() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope)

        compose.onAllNodes(hasContentDescription("Last time", substring = true)).assertCountEquals(0)
        compose.onAllNodes(hasContentDescription("First time", substring = true)).assertCountEquals(0)
        compose.onAllNodes(hasContentDescription("no history", substring = true)).assertCountEquals(0)
        compose.onAllNodes(hasText("First time logging this")).assertCountEquals(0)
        compose.onAllNodes(hasText("no history", substring = true)).assertCountEquals(0)
        compose.onAllNodes(hasText("didn’t load")).assertCountEquals(0)
        scope.cancel()
    }

    // A read that missed must never draw as no history: it draws a chip, and the chip says so.
    @Test
    fun aFailedLastTimeReadDrawsAChipThatSaysSo() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope, lastTimeDown = true)

        compose.onNode(hasContentDescription("Last time: the log didn’t answer"))
            .assertIsDisplayed()
            .assert(hasText("didn’t load"))
        scope.cancel()
    }

    // With history the chip draws last time's set at the coming ordinal, SAYS the whole card, and
    // its menu dials the rack to any of last time's sets.
    @Test
    fun theLastTimeChipDrawsOneSetSaysTheCardAndDialsAPastSet() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val history = LastTime(
            exerciseId = "bench-press",
            session = Session(id = "ses_0", startedAtMs = day, finishedAtMs = day + 1),
            routine = "Push B",
            sets = listOf(
                TrainingSet(id = "p1", exerciseId = "bench-press", weightKg = 80.0, reps = 5,
                            kind = SetKind.Working, completedAtMs = day),
                TrainingSet(id = "p2", exerciseId = "bench-press", weightKg = 82.5, reps = 3,
                            kind = SetKind.Working, completedAtMs = day + 1),
            ),
        )
        logger(scope, lastTime = history)

        val chip = compose.onNode(hasContentDescription("Last time · ", substring = true))
        chip.assertIsDisplayed()
        chip.assert(hasText("80 kg × 5"))
        chip.assert(hasContentDescription("  ·  Push B: 80 × 5,   82.5 × 3", substring = true))

        chip.performClick()
        compose.onNodeWithText("82.5 × 3").performClick()
        compose.onNode(hasContentDescription("Weight 82.5 kg")).assertIsDisplayed()
        compose.onNode(hasContentDescription("Reps 3")).assertIsDisplayed()
        scope.cancel()
    }

    // A landed set is a pill, and the pill is the drawn, named door to the fix.
    @Test
    fun aLoggedPillOpensTheFixSheet() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope, logged = true)

        val pill = compose.onNode(hasContentDescription("Set 1, 60 × 5"))
        pill.assertIsDisplayed()
        pill.assertHasClickAction()
        pill.performClick()
        compose.onNodeWithText("Fix this set").assertIsDisplayed()
        scope.cancel()
    }

    // The words the old row drew are still said by the one merged node, byte for byte, with the
    // clock after them.
    @Test
    fun theClocksRowSaysTheOldBytes() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope, logged = true)

        val clocks = compose.onNode(hasContentDescription("resting  ·  ", substring = true))
        clocks.assertIsDisplayed()
        clocks.assertHasClickAction()
        compose.onAllNodes(hasText("resting")).assertCountEquals(0)
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

    // The set line is the domain's `set 1` capitalised, once; the numeral above the rack no longer
    // says it, and a free session draws no target tail and no `no target`.
    @Test
    fun theSetLineIsDrawnOnceAndAFreeSessionHasNoTargetTail() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope)

        compose.onAllNodes(hasText("Set 1")).assertCountEquals(1)
        compose.onAllNodes(hasText("SET 1")).assertCountEquals(0)
        compose.onAllNodes(hasText("no target")).assertCountEquals(0)
        compose.onAllNodes(hasText("target", substring = true)).assertCountEquals(0)
        scope.cancel()
    }

    // The primary says its verb and nothing else — the two numerals stand directly above it.
    @Test
    fun theLogButtonEchoesNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        logger(scope)

        compose.onNodeWithText("Log set").assertIsDisplayed().assertHasClickAction()
        compose.onAllNodes(hasText("Log set  ·  ", substring = true)).assertCountEquals(0)
        compose.onNode(hasContentDescription("Add movement")).assertIsDisplayed().assertHasClickAction()
        compose.onNode(hasContentDescription("Gym settings")).assertIsDisplayed().assertHasClickAction()
        compose.onNode(hasContentDescription("one rep fewer")).assertHasClickAction()
        compose.onNode(hasContentDescription("one rep more")).assertHasClickAction()
        compose.onNode(hasContentDescription("Reps 5")).assertIsDisplayed().assertHasClickAction()
        scope.cancel()
    }
}
