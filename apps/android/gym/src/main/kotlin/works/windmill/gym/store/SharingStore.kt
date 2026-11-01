package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import works.windmill.gym.net.GymRest
import works.windmill.gym.presentation.ConnectedLog
import works.windmill.gym.presentation.ConnectedLogState
import works.windmill.gym.sharing.SessionShare
import works.windmill.platform.net.WindmillApiException

// Sharing the account's training: the apps connected to its log, and a workout's share link. Both are the
// account's REST doors, so signed out nothing is asked.
class SharingStore(
    private val seat: TrainingSeat,
    private val training: EngineTraining,
    private val rest: () -> GymRest?,
) {
    // What reaches this account's log, as the shell last answered for the seat in hand. Held by the
    // ROOM so the settings row and the connected-log screen read one answer, and read once per
    // seat: `connect` drops it on arrival and `readConnectedLog` asks only while nothing is held.
    var connectedLog: ConnectedLogState by mutableStateOf(ConnectedLogState.Unknown)
        private set
    var connectedLogGeneration by mutableLongStateOf(0L)
        private set

    internal fun forgetSeat() {
        connectedLog = ConnectedLogState.Unknown
        connectedRead += 1
        connectedLogGeneration += 1
    }

    // What a screen asks on the way in: the answer already held for this seat, or the read that
    // gets one. A refused read is not an answer, so the next screen in asks again.
    suspend fun readConnectedLog(): ConnectedLogState {
        if (connectedLog.answered) return connectedLog
        return refreshConnectedLog()
    }

    // The forced read — pull-to-refresh. Both lists or neither: a static key reaches the same tools
    // and never appears among the grants, so either read failing makes the answer a refusal rather
    // than an undercount. Signed out the log is this device's and nothing reaches it.
    private var connectedRead = 0L

    suspend fun refreshConnectedLog(): ConnectedLogState {
        val request = ++connectedRead
        val owner = seat.owner
        val replica = training.engine.activeReplica()
        val credentials = rest()
        if (owner == null) {
            connectedLog = ConnectedLogState.None
            return connectedLog
        }
        if (credentials == null) {
            connectedLog = ConnectedLogState.Refused
            return connectedLog
        }
        val read = try {
            coroutineScope {
                val grants = async { credentials.grants() }
                val keys = async { credentials.mcpKeys() }
                ConnectedLog.state(grants.await(), keys.await())
            }
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            seat.reportFailure("gym.refreshConnectedLog", refusing)
            if (refusing == WindmillApiException.Offline) ConnectedLogState.Offline else ConnectedLogState.Refused
        }
        if (owner != seat.owner || replica != training.engine.activeReplica() || request != connectedRead) return ConnectedLogState.Refused
        connectedLog = read
        return read
    }

    // Both answer with what went wrong: a link that was not made and one still live after a failed
    // revoke are both facts a lifter has to be told.
    suspend fun share(sessionId: String): GymResult<SessionShare> {
        val links = rest() ?: return GymResult.Failed(WriteFailure.Refused(signInFirst))
        return try {
            GymResult.Ok(links.share(sessionId))
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            seat.reportFailure("gym.share", refusing)
            GymResult.Failed(WriteFailure(refusing))
        }
    }

    suspend fun revokeShare(sessionId: String): WriteFailure? {
        val links = rest() ?: return WriteFailure.Refused(signInFirst)
        return try {
            links.revokeShare(sessionId)
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            seat.reportFailure("gym.revokeShare", refusing)
            WriteFailure(refusing)
        }
    }

    internal companion object {
        const val signInFirst = "Sign in first."
    }
}
