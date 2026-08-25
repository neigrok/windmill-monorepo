package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.io.File
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
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ProposalScreenTests {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun turningAProposalDownIsConfirmedInThePinnedWordsAndKeepingItDecidesNothing() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val server = FakeTraining()
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
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
        server.propose(Proposal(
            id = "prop_1", routineId = kept.id, state = ProposalState.Pending,
            summary = "Heavier triples.", changeCount = 1, createdAtMs = 1_000,
            source = ProposalSource(agent = "Claude"), baseRevision = kept.revision,
            baseName = "Push Day", name = "Push Day",
            changes = listOf(ProposalChange(
                position = 1, kind = ChangeKind.Retargeted, exerciseId = "bench-press",
                before = ProposalTargets(sets = 3, reps = 5), after = ProposalTargets(sets = 5, reps = 3),
            )),
        ))

        compose.setContent {
            ProposalScreen(
                proposalId = "prop_1",
                routineId = kept.id,
                store = store,
                backLabel = "Push Day",
                onBack = {},
            )
        }

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
        }
        compose.onNodeWithText("Turn this down?").assertDoesNotExist()
        compose.onNodeWithText("Nothing changed, and it stays in the routine’s history as a record.", substring = true)
            .assertIsDisplayed()
        scope.cancel()
    }
}
