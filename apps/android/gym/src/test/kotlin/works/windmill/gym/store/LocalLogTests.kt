package works.windmill.gym.store

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet

// What has to be true for the shelf to be trusted with a signed-out training history: it comes
// back from disk whole, an unreadable or older file opens without taking the history down, and the
// claim's repairs — remint a spent id, let go of what landed — move exactly what they say.
class LocalLogTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun logFile(): File = File(tmp.root, "gym-local-${System.nanoTime()}.json")

    private fun aSet(id: String, exerciseId: String = "bench-press", at: Long) = TrainingSet(
        id = id, exerciseId = exerciseId, weightKg = 82.5, reps = 5, completedAtMs = at)

    @Test
    fun testTheShelfSurvivesBeingReadBackFromDisk() {
        val file = logFile()
        val shelf = LocalLog(file)
        shelf.hold(Exercise(id = "ex_1", name = "Zercher Squat", custom = true))
        shelf.hold(Routine(id = "rt_1", name = "Push Day",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5))))
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))

        val reopened = LocalLog(file)
        assertEquals(listOf("Zercher Squat"), reopened.exercises.map { it.name })
        assertEquals(listOf("Push Day"), reopened.routines.map { it.name })
        assertEquals(listOf("ses_1"), reopened.finished.map { it.session.id })
        assertEquals(listOf("set_a"), reopened.detail("ses_1")?.sets?.map { it.id })
    }

    @Test
    fun testAnUnreadableFileOpensEmptyRatherThanCrashing() {
        val file = logFile()
        file.writeText("not json at all")

        val shelf = LocalLog(file)
        assertTrue(shelf.exercises.isEmpty())
        assertTrue(shelf.routines.isEmpty())
        assertTrue(shelf.finished.isEmpty())
    }

    // Every field is optional so an older build's file — or a future build's with keys this one
    // never wrote — still opens with what it does hold, never as empty.
    @Test
    fun testAPartialFileOpensWithWhatItHolds() {
        val file = logFile()
        file.writeText("""{"routines":[{"id":"rt_1","name":"Push Day"}],"unknownKey":true}""")

        val shelf = LocalLog(file)
        assertEquals(listOf("Push Day"), shelf.routines.map { it.name })
        assertTrue(shelf.finished.isEmpty())
    }

    @Test
    fun testSummariesReadNewestFirstWithTheSessionsOwnFacts() {
        val shelf = LocalLog(logFile())
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_old", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_new", startedAtMs = 5_000, finishedAtMs = 6_000),
            listOf(aSet("set_b", at = 5_100), aSet("set_c", "back-squat", at = 5_200))))

        val summaries = shelf.summaries()
        assertEquals(listOf("ses_new", "ses_old"), summaries.map { it.id })
        assertEquals(listOf(2, 1), summaries.map { it.setCount })
        assertEquals(listOf("bench-press", "back-squat"), summaries.first().exercises)
        assertEquals(82.5, summaries.first().topSet?.weightKg)
    }

    // A spent movement id changes everywhere the shelf wrote it, or the claim would land sets
    // against an id the catalog never minted.
    @Test
    fun testRemintingAMovementReachesRoutinesPlansAndSets() {
        val shelf = LocalLog(logFile())
        shelf.hold(Exercise(id = "ex_spent", name = "Zercher Squat", custom = true))
        shelf.hold(Routine(id = "rt_1", name = "Legs",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "ex_spent", targetSets = 3))))
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000,
                plan = works.windmill.gym.domain.PlanSnapshot(routine = "Legs",
                    entries = listOf(works.windmill.gym.domain.PlanEntry(exerciseId = "ex_spent", sets = 3)))),
            listOf(aSet("set_a", "ex_spent", at = 1_100))))

        shelf.remintExercise("ex_spent", "ex_fresh")

        assertEquals(listOf("ex_fresh"), shelf.exercises.map { it.id })
        assertEquals(listOf("ex_fresh"), shelf.routines.single().entries.map { it.exerciseId })
        assertEquals(listOf("ex_fresh"),
            shelf.finished.single().session.plan?.entries?.map { it.exerciseId })
        assertEquals(listOf("ex_fresh"), shelf.finished.single().sets.map { it.exerciseId })
    }

    @Test
    fun testRemintingARoutineRepointsTheSessionsThatRanIt() {
        val shelf = LocalLog(logFile())
        shelf.hold(Routine(id = "rt_spent", name = "Push Day"))
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000, routineId = "rt_spent"),
            emptyList()))

        shelf.remintRoutine("rt_spent", "rt_fresh")

        assertEquals(listOf("rt_fresh"), shelf.routines.map { it.id })
        assertEquals("rt_fresh", shelf.finished.single().session.routineId)
    }

    // Holding a finished session again replaces its row — never a second one — and merges the
    // sets by id, so neither copy's lifts are lost to the convergence. This is the crash between
    // finishOnDevice's hold and the queue's forget: the workout finishes a second time carrying
    // everything the first hold did plus whatever was lifted since.
    @Test
    fun testHoldingAFinishedSessionAgainReplacesTheRowAndKeepsEverySet() {
        val shelf = LocalLog(logFile())
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_500),
            listOf(aSet("set_b", at = 1_200))))

        assertEquals(listOf("ses_1"), shelf.finished.map { it.session.id })
        assertEquals(2_500L, shelf.finished.single().session.finishedAtMs)
        assertEquals(listOf("set_b", "set_a"), shelf.finished.single().sets.map { it.id })
    }

    // The claim's terminal let-go for a routine: the document leaves, and the sessions that named
    // it keep their frozen plan — only the id that will never resolve goes.
    @Test
    fun testOrphaningARoutineDropsTheDocumentAndOnlyTheIdFromItsSessions() {
        val shelf = LocalLog(logFile())
        shelf.hold(Routine(id = "rt_gone", name = "Push Day"))
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000, routineId = "rt_gone",
                plan = works.windmill.gym.domain.PlanSnapshot(routine = "Push Day")),
            listOf(aSet("set_a", at = 1_100))))

        shelf.orphanRoutine("rt_gone")

        assertTrue(shelf.routines.isEmpty())
        assertNull(shelf.finished.single().session.routineId)
        assertEquals("the frozen plan is a snapshot, not a reference — it stays",
            "Push Day", shelf.finished.single().session.plan?.routine)
        assertEquals(listOf("set_a"), shelf.finished.single().sets.map { it.id })
    }

    // The claim's one loss door and its one success door: a refused set leaves alone, and a
    // confirmed session leaves whole.
    @Test
    fun testDroppingASetAndForgettingASessionMoveExactlyWhatTheySay() {
        val shelf = LocalLog(logFile())
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))

        shelf.dropSet("ses_1", "set_a")
        assertEquals(listOf("set_b"), shelf.detail("ses_1")?.sets?.map { it.id })

        shelf.forget("ses_1")
        assertNull(shelf.detail("ses_1"))
        assertTrue(shelf.finished.isEmpty())
    }

    // §G18 ON A SESSION NO ACCOUNT HOLDS. The row has never been sent, so the correction rewrites
    // the version that WILL be sent — in place, under the same id, so the claim replays the
    // corrected set rather than a second one beside it. And it moves nothing else: the frozen plan
    // and the routine id are the caption of the whole screen.
    @Test
    fun testFixingASetOnTheShelfRewritesTheRowAndLeavesThePlanAlone() {
        val shelf = LocalLog(logFile())
        val plan = works.windmill.gym.domain.PlanSnapshot(routine = "Push A",
            entries = listOf(works.windmill.gym.domain.PlanEntry(exerciseId = "bench-press", sets = 5,
                reps = 5, weightKg = 82.5)))
        shelf.hold(Routine(id = "rt_1", name = "Push A",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", targetSets = 5,
                targetReps = 5, targetWeightKg = 82.5))))
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000, routineId = "rt_1", plan = plan),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))

        val corrected = shelf.fixSet("ses_1", "set_a",
            SetFix(weightKg = 90.0, reps = 3, kind = SetKind.Drop))

        assertEquals(TrainingSet(id = "set_a", exerciseId = "bench-press", weightKg = 90.0, reps = 3,
            kind = SetKind.Drop, completedAtMs = 1_100), corrected)
        assertEquals("one row per set, still — a correction is not a second set",
            listOf("set_a", "set_b"), shelf.detail("ses_1")?.sets?.map { it.id })
        assertEquals(listOf(90.0, 82.5), shelf.detail("ses_1")?.sets?.map { it.weightKg })
        assertEquals("the log moves and the routine does not",
            listOf(82.5), shelf.routines.single().entries.map { it.targetWeightKg })
        assertEquals(plan, shelf.finished.single().session.plan)
        assertEquals("rt_1", shelf.finished.single().session.routineId)
    }

    // A set the shelf does not hold answers null, and that null is how the store tells a device row
    // from an account row — a PATCH may never go out for an id the log has never seen.
    @Test
    fun testFixingASetTheShelfDoesNotHoldAnswersNothingAtAll() {
        val shelf = LocalLog(logFile())
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))

        assertNull(shelf.fixSet("ses_1", "set_gone", SetFix(weightKg = 90.0, reps = 5, kind = SetKind.Working)))
        assertNull(shelf.fixSet("ses_gone", "set_a", SetFix(weightKg = 90.0, reps = 5, kind = SetKind.Working)))
        assertEquals(listOf(82.5), shelf.detail("ses_1")?.sets?.map { it.weightKg })
    }

    // THE TOMBSTONE, and the reason it is kept rather than only a hole being left: this session may
    // be HALF CLAIMED — a pass that landed the start and some sets and then stopped — so the claim
    // has to be told the set is gone, or the next pass would leave it standing on the account while
    // this device shows it deleted.
    @Test
    fun testDeletingASetOnTheShelfLeavesATombstoneTheClaimCanRead() {
        val file = logFile()
        val shelf = LocalLog(file)
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))

        assertTrue(shelf.deleteSet("ses_1", "set_a"))
        assertEquals(listOf("set_b"), shelf.detail("ses_1")?.sets?.map { it.id })
        assertEquals(listOf("set_a"), shelf.finished.single().deleted)

        assertFalse("a set the shelf does not hold is not this shelf's to delete",
            shelf.deleteSet("ses_1", "set_a"))

        val reopened = LocalLog(file)
        assertEquals(listOf("set_b"), reopened.detail("ses_1")?.sets?.map { it.id })
        assertEquals("a tombstone that did not survive a relaunch would be a delete that undid itself",
            listOf("set_a"), reopened.finished.single().deleted)
    }

    // The queue's copy of the same workout still carries the set §G18 removed — the crash repair in
    // `connect` re-holds it — and a merge that took it back would resurrect a set the lifter deleted.
    @Test
    fun testHoldingASessionAgainCannotResurrectASetItsTombstoneNames() {
        val shelf = LocalLog(logFile())
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))
        shelf.deleteSet("ses_1", "set_a")

        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_500),
            listOf(aSet("set_a", at = 1_100), aSet("set_b", at = 1_200))))

        assertEquals(listOf("set_b"), shelf.finished.single().sets.map { it.id })
        assertEquals(listOf("set_a"), shelf.finished.single().deleted)
    }

    // The claim's repairs rewrite the row, and a rewrite that dropped the tombstones would lose the
    // deletes with them — every one of these goes through `copy` for exactly that reason.
    @Test
    fun testTheClaimsRepairsCarryTheTombstonesThrough() {
        val shelf = LocalLog(logFile())
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000, routineId = "rt_1"),
            listOf(aSet("set_a", "ex_1", at = 1_100), aSet("set_b", "ex_1", at = 1_200))))
        shelf.deleteSet("ses_1", "set_a")

        shelf.remintExercise("ex_1", "ex_2")
        shelf.remintRoutine("rt_1", "rt_2")
        shelf.remintSet("ses_1", "set_b", "set_c")
        shelf.orphanRoutine("rt_2")
        shelf.remintSession("ses_1", "ses_2")
        shelf.dropSet("ses_2", "set_c")

        assertEquals(listOf("set_a"), shelf.finished.single().deleted)
        assertTrue(shelf.finished.single().sets.isEmpty())
    }
}
