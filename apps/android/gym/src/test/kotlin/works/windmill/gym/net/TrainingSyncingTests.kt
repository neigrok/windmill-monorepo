package works.windmill.gym.net

import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.MovementRecord
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionShare
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TrainingSet

// The interface's doors, proven implementable before the HTTP twin arrives — and the
// behaviors every implementation leans on, pinned against the fake: the minted id is the
// idempotency key, a start joins the open session, an absent session reads as null, and an
// unreachable log throws rather than answering empty.
class TrainingSyncingTests {
    @Test
    fun testAReplayOfAMintedIdAnswersTheStoredRowEvenAfterFinish() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val write = SetWrite(id = "set_a", exerciseId = "bench-press", weightKg = 82.5, reps = 5,
            kind = SetKind.Working, completedAt = 1_100)

        val first = server.appendSet("ses_1", write)
        server.finishSession("ses_1", finishedAtMs = 2_000)
        val replayed = server.appendSet("ses_1", write)

        assertEquals("a replay answers with the stored row, never a second one", first, replayed)
        assertEquals(1, server.sets.getValue("ses_1").size)
    }

    @Test
    fun testSetsAreNumberedPerMovementBecauseThatIsTheOnlyOrderTheServerKeeps() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val bench1 = server.appendSet("ses_1", aWrite("set_a", "bench-press", at = 1_100))
        val bench2 = server.appendSet("ses_1", aWrite("set_b", "bench-press", at = 1_200))
        val squat1 = server.appendSet("ses_1", aWrite("set_c", "back-squat", at = 1_300))

        assertEquals(listOf(1, 2, 1), listOf(bench1.setNumber, bench2.setNumber, squat1.setNumber))
    }

    @Test
    fun testAStartJoinsTheOpenSessionRatherThanOpeningASecond() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_live", startedAtMs = 500))

        val joined = server.startSession(SessionStart(id = "ses_fresh", startedAt = 1_000))

        assertEquals("ses_live", joined.id)
        assertNull("no second session was opened", server.stored["ses_fresh"])
    }

    // The claim's start refuses to join — a replayed past session filed into a live workout is the
    // bug the flag exists against — and the refusal is the machine word the claim waits on.
    @Test
    fun testAStartThatDeclinesToJoinIsRefusedWhileAnotherSessionIsOpen() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_live", startedAtMs = 500))

        try {
            server.startSession(SessionStart(id = "ses_past", startedAt = 1_000, joinOpenSession = false))
            fail("expected session-already-open")
        } catch (refused: works.windmill.platform.net.WindmillApiException.Refused) {
            assertEquals(409, refused.status)
            assertEquals("session-already-open", refused.refusal.code)
        }
        assertNull("nothing was opened and nothing was joined", server.stored["ses_past"])

        // Its own row answers regardless — a replay is not a second session.
        val replayed = server.startSession(SessionStart(id = "ses_live", startedAt = 500, joinOpenSession = false))
        assertEquals("ses_live", replayed.id)
    }

    @Test
    fun testAnAbsentSessionAndRoutineReadAsNullRatherThanThrowing() = runTest {
        val server = FakeTraining()
        assertNull(server.session("ses_gone"))
        assertNull(server.routine("rt_gone"))
    }

    @Test
    fun testAnUnreachableLogThrowsRatherThanAnsweringEmpty() = runTest {
        val server = FakeTraining()
        server.online = false
        try {
            server.exercises()
            fail("an unreachable log is not an empty catalog")
        } catch (offline: IOException) {
        }
    }

    private fun aWrite(id: String, exerciseId: String, at: Long) = SetWrite(
        id = id, exerciseId = exerciseId, weightKg = 82.5, reps = 5, kind = SetKind.Working,
        completedAt = at)
}

// A log entirely under the test's control: it can be unreachable, it can already hold a session
// and its sets, it can refuse a named movement, and it can store a set and then lose the reply.
// The port of the iOS FakeTraining, kept beside the interface so the store wave can drive
// TrainingStore against the same log the doors were proven with — swapping the placeholder
// exceptions for the platform's once that seam exists.
internal class FakeTraining : TrainingSyncing {
    var online = true
    var catalog = listOf<Exercise>()
    var settings: GymPreferences? = null
    val stored = mutableMapOf<String, Session>()
    val sets = mutableMapOf<String, MutableList<TrainingSet>>()
    val written = mutableMapOf<String, Routine>()
    val lastTimes = mutableMapOf<String, LastTime>()
    val reviews = mutableMapOf<String, Review>()
    val shares = mutableMapOf<String, SessionShare>()
    val records = mutableMapOf<String, MovementRecord>()
    var refuse: (SetWrite) -> Exception? = { null }
    var refuseStart: (SessionStart) -> Exception? = { null }
    var refuseCreate: Exception? = null
    var refuseRoutine: (RoutineWrite) -> Exception? = { null }
    var refuseShare: Exception? = null
    var refuseRevoke: Exception? = null
    var refuseRecord: Exception? = null
    var refuseRename: Exception? = null
    var refuseFix: (String) -> Exception? = { null }
    var refuseDelete: Exception? = null
    var refusePreferences: Exception? = null
    var swallowReplies = 0
    // The close is a round trip, and this is the only way a test can stand inside it.
    var onFinish: suspend () -> Unit = {}
    // So is every append, and a claim is mostly appends — this is where a test stands to make the
    // §G18 gesture a lifter can make while the claim is walking their shelf under them.
    var onAppend: suspend (SetWrite) -> Unit = {}

    val appended = mutableListOf<SetWrite>()
    val started = mutableListOf<SessionStart>()
    val finished = mutableListOf<Pair<String, Long>>()
    val fixes = mutableListOf<Triple<String, String, SetFix>>()
    val settingsWritten = mutableListOf<GymPreferences>()
    val removed = mutableListOf<Pair<String, String>>()
    val calls = mutableListOf<String>()

    fun open(session: Session) {
        stored[session.id] = session
    }

    private fun reachable() {
        if (!online) throw IOException("offline")
    }

    override suspend fun exercises(): List<Exercise> {
        calls.add("exercises")
        reachable()
        return catalog
    }

    override suspend fun createExercise(write: ExerciseWrite): Exercise {
        calls.add("createExercise")
        reachable()
        refuseCreate?.let { throw it }
        catalog.firstOrNull { it.id == write.id }?.let { return it }
        val made = Exercise(write.id, write.name, write.pattern, write.equipment, write.stepKg,
            custom = true)
        catalog = catalog + made
        return made
    }

    // The server's own resolution order: the caller's own row under the id first — a replay is
    // never a second session — then the open session, which a `joinOpenSession: false` start
    // refuses rather than joins.
    override suspend fun startSession(start: SessionStart): Session {
        calls.add("start")
        started.add(start)
        reachable()
        refuseStart(start)?.let { throw it }
        stored[start.id]?.let { return it }
        stored.values.firstOrNull { it.isOpen }?.let { open ->
            if (start.joinOpenSession == false) {
                throw works.windmill.platform.net.WindmillApiException.Refused(409,
                    works.windmill.platform.net.Refusal(message = "a session is already open",
                        code = "session-already-open"))
            }
            return open
        }
        val opened = Session(id = start.id, startedAtMs = start.startedAt, routineId = start.routineId)
        stored[opened.id] = opened
        return opened
    }

    override suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet {
        calls.add("append")
        appended.add(write)
        onAppend(write)
        reachable()
        refuse(write)?.let { throw it }
        // The id IS the idempotency key: a replay answers with the stored row, even after the
        // session closed, and never files a second one.
        sets[sessionId]?.firstOrNull { it.id == write.id }?.let { return it }

        val number = (sets[sessionId] ?: emptyList()).count { it.exerciseId == write.exerciseId } + 1
        val row = TrainingSet(id = write.id, exerciseId = write.exerciseId, setNumber = number,
            weightKg = write.weightKg, reps = write.reps, kind = write.kind,
            completedAtMs = write.completedAt)
        sets.getOrPut(sessionId) { mutableListOf() }.add(row)
        if (swallowReplies > 0) {
            swallowReplies -= 1
            throw IOException("offline")
        }
        return row
    }

    // §G18's correction. It moves the row it names and nothing else — no session field, no routine
    // — and an identical fix answers the same stored row. A set this session does not hold is the
    // same 404 `set-not-found` whether it is absent, already deleted or logged into a DIFFERENT
    // workout. A FINISHED SESSION IS NOT A REFUSAL: the typo is seen after the workout.
    override suspend fun fixSet(sessionId: String, setId: String, fix: SetFix): TrainingSet {
        calls.add("fixSet")
        fixes.add(Triple(sessionId, setId, fix))
        reachable()
        refuseFix(setId)?.let { throw it }
        val rows = sets[sessionId] ?: mutableListOf()
        val standing = rows.firstOrNull { it.id == setId }
            ?: throw works.windmill.platform.net.WindmillApiException.Refused(404,
                works.windmill.platform.net.Refusal(message = "no such set", code = "set-not-found"))
        val corrected = fix.corrected(standing)
        rows[rows.indexOf(standing)] = corrected
        return corrected
    }

    // 204 for a set that is already gone, one that never existed and one belonging to somebody else
    // — absent stays byte-identical to forbidden, and a lost reply is always safe to send again.
    override suspend fun deleteSet(sessionId: String, setId: String) {
        calls.add("deleteSet")
        removed.add(sessionId to setId)
        reachable()
        refuseDelete?.let { throw it }
        sets[sessionId]?.removeAll { it.id == setId }
    }

    override suspend fun finishSession(sessionId: String, finishedAtMs: Long): Session {
        calls.add("finish")
        finished.add(sessionId to finishedAtMs)
        onFinish()
        reachable()
        val live = stored[sessionId] ?: throw IllegalStateException("404")
        // First-writer-wins, exactly as the log's close is: a replayed finish answers the stored
        // row unchanged.
        if (!live.isOpen) return live
        val closed = live.copy(finishedAtMs = finishedAtMs)
        stored[sessionId] = closed
        return closed
    }

    override suspend fun discardSession(sessionId: String) {
        calls.add("discard")
        reachable()
        stored.remove(sessionId)
        sets.remove(sessionId)
    }

    // Paged the way the log pages: newest first, and the cursor is BOTH halves of the sort key,
    // because two sessions can share an instant and an instant alone would repeat one across the
    // page edge or skip it. The row itself is composed by the summary's own rule — the working
    // count and the tonnage a client reads off a page are the same aggregation either side.
    override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
        calls.add("sessions")
        reachable()
        return stored.values
            .sortedWith(compareByDescending<Session> { it.startedAtMs }.thenByDescending { it.id })
            .filter { row ->
                if (before == null) true
                else row.startedAtMs < before ||
                    (row.startedAtMs == before && beforeId != null && row.id < beforeId)
            }
            .take(limit)
            .map { session -> SessionSummary(session, sets[session.id] ?: emptyList()) }
    }

    override suspend fun session(id: String): SessionDetail? {
        calls.add("session")
        reachable()
        val found = stored[id] ?: return null
        return SessionDetail(found, sets[id] ?: emptyList())
    }

    override suspend fun review(sessionId: String): Review {
        calls.add("review")
        reachable()
        return reviews[sessionId] ?: throw IllegalStateException("404")
    }

    override suspend fun lastTime(exerciseId: String): LastTime {
        calls.add("lastTime")
        reachable()
        return lastTimes[exerciseId] ?: LastTime(exerciseId)
    }

    override suspend fun routines(): List<Routine> {
        calls.add("routines")
        reachable()
        return written.values.sortedBy { it.position }
    }

    override suspend fun routine(id: String): Routine? {
        calls.add("routine")
        reachable()
        return written[id]
    }

    override suspend fun createRoutine(write: RoutineWrite): Routine {
        calls.add("createRoutine")
        reachable()
        refuseRoutine(write)?.let { throw it }
        written[write.id]?.let { return it }
        val made = Routine(id = write.id, name = write.name, position = write.position,
            entries = write.entries.mapIndexed { index, entry ->
                RoutineEntry(position = index + 1, exerciseId = entry.exerciseId,
                    targetSets = entry.targetSets, targetReps = entry.targetReps,
                    targetWeightKg = entry.targetWeightKg, restSeconds = entry.restSeconds)
            })
        written[made.id] = made
        return made
    }

    override suspend fun replaceRoutine(id: String, write: RoutineWrite): Routine {
        calls.add("replaceRoutine")
        reachable()
        written.remove(id)
        return createRoutine(write)
    }

    override suspend fun deleteRoutine(id: String) {
        calls.add("deleteRoutine")
        reachable()
        written.remove(id)
    }

    // The record read, and the one absence it can produce on its own: a movement the catalog does
    // not hold is the same 404 another account's private one gives, and folds to null.
    override suspend fun record(exerciseId: String): MovementRecord? {
        calls.add("record")
        reachable()
        refuseRecord?.let { throw it }
        return records[exerciseId]
    }

    override suspend fun renameExercise(exerciseId: String, name: String): Exercise {
        calls.add("renameExercise")
        reachable()
        refuseRename?.let { throw it }
        val standing = catalog.firstOrNull { it.id == exerciseId } ?: throw IllegalStateException("404")
        val renamed = standing.copy(name = name)
        catalog = catalog.map { if (it.id == exerciseId) renamed else it }
        return renamed
    }

    // Idempotent on the session, exactly as the log is: a second mint for a session that already
    // has a live share hands back the same token rather than a second capability.
    override suspend fun share(sessionId: String): SessionShare {
        calls.add("share")
        reachable()
        refuseShare?.let { throw it }
        if (stored[sessionId] == null) throw IllegalStateException("404")
        shares[sessionId]?.let { return it }
        val minted = SessionShare(token = "tok_$sessionId", expiresAtMs = 2_592_000_000)
        shares[sessionId] = minted
        return minted
    }

    override suspend fun revokeShare(sessionId: String) {
        calls.add("revokeShare")
        reachable()
        refuseRevoke?.let { throw it }
        shares.remove(sessionId) ?: throw IllegalStateException("404")
    }

    // NEVER A 404: an account with no row is served the defaults, so this answers a document
    // whether or not anything has ever been written.
    override suspend fun preferences(): GymPreferences {
        calls.add("preferences")
        reachable()
        return settings ?: GymPreferences()
    }

    // A whole-document replace that answers with the STORED document — plates sorted heaviest-first
    // with duplicates gone — so a client that drew its own send would disagree with the account.
    override suspend fun savePreferences(document: GymPreferences): GymPreferences {
        calls.add("savePreferences")
        settingsWritten.add(document)
        reachable()
        refusePreferences?.let { throw it }
        val stored = document.normalized()
        settings = stored
        return stored
    }
}
