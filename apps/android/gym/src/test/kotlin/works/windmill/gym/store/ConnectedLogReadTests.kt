package works.windmill.gym.store

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.ConnectedLog
import works.windmill.gym.presentation.ConnectedLogState
import works.windmill.gym.presentation.McpKey
import works.windmill.gym.presentation.OAuthGrant
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.net.GymRest
import works.windmill.platform.Account

class ConnectedLogReadTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun anUnfinishedPairIsUnknownAndAResponseFromBeforeAnOwnerRoundTripNeverPublishes() = runTest {
        val release = CompletableDeferred<Unit>()
        var reads = 0
        val server = object : GymRest by FakeGymRest() {
            override suspend fun grants(): List<OAuthGrant> {
                val ordinal = ++reads
                if (ordinal == 1) release.await()
                return listOf(OAuthGrant("grant", if (ordinal == 1) "Old grant" else "Current grant", 1, "gym:read"))
            }
            override suspend fun mcpKeys() = listOf(McpKey("key", "Static", 2))
        }
        EngineRoomFixture(tmp.newFolder(), this, rest = server).use { phone ->
            phone.select("u1")
            val pending = async { phone.store.refreshConnectedLog() }
            runCurrent()
            assertEquals(ConnectedLogState.Unknown, phone.store.connectedLog)
            phone.select("u2"); phone.select("u1")
            release.complete(Unit)
            assertEquals(ConnectedLogState.Refused, pending.await())
            assertEquals(ConnectedLogState.Unknown, phone.store.connectedLog)
            val current = phone.store.readConnectedLog()
            assertEquals(ConnectedLog.state(listOf(OAuthGrant("grant", "Current grant", 1, "gym:read")),
                listOf(McpKey("key", "Static", 2))), current)
            assertEquals(current, phone.store.connectedLog)
        }
    }

    @Test fun aCredentialReadBeforeAnIdentityRevisionChangeCannotFillTheNewSeat() = runTest {
        val release = CompletableDeferred<Unit>()
        val server = object : GymRest by FakeGymRest() {
            override suspend fun grants(): List<OAuthGrant> { release.await(); return listOf(OAuthGrant("old", "Old", 1, "gym:read")) }
            override suspend fun mcpKeys() = emptyList<McpKey>()
        }
        EngineRoomFixture(tmp.newFolder(), this, rest = server).use { phone ->
            phone.select("u1")
            val pending = async { phone.store.refreshConnectedLog() }
            runCurrent()
            val original = phone.account()
            phone.store.connect(Account(original.origin, original.user, identityRevision = 1))
            release.complete(Unit)
            assertEquals(ConnectedLogState.Refused, pending.await())
            assertEquals(ConnectedLogState.Unknown, phone.store.connectedLog)
        }
    }

    @Test fun aMissingAuthenticatedTransportIsUnreadAndAnAnonymousPhoneMakesNoCredentialRead() = runTest {
        EngineRoomFixture(tmp.newFolder(), this).use { phone ->
            phone.select("u1")
            assertEquals(ConnectedLogState.Refused, phone.store.refreshConnectedLog())
            assertEquals(ConnectedLogState.Refused, phone.store.connectedLog)
            phone.select(null)
            assertEquals(ConnectedLogState.None, phone.store.refreshConnectedLog())
        }
    }
}
