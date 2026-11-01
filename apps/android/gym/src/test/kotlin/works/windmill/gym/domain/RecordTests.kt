package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.gym.domain.sync.RecentDay

class RecordTests {
    private val squat = Exercise(id = "back-squat", name = "Back Squat", pattern = "squat",
                                 equipment = "barbell", stepKg = 2.5)
    private val chin = Exercise(id = "chin-up", name = "Chin-up", pattern = "pull",
                                equipment = "bodyweight")

    private val today = 1_786_435_200_000   // Tue 11 Aug 2026, 08:00 UTC
    private val julyThirteenth = today - 29 * 86_400_000L

    private fun set(id: String, weightKg: Double, reps: Int, at: Long,
                    exerciseId: String = "back-squat") =
        TrainingSet(id = id, exerciseId = exerciseId, weightKg = weightKg, reps = reps,
                    completedAtMs = at)

    private fun session(id: String, at: Long, sets: List<TrainingSet>, open: Boolean = false) =
        SessionDetail(Session(id = id, startedAtMs = at, finishedAtMs = if (open) null else at + 3_600_000), sets)

    @Test
    fun bodyweightRepsStayVisibleBesideLoadedAndAssistedSets() {
        for ((kg, reps) in listOf(10.0 to 12, -20.0 to 15)) for (combined in listOf(true, false)) {
            val zero = set("bodyweight", 0.0, 12, today, exerciseId = chin.id)
            val other = set("other", kg, reps, today, exerciseId = chin.id)
            val details = if (combined) listOf(session("mixed", today, listOf(zero, other)))
                else listOf(session("zero", today - 86_400_000, listOf(zero)), session("other", today, listOf(other)))
            val page = Record.page(MovementRecord.of(chin, details, today), today, StatsProgress.of(details, today).movement(chin.id))
            assertEquals(Record.Tile("Most reps", "12", "reps · no added load", false), page.tiles.last())
        }
    }

    @Test
    fun testARecordReadsEverySetFromItsClosedDaysNewestFirst() {
        val history = listOf(
            session("ses_1", julyThirteenth, listOf(set("s1", 60.0, 10, julyThirteenth),
                                                    set("s2", 100.0, 5, julyThirteenth + 200_000))),
            session("ses_2", today, listOf(set("s3", 105.0, 5, today),
                                           set("s4", 105.0, 4, today + 200_000))),
            session("ses_3", today + 600_000, listOf(set("s5", 200.0, 1, today + 600_000)), open = true),
        )

        val record = MovementRecord.of(squat, history, today)

        assertEquals(squat, record.exercise)
        assertEquals("newest first, and the open session is not in the log — it is the workout being stood in",
                     listOf("ses_2", "ses_1"), record.recentDays.map { it.sessionId })
        assertEquals(listOf(RecordDay("ses_2", today, history[1].sets), RecordDay("ses_1", julyThirteenth, history[0].sets)),
                     record.recentDays)
        assertEquals(listOf("s1", "s2"), record.recentDays.last().sets.map { it.id })
    }

    @Test
    fun testARecordKeepsItsTenNewestDays() {
        val history = (0 until 14).map { day ->
            session("ses_$day", today - day * 86_400_000L,
                    listOf(set("s$day", 100.0, 5, today - day * 86_400_000L)))
        }

        val record = MovementRecord.of(squat, history, today)

        assertEquals(RecentDay.shown, record.recentDays.size)
        assertEquals(listOf("ses_0", "ses_9"),
                     listOf(record.recentDays.first().sessionId, record.recentDays.last().sessionId))
    }

    @Test
    fun qualifiedProjectionOwnsFactsWhileMetadataRetainsRecentSetsAndAliasScope() {
        val detail = session("qualified", today, listOf(set("estimate", 100.0, 5, today), set("heaviest", 120.0, 12, today)))
        val progress = StatsProgress.of(listOf(detail), today).movement(squat.id)
        val record = MovementRecord(exercise = squat, recentDays = listOf(RecordDay(detail.session.id, today, detail.sets)))
        assertEquals(Record.Page("Back Squat", "Barbell",
            listOf(Record.Tile("Best e1RM", "116.7", "kg · today", true), Record.Tile("Heaviest", "120", "kg · 12 reps", false)),
            emptyList(),
            listOf(Record.Day("today", "100 × 5 · 120 × 12")), null, null), Record.page(record, today, progress))
    }

    @Test
    fun signedFactsAndSuccessfulUntrainedDataNeverBecomeZeroEstimates() {
        val detail = session("assisted", today, listOf(set("assistance", -20.0, 8, today, exerciseId = chin.id)))
        val movement = StatsProgress.of(listOf(detail), today).movement(chin.id)
        val page = Record.page(MovementRecord.of(chin, listOf(detail), today), today, movement)
        assertEquals(listOf(Record.Tile("Heaviest", "−20", "kg · 8 reps", false)), page.tiles)
        assertNull(page.noEstimate)
        assertNull(page.nothingYet)
        assertEquals("Nothing logged for this movement yet. The first set you log lands here.",
            Record.page(MovementRecord(chin), today, StatsProgress.empty(today).movement(chin.id)).nothingYet)
    }
    @Test
    fun earlierRecordsUseTheSharedStatedStepsWithoutRepeatingTheStandingBest() {
        val rows = listOf(46.0 to 8, 50.0 to 5, 51.5 to 4, 55.0 to 4).mapIndexed { index, (weight, reps) ->
            val at = today - (3 - index) * 86_400_000L
            session("workout$index", at, listOf(set("set$index", weight, reps, at)))
        }
        val progress = StatsProgress.of(rows, today).movement(squat.id)
        assertEquals(listOf("workout0", "workout2"), progress.earlierRecords.map { it.id })
        val page = Record.page(MovementRecord.of(squat, rows, today), today, progress)
        assertEquals(listOf(Record.Best("51.5 × 4", "e1RM 58.4", "10 Aug"),
            Record.Best("46 × 8", "e1RM 58.3", "8 Aug")), page.records)
        assertEquals(Record.Tile("Best e1RM", "62.3", "kg · today", true), page.tiles.first())
        assertEquals(emptyList<Record.Best>(), Record.page(MovementRecord.of(squat, rows.take(2), today), today,
            StatsProgress.of(rows.take(2), today).movement(squat.id)).records)
    }

}
