package works.windmill.gym.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import works.windmill.gym.store.GymEngineSession
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.LocalGymEngineSession
import works.windmill.gym.store.LegacyGymMigration
import works.windmill.sync.engine.*
import works.windmill.sync.core.Json
import works.windmill.sync.schema.SyncSchema
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.hasText
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.OAuthGrant
import works.windmill.gym.domain.Units
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.gym.store.Withheld
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.design.WindmillMaterial

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class SettingsScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private fun editor(refusal: works.windmill.gym.store.LegacyMigrationRefusal,
        onSave: (LocalLog.FinishedSession, Boolean, Set<String>) -> Unit) {
        compose.setContent { WindmillMaterial { GymMaterial {
            MigrationWorkoutEditor(refusal, works.windmill.gym.domain.TheSix.movements, {}, onSave)
        } } }
    }

    @Test
    fun correctingNumberingRequiresTheExplicitChoiceAndPreservesOriginalIdsAndTimes() {
        val at = 1_800_000_000_123L
        val source = works.windmill.gym.domain.Session("session1", at, at + 120_000)
        val set = works.windmill.gym.domain.TrainingSet("set00001", "back-squat", setNumber = 3,
            weightKg = 80.0, reps = 5, completedAtMs = at + 1_234)
        val refusal = works.windmill.gym.store.LegacyMigrationRefusal("source", source, listOf(set), listOf("set00002"),
            "source-numbering", "The original set numbering cannot be kept.")
        val saved = mutableListOf<LocalLog.FinishedSession>()
        editor(refusal) { row, _, _ -> saved += row }
        compose.onNodeWithText("Save and retry").performClick()
        compose.runOnIdle { assertEquals(LocalLog.FinishedSession(source, listOf(set), listOf("set00002")), saved.single()) }
        compose.onAllNodes(isToggleable()).onFirst().performClick()
        compose.onNodeWithText("Save and retry").performClick()
        compose.runOnIdle { assertEquals(LocalLog.FinishedSession(source, listOf(set.copy(setNumber = 1)), listOf("set00002")), saved.last()) }
    }

    @Test
    fun correctingAnAutomaticFinishRequiresTheExplicitChoice() {
        val at = 1_800_000_000_123L
        val source = works.windmill.gym.domain.Session("session1", at, at + 120_000)
        val refusal = works.windmill.gym.store.LegacyMigrationRefusal("source", source, emptyList(), emptyList(),
            "source-auto-closed", "The automatic finish marker cannot be kept.")
        val saved = mutableListOf<LocalLog.FinishedSession>()
        val marked = mutableListOf<Boolean>()
        editor(refusal) { row, flag, _ -> saved += row; marked += flag }
        compose.onNodeWithText("Save and retry").performClick()
        compose.runOnIdle { assertEquals(emptyList<LocalLog.FinishedSession>(), saved) }
        compose.onNodeWithText("Choose Mark as finished to remove the automatic finish marker, or Cancel to keep it.").assertIsDisplayed()
        compose.onAllNodes(isToggleable()).onFirst().performClick()
        compose.onNodeWithText("Save and retry").performClick()
        compose.runOnIdle { assertEquals(source, saved.single().session); assertEquals(listOf(true), marked) }
    }

    @Test
    fun anUnfinishedWorkoutEditorKeepsTheStartOpenAndItsOriginalInstant() {
        val source = works.windmill.gym.domain.Session("session1", 1_800_000_000_123L)
        val refusal = works.windmill.gym.store.LegacyMigrationRefusal("source", source, emptyList(), emptyList(),
            "bad-instant", "Check the start time.")
        val saved = mutableListOf<LocalLog.FinishedSession>()
        editor(refusal) { row, _, _ -> saved += row }
        compose.onNodeWithText("Finished (yyyy-MM-dd HH:mm)").assertDoesNotExist()
        compose.onNodeWithText("Pending sets stay saved with this workout.").assertIsDisplayed()
        compose.onNodeWithText("Save and retry").performClick()
        compose.runOnIdle { assertEquals(source, saved.single().session) }
    }

    @Test
    fun anUnrecognizedSetKindRequiresAChoiceBeforeSaving() {
        val at = 1_800_000_000_123L
        val source = works.windmill.gym.domain.Session("session1", at, at + 120_000)
        val set = works.windmill.gym.domain.TrainingSet("set00001", "back-squat", weightKg = 80.0, reps = 5,
            completedAtMs = at + 1_234)
        val refusal = works.windmill.gym.store.LegacyMigrationRefusal("source", source, listOf(set), emptyList(),
            "source-kind", "Choose the kind of this set.", unrecognizedKindSetIds = listOf(set.id))
        val saved = mutableListOf<LocalLog.FinishedSession>()
        val kinds = mutableListOf<Set<String>>()
        editor(refusal) { row, _, ids -> saved += row; kinds += ids }
        compose.onNodeWithText("Save and retry").performClick()
        compose.runOnIdle { assertEquals(emptyList<LocalLog.FinishedSession>(), saved) }
        compose.onNodeWithText("Choose set kind").performScrollTo().performClick()
        compose.onNodeWithText("Working").performScrollTo().assertIsDisplayed().performClick()
        compose.onNodeWithText("Kind: Working").assertIsDisplayed()
        compose.onNodeWithText("Save and retry").performClick()
        compose.runOnIdle {
            assertEquals(LocalLog.FinishedSession(source, listOf(set)), saved.single())
            assertEquals(listOf(setOf(set.id)), kinds)
        }
    }

    private fun store(scope: CoroutineScope, server: FakeTraining, signedIn: Boolean): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope,
            sync = { if (it.isSignedIn) server else null },
        )
        runBlocking {
            store.connect(Account(
                api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
                user = if (signedIn) User(id = "u1", email = "sam@example.com", name = "Sam") else null,
            ))
        }
        return store
    }

    private fun settings(store: TrainingStore, signedIn: Boolean, opened: MutableList<String> = mutableListOf()) {
        compose.setContent {
            SettingsScreen(
                store = store,
                isSignedIn = signedIn,
                backTo = "routines",
                onBack = {},
                onNotes = { opened += "notes" },
                accountEmail = if (signedIn) "sam@example.com" else null,
                onAccount = { opened += "account" },
                onConnectedLog = { opened += "connected-log" },
                say = {},
            )
        }
    }

    @Test
    fun signedOutTrainingInvitesSignInWithoutTheRetiredClaimScreen() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val logFile = File(tmp.root, LocalLog.fileName)
        val movement = Exercise("ex_before", "Before", custom = true)
        LocalLog(logFile).hold(movement)
        val engine = Engine.memory(SyncSchema.registry)
        LegacyGymMigration(tmp.root, engine).run()
        val runtime = SyncRuntime(engine, unavailableTransport, memoryTokens, "test")
        val session = GymEngineSession(engine, runtime)
        val store = store(scope, FakeTraining(), signedIn = false)
        val opened = mutableListOf<String>()
        compose.setContent {
            CompositionLocalProvider(LocalGymEngineSession provides session) {
                SettingsScreen(store, false, "routines", {}, {}, {}, onAccount = { opened += "account" }, say = {})
            }
        }
        compose.onNodeWithText("Saved on this phone").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("1 movement").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("These are mine").assertDoesNotExist()
        compose.onNodeWithText("Not mine").assertDoesNotExist()
        compose.onNodeWithText("Sign in").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals(listOf("account"), opened)
            assertEquals(listOf(movement), LocalLog(logFile).exercises)
        }
        session.close()
        scope.cancel()
    }

    @Test
    fun anOpenWorkoutConflictCanBeInspectedAndExplicitlyKeptAsItsOwnFinishedImport() = openConflict(true)

    @Test
    fun anEmptyOpenWorkoutConflictCanBeKeptSeparatelyAtItsOriginalStart() = openConflict(false)

    private fun openConflict(hasSet: Boolean) = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = EngineRoomFixture.server()
        try {
            EngineRoomFixture(tmp.newFolder(), scope).use { remote ->
                remote.select("A")
                remote.now += 1_000_000
                remote.training.startSession(works.windmill.gym.domain.SessionStart("remote01", remote.now - 10_000, joinOpenSession = false))
                remote.training.appendSet("remote01", works.windmill.gym.domain.SetWrite("remoteset", "back-squat", 60.0, 5,
                    works.windmill.gym.domain.SetKind.Working, remote.now - 9_000))
                remote.sync(server)
                val directory = tmp.newFolder()
                val source = works.windmill.gym.domain.Session("source01", remote.now - 100_000)
                val set = works.windmill.gym.domain.TrainingSet("sourceset", "bench-press", weightKg = 82.5, reps = 5,
                    note = "Saved effort", completedAtMs = remote.now - 90_000)
                SetQueue(File(directory, SetQueue.fileName)).apply {
                    hold(source, unclaimed = true)
                    if (hasSet) store(set, source.id, needsPush = true)
                }
                EngineRoomFixture(directory, scope, rest = FakeTraining()).use { room ->
                    room.now = remote.now
                    LegacyGymMigration(directory, room.engine).run()
                    room.engine.signIn("A", mapOf("gym" to true), mapOf("gym" to "add"))
                    room.selected = "A"
                    room.sync(server)
                    room.store.connect(room.account())
                    GymEngineSession(room.engine, SyncRuntime(room.engine, unavailableTransport, memoryTokens, "test")).use { session ->
                        val visible = mutableStateOf(true)
                        try {
                        compose.setContent { if (visible.value) WindmillMaterial { GymMaterial {
                            CompositionLocalProvider(LocalGymEngineSession provides session) {
                                SettingsScreen(room.store, true, "routines", {}, {}, {}, say = {})
                            }
                        } } }
                        compose.onNodeWithText("Inspect workout").performScrollTo().assertIsDisplayed().performClick()
                        compose.onNodeWithText(if (hasSet) "Saved effort" else "No sets logged.").assertIsDisplayed()
                        compose.onNodeWithText("Close").performClick()
                        if (!hasSet) compose.onNodeWithText("Keep this empty workout separately by finishing it at its start time.").performScrollTo().assertIsDisplayed()
                        compose.onNodeWithText("Keep workout").performScrollTo().assertIsDisplayed().performClick()
                        compose.waitForIdle()
                        assertEquals(source.copy(finishedAtMs = if (hasSet) set.completedAtMs else source.startedAtMs), room.training.session(source.id)!!.session)
                        assertEquals(if (hasSet) listOf(set) else emptyList(), room.training.session(source.id)!!.sets)
                        assertEquals(works.windmill.sync.schema.Gym.Commands.importSession,
                            room.outbox().single().member("intent").member("cmd").member("name").str())
                        room.sync(server)
                        assertEquals(if (hasSet) listOf(set.copy(setNumber = 1)) else emptyList(), room.training.session(source.id)!!.sets)
                        assertEquals(listOf("remoteset"), room.training.session("remote01")!!.sets.map { it.id })
                        } finally { compose.runOnIdle { visible.value = false }; compose.waitForIdle() }
                    }
                }
            }
        } finally { scope.cancel() }
    }

    @Test
    fun inspectingAnOversizedRefusedWorkoutReachesEverySetWithoutChangingOrHidingItsSource() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try {
            val directory = tmp.newFolder()
            val at = 1_800_000_000_000L
            val source = LocalLog.FinishedSession(works.windmill.gym.domain.Session("source01", at - 10_000, at - 5_000),
                (0..200).map { index -> works.windmill.gym.domain.TrainingSet("set${index.toString().padStart(5, '0')}", "bench-press",
                    weightKg = 82.5, reps = 5, note = if (index == 200) "Last set" else "Set $index", completedAtMs = at - 9_000 + index) })
            LocalLog(File(directory, LocalLog.fileName)).hold(source)
            val raw = File(directory, LocalLog.fileName).readText()
            EngineRoomFixture(directory, scope, rest = FakeTraining()).use { room ->
                LegacyGymMigration(directory, room.engine).run()
                room.store.connect(room.account(null))
                GymEngineSession(room.engine, SyncRuntime(room.engine, unavailableTransport, memoryTokens, "test")).use { session ->
                    val visible = mutableStateOf(true)
                    try {
                        compose.setContent { if (visible.value) WindmillMaterial { GymMaterial {
                            CompositionLocalProvider(LocalGymEngineSession provides session) {
                                SettingsScreen(room.store, false, "routines", {}, {}, {}, say = {})
                            }
                        } } }
                        compose.onNodeWithText("Inspect workout").performScrollTo().performClick()
                        compose.onNodeWithTag("savedWorkoutSets").performScrollToNode(hasText("Last set"))
                        compose.onNodeWithText("Last set").assertIsDisplayed()
                        compose.onNodeWithText("Close").performClick()
                        compose.onNodeWithText("Inspect workout").performScrollTo().assertIsDisplayed()
                        assertEquals(source, room.training.session(source.session.id)?.let { LocalLog.FinishedSession(it.session, it.sets) })
                        assertEquals(raw, File(directory, LocalLog.fileName).readText())
                    } finally { compose.runOnIdle { visible.value = false }; compose.waitForIdle() }
                }
            }
        } finally { scope.cancel() }
    }

    // No export door anywhere in gym: the row went, and with it the one browser glyph this screen
    // carried. Nothing on the screen names an export.
    @Test
    fun testThereIsNoCsvDoorAndNoBrowserGlyphOnTheSettingsScreen() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        settings(store(scope, FakeTraining(), signedIn = true), signedIn = true)

        compose.onNodeWithText("CSV export").assertDoesNotExist()
        compose.onAllNodesWithText("export", substring = true, ignoreCase = true).assertCountEquals(0)
        compose.onAllNodesWithText("CSV", substring = true).assertCountEquals(0)
        compose.onAllNodes(hasContentDescription(ConnectedLog.opensInBrowser), useUnmergedTree = true)
            .assertCountEquals(0)
        scope.cancel()
    }

    // The row prints the state and nothing else, and opens the screen where the words are. Signed in
    // with one tool the meta is that tool and its levels; no pitch, no precondition, no caption.
    @Test
    fun testTheConnectedLogRowPrintsTheStateAndOpensTheScreen() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.grants += OAuthGrant(clientId = "c1", name = "Claude Desktop", grantedMs = 1L, scope = "gym:read gym:write")
        val opened = mutableListOf<String>()
        settings(store(scope, server, signedIn = true), signedIn = true, opened)

        compose.onNodeWithText("Claude Desktop · read · write").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.head).assertDoesNotExist()
        compose.onNodeWithText(ConnectedLog.caption).assertDoesNotExist()
        compose.onNodeWithText(ConnectedLog.action).assertDoesNotExist()
        compose.onAllNodesWithText("free", substring = true, ignoreCase = true).assertCountEquals(0)
        compose.onNodeWithText(ConnectedLog.title).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("connected-log"), opened) }
        scope.cancel()
    }

    // Signed out nothing reaches a device-local log, and the row says so as a state rather than as a
    // sentence about signing in.
    @Test
    fun testSignedOutTheRowSaysNothingIsConnected() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        settings(store(scope, FakeTraining(), signedIn = false), signedIn = false)

        compose.onNodeWithText(ConnectedLog.settingsNone).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(ConnectedLog.settingsUnknown).assertDoesNotExist()
        scope.cancel()
    }

    // Either credential read failing leaves the row on the meta that claims nothing.
    @Test
    fun testARefusedReadLeavesTheRowClaimingNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        server.refuseKeys = IllegalStateException("down")
        settings(store(scope, server, signedIn = true), signedIn = true)

        compose.onNodeWithText(ConnectedLog.settingsUnknown).performScrollTo().assertIsDisplayed()
        scope.cancel()
    }

    // The bar names the screen, and nothing else does: the head line that used to say what the
    // screen was for is gone, because the platform's title already says it.
    @Test
    fun testTheBarNamesTheScreenAndNoHeadLineRepeatsIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        settings(store(scope, FakeTraining(), signedIn = true), signedIn = true)

        compose.onNodeWithText("Gym settings").assertIsDisplayed()
        compose.onNodeWithText("how this room behaves at the rack").assertDoesNotExist()
        scope.cancel()
    }

    // A caption is drawn only in the state it describes: on kg the pounds clause is a sentence about
    // nothing. Tapping `lb` writes the answer and the clause arrives with it.
    @Test
    fun testThePoundsClauseIsDrawnUnderPoundsAndNowhereElse() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope, FakeTraining(), signedIn = true)
        settings(store, signedIn = true)

        assertEquals(Units.Kilograms, store.preferences.units)
        compose.onNodeWithText(Bodyweight.kilogramsOnly).assertDoesNotExist()

        compose.onNodeWithText(Units.Pounds.wire).performScrollTo().performClick()
        compose.onNodeWithText(Bodyweight.kilogramsOnly).performScrollTo().assertIsDisplayed()
        scope.cancel()
    }

    @Test
    fun unitsRemainEditableWithoutRestControls() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val preferences = GymPreferences(confirmHaptic = true, confirmSound = true)
        val server = FakeTraining().apply { settings = preferences }
        val store = store(scope, server, signedIn = true)
        settings(store, signedIn = true)

        compose.onAllNodesWithText("rest", substring = true, ignoreCase = true).assertCountEquals(0)
        compose.onNodeWithText("At the rack").assertDoesNotExist()
        compose.onNodeWithText("lb").performClick()
        compose.runOnIdle {
            assertEquals(preferences.copy(units = Units.Pounds), store.preferences)
            assertEquals(store.preferences, server.settings)
        }
        scope.cancel()
    }

    @Test
    fun theAccountRowShowsTheCurrentEmailAndOpensTheAccountSheet() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val opened = mutableListOf<String>()
        settings(store(scope, FakeTraining(), signedIn = true), signedIn = true, opened)

        compose.onNodeWithText("sam@example.com").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Account").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("account"), opened) }
        scope.cancel()
    }

    // The shelf's discard is one tap and nine seconds of Undo, in place of an arm-and-relabel that
    // had no cancel and no timeout. The WHOLE row goes with it — the store holds the shelf for the
    // length of the window, so a claim button left drawing could take training a pending discard
    // wipes nine seconds later.
    @Test
    fun selectingAnAccountKeepsSignedOutTrainingAwayFromSettingsClaims() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val logFile = File(tmp.root, LocalLog.fileName)
        val movement = Exercise("ex_elsewhere", "Somebody’s", custom = true)
        LocalLog(logFile).hold(movement)
        val store = store(scope, FakeTraining(), signedIn = true)
        settings(store, signedIn = true)
        compose.onNodeWithText("These are mine").assertDoesNotExist()
        compose.onNodeWithText("Not mine").assertDoesNotExist()
        compose.onNodeWithText("Delete for good?").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf(movement), LocalLog(logFile).exercises) }
        scope.cancel()
    }

    private val unavailableTransport = object : SyncTransport {
        override suspend fun hello(token: String?) = Reply.Unreachable
        override suspend fun push(request: Json, token: String) = Reply.Unreachable
        override suspend fun pull(request: Json, token: String?) = Reply.Unreachable
        override suspend fun openLive(token: String) = Reply.Unreachable
    }
    private val memoryTokens = object : SessionTokens {
        override fun token(account: String): String? = null
        override fun save(account: String, token: String) = Unit
        override fun delete(account: String) = Unit
        override fun accounts(): Set<String> = emptySet()
    }
}
