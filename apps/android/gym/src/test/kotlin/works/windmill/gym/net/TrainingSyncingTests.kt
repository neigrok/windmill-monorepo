package works.windmill.gym.net

import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import works.windmill.gym.domain.AskAnswer
import works.windmill.gym.domain.AskQuestion
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ThreadOutcome
import works.windmill.gym.domain.ThreadProposal
import works.windmill.gym.domain.ReadTally
import works.windmill.gym.domain.ChangeKind
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.LastSet
import works.windmill.gym.domain.LastTime
import works.windmill.gym.domain.MovementRecord
import works.windmill.gym.domain.Note
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalDecision
import works.windmill.gym.domain.ProposalIntent
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.ProposalTargets
import works.windmill.gym.domain.Review
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.RoutineEvent
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
import works.windmill.gym.domain.WeighIn
import works.windmill.gym.domain.WeighInWrite

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

// `trimmedName` on the server: these six, both ends.
private const val serverBlanks = " \t\n\r\u000C\u000B"

private fun refusal(status: Int, code: String? = null, message: String) =
    works.windmill.platform.net.WindmillApiException.Refused(
        status, works.windmill.platform.net.Refusal(message = message, code = code))

internal class FakeTraining : TrainingSyncing {
    var online = true
    var nowMs: () -> Long = { 0L }
    var catalog = listOf<Exercise>()
    var settings: GymPreferences? = null
    val stored = mutableMapOf<String, Session>()
    val sets = mutableMapOf<String, MutableList<TrainingSet>>()
    val written = mutableMapOf<String, Routine>()
    val ledger = mutableMapOf<String, Proposal>()
    val creations = mutableMapOf<String, RoutineEvent>()
    var createdAtMs = 500L
    var settledAtMs = 9_000L
    val lastTimes = mutableMapOf<String, LastTime>()
    val served = mutableListOf<LastSet>()
    val reviews = mutableMapOf<String, Review>()
    val shares = mutableMapOf<String, SessionShare>()
    val records = mutableMapOf<String, MovementRecord>()
    var refuse: (SetWrite) -> Exception? = { null }
    var refuseStart: (SessionStart) -> Exception? = { null }
    var refuseCreate: Exception? = null
    // Suspending, so a test can hold a routine write open and drive the room while it is in flight.
    var refuseRoutine: suspend (RoutineWrite) -> Exception? = { null }
    var refuseRoutinesRead: Exception? = null
    var refuseShare: Exception? = null
    var refuseRevoke: Exception? = null
    var refuseRecord: Exception? = null
    var refuseRename: Exception? = null
    var refuseRoutineRead: Exception? = null
    var refuseApply: Exception? = null
    var refuseDismiss: Exception? = null
    var refuseFix: (String) -> Exception? = { null }
    var refuseDelete: Exception? = null
    var refuseRoutineDelete: Exception? = null
    var refusePreferences: Exception? = null
    var refuseAsk: Exception? = null
    val answers = mutableListOf<AskAnswer>()
    val asked = mutableListOf<AskQuestion>()
    val conversations = mutableMapOf<String, AskThread>()
    var refuseThreads: Exception? = null
    // Keyed by id, in position order; the same rules the server's table keeps.
    val notebook = mutableListOf<Note>()
    var refuseNotes: Exception? = null
    var noteWrittenAtMs = 7_000L
    // Keyed by the local date; the newer `recordedAt` wins, as the server's row rule says.
    val weighIns = mutableMapOf<String, WeighIn>()
    var refuseBodyweight: Exception? = null
    var refuseBodyweightRead: Exception? = null
    var swallowReplies = 0
    var onFinish: suspend () -> Unit = {}
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

    private fun settle() {
        val now = nowMs()
        for (open in stored.values.filter { it.isOpen }) {
            val lastActivity = sets[open.id]?.maxOfOrNull { it.completedAtMs } ?: open.startedAtMs
            if (now < lastActivity + 4L * 60 * 60 * 1000) continue
            stored[open.id] = open.copy(finishedAtMs = lastActivity)
        }
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

    override suspend fun startSession(start: SessionStart): Session {
        calls.add("start")
        started.add(start)
        reachable()
        refuseStart(start)?.let { throw it }
        settle()
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
        val session = stored[sessionId] ?: throw refusal(404, message = "no such session")
        sets[sessionId]?.firstOrNull { it.id == write.id }?.let { return it }
        if (!session.isOpen) throw refusal(409, "session-finished", "that session is finished")

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
        val live = stored[sessionId] ?: throw refusal(404, message = "no such session")
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

    override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
        calls.add("sessions")
        reachable()
        settle()
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

    override suspend fun lastSets(): List<LastSet> {
        calls.add("lastSets")
        reachable()
        return served.sortedBy { it.exerciseId }
    }

    override suspend fun routines(): List<Routine> {
        calls.add("routines")
        reachable()
        refuseRoutinesRead?.let { throw it }
        return written.values.sortedBy { it.position }
    }

    override suspend fun routine(id: String): Routine? {
        calls.add("routine")
        reachable()
        refuseRoutineRead?.let { throw it }
        val standing = written[id] ?: return null
        val proposed = ledger.values
            .filter { it.routineId == id }
            .sortedByDescending { it.createdAtMs }
            .map { RoutineEvent(kind = "proposal", atMs = it.createdAtMs, proposal = it) }
        val born = creations[id] ?: RoutineEvent(kind = "created", atMs = createdAtMs)
        return standing.copy(history = proposed + born)
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
        creations[made.id] = RoutineEvent(kind = "created", atMs = createdAtMs,
            movements = write.entries.size)
        return made
    }

    override suspend fun replaceRoutine(id: String, write: RoutineWrite): Routine {
        calls.add("replaceRoutine")
        reachable()
        refuseRoutine(write)?.let { throw it }
        val standing = written[id] ?: throw refusal(404, message = "no such routine")
        val saved = Routine(write)
            .copy(revision = standing.revision + 1, lastTrainedAtMs = standing.lastTrainedAtMs)
        written.remove(id)
        written[saved.id] = saved
        ledger.values.filter { it.routineId == id && it.isPending }.forEach {
            ledger[it.id] = it.copy(state = ProposalState.Superseded, settledAtMs = settledAtMs)
        }
        return saved
    }

    override suspend fun deleteRoutine(id: String) {
        calls.add("deleteRoutine")
        reachable()
        refuseRoutineDelete?.let { throw it }
        written.remove(id)
    }

    fun propose(proposal: Proposal) {
        ledger[proposal.id] = proposal
        if (!proposal.isPending) return
        written[proposal.routineId]?.let { written[it.id] = it.copy(pendingProposal = proposal) }
    }


    override suspend fun proposal(id: String): Proposal? {
        calls.add("proposal")
        reachable()
        return ledger[id]
    }

    override suspend fun applyProposal(id: String): ProposalDecision {
        calls.add("applyProposal")
        reachable()
        refuseApply?.let { throw it }
        val standing = ledger[id] ?: throw refusal(404, message = "no such proposal")
        if (standing.state == ProposalState.Applied) {
            return ProposalDecision(standing, written[standing.routineId])
        }
        // The log's reason column, in the log's order: a moved revision is named first, a proposal set
        // aside with its revision unmoved is the legacy row.
        val base = written[standing.routineId]
        if (base != null && base.revision != standing.baseRevision) {
            throw refusal(409, "proposal-superseded",
                "that routine changed after this proposal was written, so it was not applied")
        }
        if (standing.state == ProposalState.Superseded) {
            throw refusal(409, "proposal-superseded", "this proposal was superseded before it was applied")
        }
        if (!standing.isPending) throw refusal(409, "proposal-settled", "that proposal was already decided")
        if (base == null) throw refusal(404, message = "no such proposal")
        val settled = standing.copy(state = ProposalState.Applied, settledAtMs = settledAtMs)
        ledger[id] = settled
        if (settled.intent == ProposalIntent.Remove) {
            written.remove(base.id)
            ledger.values.removeAll { it.routineId == base.id }
            return ProposalDecision(settled)
        }
        val moved = base.copy(
            name = settled.name.ifBlank { base.name },
            revision = base.revision + 1,
            pendingProposal = null,
            entries = settled.changes.takeWhile { it.kind != ChangeKind.Removed }
                .mapIndexed { index, change ->
                    val asks = change.after ?: ProposalTargets()
                    RoutineEntry(position = index + 1, exerciseId = change.exerciseId,
                        targetSets = asks.sets, targetReps = asks.reps,
                        targetWeightKg = asks.weightKg, restSeconds = asks.restSeconds)
                },
        )
        written[moved.id] = moved
        return ProposalDecision(settled, moved)
    }

    override suspend fun dismissProposal(id: String): ProposalDecision {
        calls.add("dismissProposal")
        reachable()
        refuseDismiss?.let { throw it }
        val standing = ledger[id] ?: throw refusal(404, message = "no such proposal")
        if (standing.state == ProposalState.Dismissed) return ProposalDecision(standing)
        if (standing.state == ProposalState.Superseded) {
            throw refusal(409, "proposal-superseded", "this proposal was superseded before it was turned down")
        }
        if (!standing.isPending) throw refusal(409, "proposal-settled", "that proposal was already decided")
        val settled = standing.copy(state = ProposalState.Dismissed, settledAtMs = settledAtMs)
        ledger[id] = settled
        written[settled.routineId]?.let { written[it.id] = it.copy(pendingProposal = null) }
        return ProposalDecision(settled)
    }

    override suspend fun record(exerciseId: String): MovementRecord? {
        calls.add("record")
        reachable()
        settle()
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

    override suspend fun preferences(): GymPreferences {
        calls.add("preferences")
        reachable()
        return settings ?: GymPreferences()
    }

    override suspend fun savePreferences(document: GymPreferences): GymPreferences {
        calls.add("savePreferences")
        settingsWritten.add(document)
        reachable()
        refusePreferences?.let { throw it }
        val stored = document.normalized()
        settings = stored
        return stored
    }

    override suspend fun ask(question: AskQuestion): AskAnswer {
        calls.add("ask")
        asked.add(question)
        reachable()
        refuseAsk?.let { throw it }
        if (answers.isEmpty()) {
            return AskAnswer(answer = "nothing has moved in three weeks.", read = ReadTally(sets = 12))
        }
        return answers.removeAt(0)
    }

    override suspend fun threads(): List<AskThread> {
        calls.add("threads")
        reachable()
        refuseThreads?.let { throw it }
        return conversations.values
            .sortedByDescending { it.askedAtMs }
            .map { derived(it).copy(turns = emptyList()) }
    }

    override suspend fun thread(id: String): AskThread? {
        calls.add("thread")
        reachable()
        refuseThreads?.let { throw it }
        return conversations[id]?.let { derived(it) }
    }

    // The server derives a thread's proposal rows and its outcome from the proposals as they stand,
    // so a decision taken anywhere has moved the thread by its next read. A row the ledger does not
    // hold is served as the test wrote it.
    private fun derived(held: AskThread): AskThread {
        val rows = held.proposals.map { row ->
            ledger[row.id]?.let { row.copy(state = it.state, changeCount = it.changeCount) } ?: row
        }
        if (held.proposals.none { ledger.containsKey(it.id) }) return held.copy(proposals = rows)
        val about = rows.map { it.routineId }.distinct().singleOrNull()?.let { id -> rows.first { it.routineId == id } }
        fun outcome(kind: String, counted: List<ThreadProposal>) =
            ThreadOutcome(kind, counted.sumOf { it.changeCount }, about?.routineId, about?.routine)
        val applied = rows.filter { it.state == ProposalState.Applied }
        val pending = rows.filter { it.state == ProposalState.Pending }
        val outcome = when {
            applied.isNotEmpty() -> outcome(ThreadOutcome.applied, applied)
            pending.isNotEmpty() -> outcome(ThreadOutcome.proposed, pending)
            rows.all { it.state == ProposalState.Dismissed } -> outcome(ThreadOutcome.dismissed, rows)
            else -> outcome(ThreadOutcome.superseded, rows)
        }
        return held.copy(proposals = rows, outcome = outcome)
    }

    override suspend fun deleteThread(id: String) {
        calls.add("deleteThread")
        reachable()
        refuseThreads?.let { throw it }
        conversations.remove(id)
        ledger.values.filter { it.source.thread == id }.forEach { proposal ->
            val orphaned = proposal.copy(source = proposal.source.copy(thread = null))
            ledger[proposal.id] = orphaned
            written[proposal.routineId]?.let { routine ->
                if (routine.pendingProposal?.id == proposal.id) {
                    written[routine.id] = routine.copy(pendingProposal = orphaned)
                }
            }
        }
    }

    override suspend fun notes(): List<Note> {
        calls.add("notes")
        reachable()
        refuseNotes?.let { throw it }
        return notebook.toList()
    }

    override suspend fun writeNote(id: String, write: NoteWrite): Note {
        calls.add("writeNote")
        reachable()
        refuseNotes?.let { throw it }
        // The server's own order: trim first, then bound — the title in code points, the body in bytes.
        val title = write.title.trim { it in serverBlanks }
        val body = write.body.trim { it in serverBlanks }
        if (title.isEmpty()) throw refusal(400, message = "a note needs a title")
        if (title.codePointCount(0, title.length) > 60) throw refusal(400, message = "a title runs to 60 characters")
        if (body.toByteArray(Charsets.UTF_8).size > 500) throw refusal(400, message = "a note runs to 500 bytes")
        val at = notebook.indexOfFirst { it.id == id }
        if (at < 0 && notebook.size >= 10) throw refusal(409, code = "notes-full", message = "10 of 10 notes. Delete one to add another.")
        val stored = Note(id = id, position = if (at < 0) notebook.size else at, title = title,
            body = body, updatedAtMs = noteWrittenAtMs)
        if (at < 0) notebook.add(stored) else notebook[at] = stored
        return stored
    }

    override suspend fun deleteNote(id: String) {
        calls.add("deleteNote")
        reachable()
        refuseNotes?.let { throw it }
        notebook.removeAll { it.id == id }
        renumber()
    }

    override suspend fun reorderNotes(order: List<String>): List<Note> {
        calls.add("reorderNotes")
        reachable()
        refuseNotes?.let { throw it }
        if (order.toSet() != notebook.map { it.id }.toSet() || order.size != notebook.size) {
            throw refusal(400, code = "notes-order-mismatch", message = "that order does not name every note")
        }
        val byId = notebook.associateBy { it.id }
        notebook.clear()
        order.forEach { notebook.add(byId.getValue(it)) }
        renumber()
        return notebook.toList()
    }

    private fun renumber() {
        for (i in notebook.indices) notebook[i] = notebook[i].copy(position = i)
    }

    override suspend fun bodyweight(from: String?, to: String?): List<WeighIn> {
        calls.add("bodyweight")
        reachable()
        refuseBodyweightRead?.let { throw it }
        return weighIns.values
            .filter { (from == null || it.dateLocal >= from) && (to == null || it.dateLocal <= to) }
            .sortedBy { it.dateLocal }
    }

    override suspend fun putBodyweight(dateLocal: String, write: WeighInWrite): WeighIn {
        calls.add("putBodyweight")
        reachable()
        refuseBodyweight?.let { throw it }
        val date = runCatching { java.time.LocalDate.parse(dateLocal) }.getOrNull()
            ?: throw refusal(400, message = "could not read that date")
        // The server's own UTC today, plus the one day a device west of it may be ahead by.
        if (date.isAfter(java.time.LocalDate.now(java.time.ZoneOffset.UTC).plusDays(1))) {
            throw refusal(400, message = Bodyweight.notAForecast)
        }
        if (write.weightKg < 20.0 || write.weightKg > 400.0) {
            throw refusal(400, message = "Between 20 and 400 kg — check the number.")
        }
        val standing = weighIns[dateLocal]
        if (standing != null && standing.recordedAt > write.recordedAt) return standing
        val stored = WeighIn(dateLocal, write.weightKg, write.recordedAt)
        weighIns[dateLocal] = stored
        return stored
    }

    override suspend fun deleteBodyweight(dateLocal: String) {
        calls.add("deleteBodyweight")
        reachable()
        refuseBodyweight?.let { throw it }
        weighIns.remove(dateLocal)
    }
}
