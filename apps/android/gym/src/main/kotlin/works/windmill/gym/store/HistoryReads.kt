package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.MovementRecord
import works.windmill.gym.presentation.Program
import works.windmill.gym.presentation.Review
import works.windmill.gym.presentation.Session
import works.windmill.gym.presentation.SessionDetail
import works.windmill.gym.presentation.SessionSummary
import works.windmill.gym.presentation.StatsProgress
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.store.TrainingSeat.Companion.accountChanged
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.engine.Pulls

// The account's history as this phone reads it: the log's pages and foot, the details it has opened, a movement's
// record, a routine's history and the progress read.
class HistoryReads(
    private val seat: TrainingSeat,
    private val held: HeldDeletes,
    private val controls: WorkoutControls,
    private val training: EngineTraining,
    private val routines: RoutinesStore,
    private val recovery: RecoveryStore,
    private val scope: CoroutineScope,
    private val telemetry: Telemetry,
    // Asks the sync runtime for the account's copy again; false when it is not pulling.
    internal val pullAgain: suspend () -> Boolean,
    private val pulls: StateFlow<Pulls>,
    // The live workout follows the replica's open one at the end of every log read, inside the read's lock.
    private val followOpenWorkout: suspend (Session?) -> Unit,
) {
    var logged: List<SessionSummary> by mutableStateOf(emptyList())      // the account's pages, newest first
        private set
    private val logRead = Mutex()

    var shelved: List<SessionSummary> by mutableStateOf(emptyList())     // refused imports kept on this phone
        internal set
    // Both, merged on the clock: everything the account and this device hold between them, which is
    // what the log's empty stance and the first-session line are read from.
    val allSessions: List<SessionSummary>
        get() = (logged + shelved).sortedByDescending { it.startedAtMs }
    // A session inside its undo window is off the log as far as every screen is concerned; only Undo
    // puts it back.
    val recent: List<SessionSummary>
        get() = allSessions.filterNot { it.id in held.withheldIds }
    private var foot: Older by mutableStateOf(Older.More)
    // How the sync runtime's pulls stand, as the screens read them, and how they stood when Retry last asked for one.
    var pulled: Pulls by mutableStateOf(pulls.value)
        private set
    private var retried: Pulls? by mutableStateOf(null)
    // Before the first pull the phone holds part of the account at most, the same completeness the record page reads:
    // the log's end is unknown, so a short or unanswered page's foot is still reading rather than claiming a first
    // workout, until no pull of this replica can run or the latest failed since Retry asked for one.
    private val logUnread: Boolean get() = !training.anonymous && !training.firstPullComplete
    val historyRead: Boolean get() = !logUnread
    private fun footAfter(page: List<SessionSummary>?): Older = when {
        page != null && page.size >= logPage -> Older.More
        logUnread -> Older.Reading
        page == null -> Older.Failed
        else -> Older.End
    }
    val older: Older get() =
        if (foot == Older.Reading && pulled.replica == controls.engineReplica && pulled.stalled(retried)) Older.Failed else foot
    // The first pull's wait as the person sees it: the screen shows its bar once the wait passes 400 ms, and how the wait
    // ended is told once, `read` when the pull lands and `failed` when the foot turns to Retry.
    var readingShown by mutableStateOf(false)
        private set
    fun showReading() {
        if (older != Older.Reading || readingShown) return
        readingShown = true
        telemetry.event("gym_action", mapOf("screen" to "log", "action" to "first_pull", "state" to "shown"))
    }
    private fun footSettled(now: Older) {
        if (now == Older.Reading || now == Older.Loading || !readingShown) return
        readingShown = false
        telemetry.event("gym_action", mapOf("screen" to "log", "action" to "first_pull", "outcome" to if (now == Older.Failed) "failed" else "read"))
    }

    // The foot follows the sync runtime's pulls, and tells once how the first pull's wait ended.
    internal fun observePulls() {
        scope.launch { pulls.collect { pulled = it } }
        scope.launch { snapshotFlow { older }.collect { footSettled(it) } }
    }

    private val progressRead = Mutex()
    private var progressRevision = 0L
    internal var progressWanted = false
        private set
    private var progressCache: StatsProgress? by mutableStateOf(null)
    var progressLoading by mutableStateOf(false)
        private set
    var progressFailure: WriteFailure? by mutableStateOf(null)
        private set
    val progress: StatsProgress?
        get() {
            val read = progressCache ?: return null
            val heldSessions = held.withheld.mapNotNull { (it.deletion as? Deletion.Session)?.sessionId }.toSet()
            return read.without(heldSessions)
        }

    internal var logReadReady by mutableStateOf(false)
        private set

    private var closedDetails by mutableStateOf<Map<String, SessionDetail>>(emptyMap())

    // Signed out, every drawn row is on this device and nowhere else; signed in, only the ones the
    // account has not confirmed. A deleted row is not drawn.
    internal data class DeliveryRead(val pending: Set<String> = emptySet(), val confirmed: Map<String, TrainingSet> = emptyMap())
    internal var deliveryRead by mutableStateOf(DeliveryRead())
    internal fun readDelivery(): DeliveryRead {
        val pending = training.pendingSetIds()
        return DeliveryRead(pending, training.details().flatMap { it.sets }.filterNot { it.id in pending }.associateBy { it.id })
    }

    internal fun shelfDetail(id: String): SessionDetail? =
        training.imports.refusals().firstOrNull { it.id == id }?.let { refused ->
            refused.session?.let { SessionDetail(it, refused.sets) }
        } ?: training.imports.pendingFinished().firstOrNull { it.session.id == id }?.let { row ->
            SessionDetail(row.session, row.sets.filterNot { it.id in row.deleted })
        }

    internal suspend fun refusedImports(): List<SessionSummary> = seat.readTraining {
        val drawn = training.details().mapTo(mutableSetOf()) { it.session.id }
        training.imports.refusals().mapNotNull { refused -> refused.session?.let { session ->
            SessionSummary(session, refused.sets, routines.catalog)
        } }.filterNot { it.id in drawn }
    }

    fun retainedSession(detail: SessionDetail): SessionDetail = closedDetails[detail.session.id] ?: detail

    suspend fun finishedSession(sessionId: String): GymResult<SessionDetail?> {
        val owner = seat.owner
        val replica = controls.engineReplica
        if (!seat.accountReady || replica == null || replica != training.engine.activeReplica() || (owner == null) != training.anonymous)
            return GymResult.Failed(WriteFailure.Refused(accountChanged))
        val detail = try { seat.readTraining { shelfDetail(sessionId) ?: training.restoredSession(sessionId) } }
        catch (_: TrainingReadChanged) { return GymResult.Failed(WriteFailure.Refused(accountChanged)) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            seat.reportFailure("gym.loadLog", failure)
            return GymResult.Failed(WriteFailure.NoAnswer)
        }
        if (!seat.accountReady || owner != seat.owner || replica != controls.engineReplica || replica != training.engine.activeReplica() ||
            (owner == null) != training.anonymous) return GymResult.Failed(WriteFailure.Refused(accountChanged))
        if (detail == null) closedDetails = closedDetails - sessionId
        else if (!detail.session.isOpen) retainClosed(detail)
        return GymResult.Ok(detail)
    }

    internal fun retainClosed(detail: SessionDetail) {
        closedDetails = closedDetails + (detail.session.id to detail)
    }

    // A detail read again replaces the copy this room retained of it.
    internal fun refreshRetained(details: List<SessionDetail>) {
        for (detail in details) if (!detail.session.isOpen && detail.session.id in closedDetails) retainClosed(detail)
    }

    internal fun changeRetained(sessionId: String, oldId: String, set: TrainingSet?) {
        closedDetails = closedDetails.mapValues { (_, detail) ->
            if (detail.session.id != sessionId) detail
            else detail.copy(sets = detail.sets.mapNotNull { if (it.id == oldId) set else it })
        }
    }

    // A discarded workout leaves the log's rows and this room's retained copy at once.
    internal fun discarded(sessionId: String) {
        logged = logged.filterNot { it.id == sessionId }
        closedDetails = closedDetails - sessionId
    }

    internal fun forgetSeat() {
        logReadReady = false
        logged = emptyList()
        shelved = emptyList()
        foot = Older.More
        retried = null
        readingShown = false
        deliveryRead = DeliveryRead()
        progressRevision += 1
        progressCache = null
        progressFailure = null
        progressLoading = false
        closedDetails = emptyMap()
    }

    suspend fun loadProgress(force: Boolean = false): GymResult<StatsProgress> {
        progressWanted = true
        val owner = seat.owner
        return progressRead.withLock {
            if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused("The account changed while reading."))
            if (!force) progressCache?.let { return@withLock GymResult.Ok(it) }
            progressLoading = true
            progressFailure = null
            try {
                repeat(3) {
                    val revision = progressRevision
                    val read = seat.readTraining { training.progress() }
                    if (owner != seat.owner) return@withLock GymResult.Failed(WriteFailure.Refused("The account changed while reading."))
                    if (revision == progressRevision) {
                        progressCache = read
                        return@withLock GymResult.Ok(read)
                    }
                }
                seat.askRefresh()
                GymResult.Failed(WriteFailure.NoAnswer)
            } catch (_: TrainingReadChanged) {
                GymResult.Failed(WriteFailure.NoAnswer)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (failure: Exception) {
                seat.reportFailure("gym.loadProgress", failure)
                val why = WriteFailure(failure)
                if (owner == seat.owner) progressFailure = why
                GymResult.Failed(why)
            } finally {
                if (owner == seat.owner) progressLoading = false
            }
        }
    }

    internal fun invalidateProgress() {
        progressRevision += 1
        progressCache = null
        if (progressWanted) scope.launch { loadProgress() }
    }

    // Computed by the DOMAIN and read here, never re-derived. A refused import kept on this phone
    // has nothing to say: a record and a comparison need the account's whole history.
    suspend fun review(of: String): Review? {
        shelfDetail(of)?.let { return Review() }
        val owner = seat.owner
        val result = seat.tried("gym.review") { seat.readTraining { training.review(of) } }
        return result.takeIf { owner == seat.owner }
    }

    suspend fun sessionDetail(sessionId: String, seed: SessionDetail? = null): GymResult<SessionDetail> {
        shelfDetail(sessionId)?.let { return GymResult.Ok(it) }
        if (seed != null && seed.session.id == sessionId && !seed.session.isOpen && closedDetails[sessionId] == null) retainClosed(seed)
        val before = closedDetails[sessionId]
        val detail = try { seat.readTraining { training.session(sessionId) } }
        catch (_: TrainingReadChanged) { return GymResult.Failed(WriteFailure.NoAnswer) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            seat.reportFailure("gym.loadLog", failure)
            return GymResult.Failed(WriteFailure.NoAnswer)
        } ?: return GymResult.Failed(WriteFailure.Refused("that session is no longer on the log"))
        val current = closedDetails[sessionId]
        if (current != before && current != null) return GymResult.Ok(current)
        if (!detail.session.isOpen) retainClosed(detail)
        return GymResult.Ok(detail)
    }

    // Its aggregates all moved with the set and the replica is the only thing that computes them. It
    // asks for ONE row, anchored on the one above it, because a session reached with `Load older` is
    // below the head; the answer is taken only if it IS the row asked for, since the cursor is a
    // position.
    internal suspend fun rereadRow(sessionId: String, operation: String = "gym.rereadRow") {
        val owner = seat.owner
        val at = logged.indexOfFirst { it.id == sessionId }
        if (at < 0) return
        val above = logged.getOrNull(at - 1)
        val fresh = seat.tried(operation) { seat.readTraining { training.sessions(limit = 1, before = above?.startedAtMs, beforeId = above?.id) } }
            ?.singleOrNull()?.takeIf { it.id == sessionId } ?: return
        if (owner != seat.owner) return
        logged = logged.map { if (it.id == sessionId) fresh else it }
    }

    // The foot's Retry reads the log again; on an account not pulled yet it also asks for the first pull, and the foot
    // reads again until that pull ends.
    suspend fun retryLog() {
        val unread = logUnread
        val before = pulls.value
        val asked = unread && !before.blocked && pullAgain()
        if (asked) retried = before
        loadOlder()
        val outcome = when {
            unread -> if (asked) "requested" else "refused"
            older == Older.Failed -> "failed"
            else -> "ok"
        }
        telemetry.event("gym_action", mapOf("screen" to "log", "action" to "retry", "outcome" to outcome))
    }

    // Also re-reads a first page the replica could not answer: with no rows the cursor is absent, which is
    // the top of the log. The cursor is BOTH halves of the sort key, because two sessions can share an instant.
    suspend fun loadOlder(): Unit = logRead.withLock {
        if (foot == Older.Loading || foot == Older.End) return
        val owner = seat.owner
        foot = Older.Loading
        val oldest = logged.lastOrNull()
        val page = seat.tried("gym.loadOlder") { seat.readTraining { training.sessions(limit = logPage, before = oldest?.startedAtMs, beforeId = oldest?.id) } }
        if (owner != seat.owner) return
        if (page != null) logged = logged + page.filter { fresh -> logged.none { it.id == fresh.id } }
        foot = footAfter(page)
    }

    suspend fun routineHistory(routineId: String): GymResult<List<SessionSummary>> {
        if (!seat.accountReady) return GymResult.Failed(WriteFailure.Refused(accountChanged))
        return try {
            GymResult.Ok(seat.readTraining { training.routineHistory(routineId, held.withheldIds) })
        } catch (_: TrainingReadChanged) {
            GymResult.Failed(WriteFailure.Refused(accountChanged))
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            seat.reportFailure("gym.routineHistory", failure)
            GymResult.Failed(WriteFailure.NoAnswer)
        }
    }

    // Nothing is held: the store keeps no copy to invalidate. The replica's answer stands ALONE and
    // a refused import kept on this phone is not merged into it, so a strict refusal cannot change
    // aggregate history.
    suspend fun record(exerciseId: String): GymResult<MovementRecord> {
        val read = training.record(exerciseId)
            ?: return GymResult.Failed(WriteFailure.Refused("that movement is no longer on the log"))
        return GymResult.Ok(read)
    }

    suspend fun edit(exerciseId: String, name: String, equipment: String? = null, loadCount: Int? = null,
        base: Exercise? = null, expectedAccountKey: String = seat.accountKey, expectedReplica: String? = seat.replica): GymResult<Exercise> {
        val owner = seat.owner
        val result = try {
            if (!seat.workoutAuthorized || expectedAccountKey != seat.accountKey || expectedReplica == null)
                throw TrainingRefused("account-changed", accountChanged)
            Program.nameProblem(name)?.let { throw TrainingRefused("invalid", it) }
            val edited = training.editExercise(exerciseId, name, equipment, loadCount, base, expectedReplica, owner == null)
            if (owner == seat.owner) invalidateProgress()
            GymResult.Ok(edited)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (failure: Exception) {
            seat.reportFailure("gym.editExercise", failure)
            GymResult.Failed(WriteFailure(failure))
        }
        val outcome = when (result) {
            is GymResult.Ok -> "ok"
            is GymResult.Failed -> if (result.why is WriteFailure.Refused) "refused" else "failed"
        }
        telemetry.event("gym_action", mapOf("screen" to "record", "action" to "edit", "outcome" to outcome))
        return result
    }

    internal suspend fun loadLog(): Unit = logRead.withLock {
        if (!seat.workoutAuthorized) return
        // The owner and live session still have to match after every suspended read.
        val owner = seat.owner
        val live = controls.session?.id
        val walkedTo = logged.lastOrNull()
        val page = seat.tried("gym.loadLog") {
            if (controls.writable) training.recoverAcceptedSets(controls)
            seat.readTraining {
                if (training.planUnreadable) telemetry.failure("gym.loadLog", IllegalStateException("unreadable-frozen-plan"))
                training.sessions(limit = logPage, before = null, beforeId = null, through = walkedTo) to readDelivery()
            }
        }
        if (!seat.workoutAuthorized || owner != seat.owner || live != controls.session?.id) return
        if (page == null) {
            // The foot is where an unread log is said; the rows already in hand stay.
            foot = footAfter(null)
            return
        }
        // A re-read covers the head and every row walked below it, so each row the log holds reflects the
        // replica, and it does not undo a walk: it can land while a thumb is halfway down the log. Any row
        // OLDER than its last one survives, keyed on both halves of the cursor.
        deliveryRead = page.second
        val rows = page.first
        val edge = rows.lastOrNull()
        val deeper = logged.filter { row ->
            edge != null && (row.startedAtMs < edge.startedAtMs ||
                (row.startedAtMs == edge.startedAtMs && row.id < edge.id))
        }
        logged = rows + deeper
        invalidateProgress()
        val refused = seat.tried("gym.loadLog") { refusedImports() } ?: return
        if (!seat.workoutAuthorized || owner != seat.owner || live != controls.session?.id) return
        shelved = refused
        seat.tried("gym.loadLog") { recovery.reread() }
        if (!seat.workoutAuthorized || owner != seat.owner || live != controls.session?.id) return
        // The foot is about the deepest row in hand, so it is recomputed only when no walk reached past the
        // head page; once the first pull has landed, a walked log stops reading.
        if (rows.size <= logPage && deeper.isEmpty()) foot = footAfter(rows)
        else if (foot == Older.Reading && !logUnread) foot = Older.More

        val open = try { seat.readTraining { training.openWorkout() } }
        catch (_: TrainingReadChanged) { return }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            seat.reportFailure("gym.loadLog", failure)
            foot = Older.Failed
            return
        }
        if (!seat.workoutAuthorized || owner != seat.owner || live != controls.session?.id || !controls.writable) return
        logReadReady = training.anonymous || training.firstPullComplete
        followOpenWorkout(open?.session)
    }

    internal companion object {
        // The log's page: a shorter page is the bottom of the log.
        const val logPage = 50
    }
}

// There is no state for "empty": a log with no rows has no foot.
enum class Older { More, Loading, End, Reading, Failed }
