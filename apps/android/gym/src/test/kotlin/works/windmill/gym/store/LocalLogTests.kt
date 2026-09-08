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
import works.windmill.gym.domain.PlanEntry
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineEntry
import works.windmill.gym.domain.SetTarget
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet

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
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press", sets = List(5) { SetTarget() }))))
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

    // The previous app version's bytes, as it wrote them: one minted movement, one ramp routine
    // already in this version's shape, one routine still in the `targetSets` triple, and one finished
    // session whose frozen plan carries the scalar `sets · reps · weightKg`. Opening rewrites them
    // on the way in and loses nothing; the next flush writes the file in this version's shape.
    @Test
    fun testAShelfWrittenByThePreviousVersionIsRewrittenOnOpenAndNothingIsLost() {
        val file = logFile()
        file.writeText(
            """{"shelves":{"anon":{"exercises":[{"id":"ex_1","name":"Zercher Squat","pattern":"squat","equipment":"barbell","custom":true}],""" +
            """"routines":[{"id":"rt_1","name":"Lower A","position":1,"entries":[{"position":1,"exerciseId":"back-squat",""" +
            """"sets":[{"reps":5,"weightKg":60.0},{"reps":5,"weightKg":80.0},{"reps":3,"weightKg":90.0},{"reps":1,"weightKg":100.0},{"reps":5,"weightKg":80.0}],"restSeconds":180}]},""" +
            """{"id":"rt_2","name":"Push Day","position":2,"entries":[{"position":1,"exerciseId":"bench-press","targetSets":3,"targetReps":8,"targetWeightKg":60.0,"restSeconds":90},""" +
            """{"position":2,"exerciseId":"chin-up","targetSets":4},{"position":3,"exerciseId":"face-pull"}]}],""" +
            """"finished":[{"session":{"id":"ses_1","startedAt":1000,"finishedAt":2000,"routineId":"rt_0","plan":{"routine":"Push A","entries":[""" +
            """{"exerciseId":"bench-press","sets":5,"reps":5,"weightKg":82.5,"restSeconds":120},{"exerciseId":"chin-up","sets":3},{"exerciseId":"face-pull"}]}},""" +
            """"sets":[{"id":"set_a","exerciseId":"bench-press","weightKg":82.5,"reps":5,"kind":"working","completedAt":1100}]}]}}}"""
        )
        val ramp = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0))
        val pushDay = listOf(
            RoutineEntry(position = 1, exerciseId = "bench-press", sets = List(3) { SetTarget(8, 60.0) }, restSeconds = 90),
            RoutineEntry(position = 2, exerciseId = "chin-up", sets = List(4) { SetTarget() }),
            RoutineEntry(position = 3, exerciseId = "face-pull"),
        )
        val plan = PlanSnapshot(routine = "Push A", entries = listOf(
            PlanEntry(exerciseId = "bench-press", sets = List(5) { SetTarget(5, 82.5) }, restSeconds = 120),
            PlanEntry(exerciseId = "chin-up", sets = List(3) { SetTarget() }),
            PlanEntry(exerciseId = "face-pull"),
        ))
        fun LocalLog.assertWhole() {
            assertEquals(listOf("Lower A", "Push Day"), routines.map { it.name })
            assertEquals(listOf(RoutineEntry(position = 1, exerciseId = "back-squat", sets = ramp, restSeconds = 180)), routine("rt_1")!!.entries)
            assertEquals(pushDay, routine("rt_2")!!.entries)
            assertEquals(plan, row("ses_1")!!.session.plan)
            assertEquals(listOf("set_a"), row("ses_1")!!.sets.map { it.id })
        }

        val shelf = LocalLog(file)
        shelf.assertWhole()
        assertEquals(listOf("Zercher Squat"), shelf.exercises.map { it.name })
        assertTrue("not written back until the next flush", file.readText().contains("\"targetSets\""))

        shelf.hold(Exercise(id = "ex_2", name = "Pause Bench", custom = true))
        val written = file.readText()
        assertFalse(written.contains("targetSets") || written.contains("targetReps") || written.contains("targetWeightKg"))
        assertFalse(written.contains("\"sets\":5") || written.contains("\"sets\":3"))
        assertTrue(written.contains("\"sets\":[{\"reps\":5,\"weightKg\":82.5}"))
        assertTrue("the open line stays the absence", written.contains("{\"exerciseId\":\"face-pull\"}"))

        val reopened = LocalLog(file)
        reopened.assertWhole()
        assertEquals(listOf("Zercher Squat", "Pause Bench"), reopened.exercises.map { it.name })
    }

    // A row this build cannot read costs that row and never the shelf around it.
    @Test
    fun testOneUnreadableRowCostsThatRowAndNeverTheShelf() {
        val file = logFile()
        file.writeText(
            """{"shelves":{"anon":{"exercises":[{"id":"ex_1","name":"Zercher Squat"},{"id":"ex_2"}],""" +
            """"routines":[{"id":"rt_1","name":"Push Day","entries":[{"position":1,"exerciseId":"bench-press","sets":[{"reps":8,"weightKg":60.0}]}]},""" +
            """{"id":"rt_2","name":"Broken","entries":[{"position":1,"exerciseId":"bench-press","sets":[{"reps":"eight"}]}]}],""" +
            """"finished":[{"session":{"id":"ses_1","startedAt":1000,"finishedAt":2000},"sets":[{"id":"set_a","exerciseId":"bench-press","weightKg":82.5,"reps":5,"completedAt":1100}]},""" +
            """{"session":{"id":"ses_2","startedAt":"yesterday"},"sets":[]}]}}}"""
        )

        val shelf = LocalLog(file)
        assertEquals(listOf("Zercher Squat"), shelf.exercises.map { it.name })
        assertEquals(listOf("Push Day"), shelf.routines.map { it.name })
        assertEquals(listOf("ses_1"), shelf.finished.map { it.session.id })
        assertEquals(listOf("set_a"), shelf.detail("ses_1")?.sets?.map { it.id })
    }

    @Test
    fun testAPartialFileFromBeforeTheSeatsBelongsToTheSeatTheDeviceWasHolding() {
        val file = logFile()
        file.writeText("""{"routines":[{"id":"rt_1","name":"Push Day"}],"unknownKey":true}""")

        val shelf = LocalLog(file, deviceOwner = "alice")
        assertEquals(listOf("Push Day"), shelf.routines.map { it.name })
        assertNull("no door is needed and none is offered", shelf.unattributed)

        shelf.adopt(null)
        shelf.adopt("alice")
        assertEquals("through the app's own null-first connect ordering",
            listOf("Push Day"), shelf.routines.map { it.name })

        shelf.adopt("bob")
        assertEquals("and it went to A alone", emptyList<Routine>(), shelf.routines)
        assertNull(shelf.unattributed)
        shelf.adopt("alice")
        assertEquals(listOf("Push Day"), shelf.routines.map { it.name })

        val relaunched = LocalLog(file, deviceOwner = "alice")
        assertEquals("seated on disk, not only in memory",
            listOf("Push Day"), relaunched.routines.map { it.name })
        assertNull("and the decision was written, so it is not made again", relaunched.unattributed)
    }

    @Test
    fun testAFileFromBeforeTheSeatsOnASignedOutDeviceStaysQuarantined() {
        val file = logFile()
        file.writeText("""{"routines":[{"id":"rt_1","name":"Push Day"}],"unknownKey":true}""")

        val shelf = LocalLog(file, deviceOwner = null)
        assertEquals("no seat draws it", emptyList<Routine>(), shelf.routines)
        shelf.adopt(null)
        shelf.adopt("alice")
        assertEquals("not even the first account to sign in afterwards",
            emptyList<Routine>(), shelf.routines)
        assertEquals("and the decision is on DISK — a relaunch that does hold a session re-reads " +
            "this file and must still find a quarantine, not a shelf to hand over",
            emptyList<Routine>(), LocalLog(file, deviceOwner = "bob").routines)
        assertTrue(shelf.finished.isEmpty())
        assertEquals(1, shelf.unattributed?.routines)
        assertEquals(0, shelf.unattributed?.sessions)
        assertEquals(0, shelf.unattributed?.movements)

        shelf.adopt(null)
        assertFalse("nobody signed in cannot say whose this is", shelf.release())
        shelf.adopt("alice")
        assertTrue(shelf.release())
        assertEquals(listOf("Push Day"), shelf.routines.map { it.name })
        assertNull("and the quarantine is empty once it has been claimed", shelf.unattributed)
        val relaunched = LocalLog(file, deviceOwner = "alice")
        assertEquals("released onto the seat, not only into memory",
            listOf("Push Day"), relaunched.routines.map { it.name })
    }

    @Test
    fun testASignedOutMigrationIsWrittenDownAtOnce() {
        val file = logFile()
        file.writeText("""{"routines":[{"id":"rt_1","name":"Push Day"}]}""")

        LocalLog(file, deviceOwner = null)

        val later = LocalLog(file, deviceOwner = "bob")
        assertEquals("B'S SHELF RECEIVED A STRANGER'S ROUTINE", emptyList<Routine>(), later.routines)
        assertEquals(1, later.unattributed?.routines)
    }

    @Test
    fun testDiscardingTheQuarantineTakesItOffTheDiskAndLeavesTheSeatAlone() {
        val file = logFile()
        val shelf = LocalLog(file)
        shelf.hold(Routine(id = "rt_mine", name = "Mine"))
        shelf.adopt("alice")
        shelf.hold(Routine(id = "rt_alice", name = "Alice's"))
        file.writeText("""{"routines":[{"id":"rt_old","name":"Somebody's"}]}""")

        val reopened = LocalLog(file, deviceOwner = null)
        assertEquals(1, reopened.unattributed?.routines)
        reopened.discardUnattributed()
        assertNull(reopened.unattributed)
        assertEquals(emptyList<Routine>(), reopened.routines)
        assertNull("and it is gone from the disk too", LocalLog(file, null).unattributed)
    }

    @Test
    fun testAShelfFilledUnderOneSeatIsNeverDrawnForTheNext() {
        val file = logFile()
        val shelf = LocalLog(file)
        shelf.adopt("alice")
        shelf.hold(Exercise(id = "ex_a", name = "Alice's Lift", custom = true))
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_alice", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))

        shelf.adopt(null)
        assertEquals("signing out is not a shelf", emptyList<Exercise>(), shelf.exercises)
        assertTrue(shelf.finished.isEmpty())

        shelf.adopt("bob")
        assertEquals("and the next account inherits nothing", emptyList<Exercise>(), shelf.exercises)
        assertTrue("nothing for a claim to replay into Bob's log", shelf.finished.isEmpty())
        assertNull("nor is it offered as unattributed", shelf.unattributed)

        val relaunched = LocalLog(file)
        relaunched.adopt("alice")
        assertEquals(listOf("ex_a"), relaunched.exercises.map { it.id })
        assertEquals("A's own work is waiting for A, not lost to close the leak",
            listOf("ses_alice"), relaunched.finished.map { it.session.id })
    }

    @Test
    fun testAnonymousWorkRidesOntoTheFirstConfirmedSeatAndOnlyOnce() {
        val file = logFile()
        val shelf = LocalLog(file)
        shelf.hold(Exercise(id = "ex_anon", name = "Sled Push", custom = true))
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_anon", startedAtMs = 1_000, finishedAtMs = 2_000),
            listOf(aSet("set_a", at = 1_100))))

        shelf.adopt("alice")
        assertEquals(listOf("ex_anon"), shelf.exercises.map { it.id })
        assertEquals(listOf("ses_anon"), shelf.finished.map { it.session.id })

        shelf.adopt(null)
        assertEquals("it left the anonymous shelf when it was claimed",
            emptyList<Exercise>(), shelf.exercises)
        shelf.adopt("bob")
        assertTrue("so no second account gets it", shelf.exercises.isEmpty() && shelf.finished.isEmpty())
    }

    @Test
    fun testAnUnconfirmedSeatLeavesTheAnonymousShelfWhereItIs() {
        val file = logFile()
        val shelf = LocalLog(file)
        shelf.hold(Exercise(id = "ex_anon", name = "Sled Push", custom = true))

        shelf.adopt("alice", confirmed = false)
        assertEquals("nothing of nobody's rides onto a seat nobody answered for",
            emptyList<Exercise>(), shelf.exercises)

        shelf.adopt(null)
        assertEquals(listOf("ex_anon"), shelf.exercises.map { it.id })
        shelf.adopt("alice", confirmed = true)
        assertEquals("and the first verified connect carries it",
            listOf("ex_anon"), shelf.exercises.map { it.id })
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

    @Test
    fun testRemintingAMovementReachesRoutinesPlansAndSets() {
        val shelf = LocalLog(logFile())
        shelf.hold(Exercise(id = "ex_spent", name = "Zercher Squat", custom = true))
        shelf.hold(Routine(id = "rt_1", name = "Legs",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "ex_spent", sets = List(3) { SetTarget() }))))
        shelf.hold(LocalLog.FinishedSession(
            Session(id = "ses_1", startedAtMs = 1_000, finishedAtMs = 2_000,
                plan = works.windmill.gym.domain.PlanSnapshot(routine = "Legs",
                    entries = listOf(works.windmill.gym.domain.PlanEntry(exerciseId = "ex_spent", sets = List(3) { SetTarget() })))),
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

    @Test
    fun testFixingASetOnTheShelfRewritesTheRowAndLeavesThePlanAlone() {
        val shelf = LocalLog(logFile())
        val plan = works.windmill.gym.domain.PlanSnapshot(routine = "Push A",
            entries = listOf(works.windmill.gym.domain.PlanEntry(exerciseId = "bench-press",
                sets = List(5) { SetTarget(5, 82.5) })))
        shelf.hold(Routine(id = "rt_1", name = "Push A",
            entries = listOf(RoutineEntry(position = 1, exerciseId = "bench-press",
                sets = List(5) { SetTarget(5, 82.5) }))))
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
            listOf(List(5) { SetTarget(5, 82.5) }), shelf.routines.single().entries.map { it.sets })
        assertEquals(plan, shelf.finished.single().session.plan)
        assertEquals("rt_1", shelf.finished.single().session.routineId)
    }

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
