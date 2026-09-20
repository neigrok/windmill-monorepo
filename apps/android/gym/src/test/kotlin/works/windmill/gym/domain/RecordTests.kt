package works.windmill.gym.domain

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordTests {
    private val json = Json { ignoreUnknownKeys = true }

    private val squat = Exercise(id = "back-squat", name = "Back Squat", pattern = "squat",
                                 equipment = "barbell", stepKg = 2.5)
    private val chin = Exercise(id = "chin-up", name = "Chin-up", pattern = "pull",
                                equipment = "bodyweight")

    private val today = 1_786_435_200_000   // Tue 11 Aug 2026, 08:00 UTC
    private val julyThirteenth = today - 29 * 86_400_000L
    private val julyTwentySeventh = today - 15 * 86_400_000L

    private fun decoded(text: String): MovementRecord =
        json.decodeFromString(MovementRecord.serializer(), text)

    private fun set(id: String, weightKg: Double, reps: Int, at: Long,
                    kind: SetKind = SetKind.Working, exerciseId: String = "back-squat") =
        TrainingSet(id = id, exerciseId = exerciseId, weightKg = weightKg, reps = reps,
                    kind = kind, completedAtMs = at)

    private fun session(id: String, at: Long, sets: List<TrainingSet>, open: Boolean = false) =
        SessionDetail(Session(id = id, startedAtMs = at, finishedAtMs = if (open) null else at + 3_600_000), sets)

    @Test
    fun testTheWireShapeDecodesWithEveryAbsenceIntact() {
        val record = decoded("""
        {"exercise":{"id":"back-squat","name":"Back Squat","pattern":"squat","equipment":"barbell",
                     "stepKg":2.5,"custom":false},
         "routineCount":2,"sessionCount":34,
         "bestE1rm":{"weightKg":105,"reps":5,"at":$today,"e1rm":122.5},
         "heaviest":{"weightKg":105,"reps":5,"at":$today,"e1rm":122.5},
         "e1rmSeries":[{"at":$julyThirteenth,"weightKg":100,"reps":5,"e1rm":116.7},
                       {"at":$today,"weightKg":105,"reps":5,"e1rm":122.5}],
         "records":[{"at":$today,"weightKg":105,"reps":5,"e1rm":122.5},
                    {"at":$julyThirteenth,"weightKg":100,"reps":5,"e1rm":116.7}],
         "recentDays":[{"sessionId":"ses_1","startedAt":$today,
                        "sets":[{"id":"set_1","exerciseId":"back-squat","setNumber":1,"weightKg":105,
                                 "reps":5,"kind":"working","note":"","completedAt":$today}]}]}
        """)

        assertEquals(squat, record.exercise)
        assertEquals(2, record.routineCount)
        assertEquals(34, record.sessionCount)
        assertEquals(RecordMark(105.0, 5, today, 122.5), record.bestE1rm)
        assertEquals(RecordMark(105.0, 5, today, 122.5), record.heaviest)
        assertEquals(listOf(116.7, 122.5), record.e1rmSeries.map { it.e1rm })
        assertEquals("records are newest first — the standing one leads", listOf(today, julyThirteenth),
                     record.records.map { it.atMs })
        assertEquals(listOf("set_1"), record.recentDays.single().sets.map { it.id })
    }

    @Test
    fun testTheShelfComposesTheSameRecordMinusTheEstimator() {
        val routines = listOf(
            Routine(id = "rt_1", name = "Push A", entries = listOf(
                RoutineEntry(position = 1, exerciseId = "back-squat", sets = List(5) { SetTarget() }))),
            Routine(id = "rt_2", name = "Pull A", entries = listOf(
                RoutineEntry(position = 1, exerciseId = "chin-up", sets = List(3) { SetTarget() }))),
        )
        val history = listOf(
            session("ses_1", julyThirteenth, listOf(set("s1", 60.0, 10, julyThirteenth, SetKind.Warmup),
                                                    set("s2", 100.0, 5, julyThirteenth + 200_000))),
            session("ses_2", today, listOf(set("s3", 105.0, 5, today),
                                           set("s4", 105.0, 4, today + 200_000))),
            session("ses_3", today + 600_000, listOf(set("s5", 200.0, 1, today + 600_000)), open = true),
        )

        val record = MovementRecord.of(squat, history, routines)

        assertEquals(1, record.routineCount)
        assertEquals("the open session is not in the log — it is the workout being stood in",
                     2, record.sessionCount)
        assertEquals(RecordMark(105.0, 5, today), record.heaviest)
        assertNull("Legacy record metadata leaves qualified estimates to StatsProgress",
                   record.heaviest?.e1rm)
        assertNull(record.bestE1rm)
        assertTrue(record.e1rmSeries.isEmpty())
        assertTrue(record.records.isEmpty())
        assertEquals("newest first", listOf("ses_2", "ses_1"), record.recentDays.map { it.sessionId })
        assertEquals("a warmup counts toward nothing, here as everywhere",
                     listOf("s2"), record.recentDays.last().sets.map { it.id })
    }

    @Test
    fun testTheShelfKeepsTheSameTenDayCeilingTheLogDoes() {
        val history = (0 until 14).map { day ->
            session("ses_$day", today - day * 86_400_000L,
                    listOf(set("s$day", 100.0, 5, today - day * 86_400_000L)))
        }

        val record = MovementRecord.of(squat, history, routines = emptyList())

        assertEquals(14, record.sessionCount)
        assertEquals(MovementRecord.recentDaysShown, record.recentDays.size)
        assertEquals(listOf("ses_0", "ses_9"),
                     listOf(record.recentDays.first().sessionId, record.recentDays.last().sessionId))
    }

    @Test
    fun qualifiedProjectionOwnsFactsWhileMetadataRetainsRecentSetsAndAliasScope() {
        val detail = session("qualified", today, listOf(set("estimate", 100.0, 5, today), set("heaviest", 120.0, 12, today)))
        val progress = StatsProgress.of(listOf(detail), today).movement(squat.id)
        val record = MovementRecord(exercise = squat, bestE1rm = RecordMark(999.0, 1, today, 999.0),
            heaviest = RecordMark(999.0, 1, today), sessionCount = 8,
            recentDays = listOf(RecordDay(detail.session.id, today, detail.sets)))
        assertEquals(Record.Page("Back Squat", "Barbell",
            listOf(Record.Tile("Best e1RM", "116.7", "kg · today", true), Record.Tile("Heaviest", "120", "kg · 12 reps", false)),
            listOf(Record.Best("100 × 5", "e1RM 116.7", "today", true)),
            listOf(Record.Day("today", "100 × 5 · 120 × 12")), null, null), Record.page(record, today, progress))
    }

    @Test
    fun signedFactsAndSuccessfulUntrainedDataNeverBecomeZeroEstimates() {
        val detail = session("assisted", today, listOf(set("assistance", -20.0, 8, today, exerciseId = chin.id)))
        val movement = StatsProgress.of(listOf(detail), today).movement(chin.id)
        val page = Record.page(MovementRecord.of(chin, listOf(detail), emptyList()), today, movement)
        assertEquals(listOf(Record.Tile("Heaviest", "−20", "kg · 8 reps", false)), page.tiles)
        assertNull(page.noEstimate)
        assertNull(page.nothingYet)
        assertEquals("Nothing logged for this movement yet. The first set you log lands here.",
            Record.page(MovementRecord(chin), today, MovementProgress(chin.id, emptyList())).nothingYet)
    }
}
