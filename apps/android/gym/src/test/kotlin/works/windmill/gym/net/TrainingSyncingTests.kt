package works.windmill.gym.net

import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.RoutineWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionShare
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.SetWrite
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.TrainingStatistics

// The interface's eighteen doors, proven implementable before the HTTP twin arrives — and the
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
    val stored = mutableMapOf<String, Session>()
    val sets = mutableMapOf<String, MutableList<TrainingSet>>()
    val written = mutableMapOf<String, Routine>()
    val lastTimes = mutableMapOf<String, LastTime>()
    val reviews = mutableMapOf<String, Review>()
    val shares = mutableMapOf<String, SessionShare>()
    var stats = TrainingStatistics()
    var refuse: (SetWrite) -> Exception? = { null }
    var refuseStart: Exception? = null
    var refuseCreate: Exception? = null
    var refuseShare: Exception? = null
    var refuseRevoke: Exception? = null
    var refuseStats: Exception? = null
    var swallowReplies = 0
    // The close is a round trip, and this is the only way a test can stand inside it.
    var onFinish: suspend () -> Unit = {}

    val appended = mutableListOf<SetWrite>()
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
        val made = Exercise(write.id, write.name, write.pattern, write.equipment, write.stepKg,
            custom = true)
        catalog = catalog + made
        return made
    }

    override suspend fun startSession(start: SessionStart): Session {
        calls.add("start")
        reachable()
        refuseStart?.let { throw it }
        stored.values.firstOrNull { it.isOpen }?.let { return it }
        val opened = Session(id = start.id, startedAtMs = start.startedAt, routineId = start.routineId)
        stored[opened.id] = opened
        return opened
    }

    override suspend fun appendSet(sessionId: String, write: SetWrite): TrainingSet {
        calls.add("append")
        appended.add(write)
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

    override suspend fun finishSession(sessionId: String, finishedAtMs: Long): Session {
        calls.add("finish")
        onFinish()
        reachable()
        val live = stored[sessionId] ?: throw IllegalStateException("404")
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

    override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
        calls.add("sessions")
        reachable()
        return stored.values
            .sortedByDescending { it.startedAtMs }
            .map { session ->
                val heldSets = sets[session.id] ?: emptyList()
                SessionSummary(id = session.id, startedAtMs = session.startedAtMs,
                    finishedAtMs = session.finishedAtMs, routineId = session.routineId,
                    plan = session.plan, setCount = heldSets.size,
                    exercises = heldSets.map { it.exerciseId })
            }
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

    override suspend fun statistics(): TrainingStatistics {
        calls.add("statistics")
        reachable()
        refuseStats?.let { throw it }
        return stats
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
}
