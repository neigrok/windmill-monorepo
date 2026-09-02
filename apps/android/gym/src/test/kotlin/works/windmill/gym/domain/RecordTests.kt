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
    fun testAMovementNobodyHasLiftedDecodesAsTwoZeroesAndDrawsNoFurniture() {
        val record = decoded("""
        {"exercise":{"id":"back-squat","name":"Back Squat","pattern":"squat","equipment":"barbell",
                     "stepKg":2.5,"custom":false},
         "routineCount":0,"sessionCount":0}
        """)
        val page = Record.page(record, now = today)

        assertEquals("Back Squat", page.name)
        assertEquals("a movement in no routine says nothing about routines", "barbell · never logged",
                     page.subhead)
        assertEquals(emptyList<Record.Tile>(), page.tiles)
        assertNull("no empty chart frame with a name over it", page.chart)
        assertEquals(emptyList<Record.Best>(), page.records)
        assertEquals(emptyList<Record.Day>(), page.days)
        assertEquals("Nothing logged for this movement yet. The first set you log lands here.",
                     page.nothingYet)
        assertNull("there is no estimate MISSING — there is no training", page.noEstimate)
    }

    @Test
    fun testCountsTheServerNeverSentAreDroppedRatherThanReadAsZero() {
        val record = decoded("""
        {"exercise":{"id":"back-squat","name":"Back Squat","pattern":"squat","equipment":"barbell"},
         "heaviest":{"weightKg":105,"reps":5,"at":$today}}
        """)

        assertNull(record.routineCount)
        assertNull(record.sessionCount)
        assertEquals("barbell", Record.page(record, now = today).subhead)
    }

    @Test
    fun testTheSubheadCountsInTheProductsOwnWordsAndIsSingularAtOne() {
        val one = MovementRecord(exercise = squat, routineCount = 1, sessionCount = 1,
                                 heaviest = RecordMark(105.0, 5, today))
        val many = MovementRecord(exercise = squat, routineCount = 2, sessionCount = 34,
                                  heaviest = RecordMark(105.0, 5, today))

        assertEquals("barbell · in 1 routine · 1 session", Record.page(one, now = today).subhead)
        assertEquals("barbell · in 2 routines · 34 sessions", Record.page(many, now = today).subhead)
    }

    @Test
    fun testTheTwoTilesCarryTheSetThatMadeThemAndTheDayItHappened() {
        val record = MovementRecord(
            exercise = squat, routineCount = 2, sessionCount = 34,
            bestE1rm = RecordMark(105.0, 5, today, 122.5),
            heaviest = RecordMark(105.0, 5, today, 122.5),
        )
        val page = Record.page(record, now = today)

        assertEquals(listOf(Record.Tile("best e1RM", "122.5", "today · 105 × 5", loud = true),
                            Record.Tile("heaviest", "105", "kg · for 5", loud = false)),
                     page.tiles)
    }

    @Test
    fun testABodyweightMovementDrawsNoEstimateAnywhereAndNeverAZeroLoad() {
        val record = MovementRecord(
            exercise = chin, routineCount = 1, sessionCount = 12,
            heaviest = RecordMark(0.0, 12, today),
            recentDays = listOf(RecordDay("ses_1", today,
                listOf(set("set_1", 0.0, 12, today, exerciseId = "chin-up")))),
        )
        val page = Record.page(record, now = today)

        assertEquals(listOf(Record.Tile("most reps", "12", "reps · no added load", loud = false)),
                     page.tiles)
        assertNull("not zero, not a dash inside a chart frame — nothing", page.chart)
        assertEquals(emptyList<Record.Best>(), page.records)
        assertNull("there is no estimate to be missing, so nothing is said about one", page.noEstimate)
        assertEquals(listOf(Record.Day("today", "0 × 12")), page.days)
    }

    @Test
    fun testABandAssistedMovementKeepsItsHeaviestAndItsRealMinus() {
        val record = MovementRecord(exercise = chin, routineCount = 0, sessionCount = 8,
                                    heaviest = RecordMark(-20.0, 8, today))

        assertEquals(listOf(Record.Tile("heaviest", "−20", "kg · for 8", loud = false)),
                     Record.page(record, now = today).tiles)
    }

    @Test
    fun testAWindowPastItsPeakIsDrawnAgainstTheStandingBestAndNotItsOwn() {
        val lastYear = today - 300 * 86_400_000L
        val record = MovementRecord(
            exercise = squat, routineCount = 1, sessionCount = 40,
            bestE1rm = RecordMark(140.0, 5, lastYear, 163.3),
            heaviest = RecordMark(140.0, 5, lastYear, 163.3),
            e1rmSeries = listOf(RecordMark(90.0, 5, julyThirteenth, 105.0),
                                RecordMark(100.0, 5, today, 116.7)),
        )
        val page = Record.page(record, now = today)

        assertEquals(listOf(105.0 / 163.3, 116.7 / 163.3), page.chart!!.bars.map { it.height })
        assertEquals("the session holding the best is not in the window, so no bar is gold",
                     listOf(false, false), page.chart!!.bars.map { it.standingBest })
        assertEquals("163.3", page.tiles.first().value)
    }

    @Test
    fun testAChartOfOneDaySaysItsDateOnceRatherThanAtBothEnds() {
        val record = MovementRecord(
            exercise = squat, routineCount = 0, sessionCount = 1,
            bestE1rm = RecordMark(105.0, 5, today, 122.5),
            heaviest = RecordMark(105.0, 5, today, 122.5),
            e1rmSeries = listOf(RecordMark(105.0, 5, today, 122.5)),
        )
        val chart = Record.page(record, now = today).chart

        assertEquals(listOf(Record.Bar(1.0, standingBest = true)), chart!!.bars)
        assertEquals("11 Aug", chart.from)
        assertNull("one point is not a span", chart.to)
    }

    @Test
    fun testBarsAreMeasuredFromZeroAndOnlyTheStandingBestIsGold() {
        val record = MovementRecord(
            exercise = squat, routineCount = 2, sessionCount = 3,
            bestE1rm = RecordMark(105.0, 5, today, 122.5),
            heaviest = RecordMark(105.0, 5, today, 122.5),
            e1rmSeries = listOf(RecordMark(100.0, 5, julyThirteenth, 116.7),
                                RecordMark(102.5, 5, julyTwentySeventh, 119.6),
                                RecordMark(105.0, 5, today, 122.5)),
        )
        val chart = Record.page(record, now = today).chart

        assertNotNull(chart)
        assertEquals(listOf(116.7 / 122.5, 119.6 / 122.5, 1.0), chart!!.bars.map { it.height })
        assertEquals("at most one loud thing on a chart", listOf(false, false, true),
                     chart.bars.map { it.standingBest })
        assertEquals("12 weeks", chart.window)
        assertEquals("13 Jul", chart.from)
        assertEquals("an axis end is a date and never a word", "11 Aug", chart.to)
    }

    @Test
    fun testASeriesMissingOneEstimateDrawsNoChartAtAll() {
        val record = MovementRecord(
            exercise = squat, routineCount = 0, sessionCount = 2,
            bestE1rm = RecordMark(105.0, 5, today, 122.5),
            heaviest = RecordMark(105.0, 5, today, 122.5),
            e1rmSeries = listOf(RecordMark(0.0, 12, julyThirteenth),
                                RecordMark(105.0, 5, today, 122.5)),
        )

        assertNull(Record.page(record, now = today).chart)
    }

    @Test
    fun testPersonalRecordsReadNewestFirstAndOnlyTheStandingOneIsMarked() {
        val record = MovementRecord(
            exercise = squat, routineCount = 2, sessionCount = 34,
            bestE1rm = RecordMark(105.0, 5, today, 122.5),
            heaviest = RecordMark(105.0, 5, today, 122.5),
            records = listOf(RecordMark(105.0, 5, today, 122.5),
                             RecordMark(102.5, 5, julyTwentySeventh, 119.6),
                             RecordMark(100.0, 5, julyThirteenth, 116.7)),
        )

        assertEquals(listOf(Record.Best("105 × 5", "e1RM 122.5", "today", standing = true),
                            Record.Best("102.5 × 5", "e1RM 119.6", "27 Jul", standing = false),
                            Record.Best("100 × 5", "e1RM 116.7", "13 Jul", standing = false)),
                     Record.page(record, now = today).records)
    }

    @Test
    fun testRecentSetsAreOneLinePerDayInPerformedOrder() {
        val record = MovementRecord(
            exercise = squat, routineCount = 0, sessionCount = 2,
            heaviest = RecordMark(105.0, 5, today),
            recentDays = listOf(
                RecordDay("ses_2", today, listOf(set("s1", 105.0, 5, today),
                                                 set("s2", 105.0, 5, today + 200_000),
                                                 set("s3", 105.0, 4, today + 400_000))),
                RecordDay("ses_1", julyTwentySeventh, listOf(set("s4", 102.5, 5, julyTwentySeventh))),
            ),
        )

        assertEquals(listOf(Record.Day("today", "105 × 5 · 105 × 5 · 105 × 4"),
                            Record.Day("27 Jul", "102.5 × 5")),
                     Record.page(record, now = today).days)
    }

    @Test
    fun testADropSetIsPrintedAsOneRatherThanCountedAsWork() {
        val record = MovementRecord(
            exercise = squat, routineCount = 0, sessionCount = 1,
            heaviest = RecordMark(100.0, 5, today),
            recentDays = listOf(RecordDay("ses_1", today, listOf(
                set("s1", 100.0, 5, today),
                set("s2", 70.0, 12, today + 100_000, SetKind.Drop),
                set("s3", 60.0, 9, today + 200_000, SetKind.Failure),
            ))),
        )

        assertEquals(listOf(Record.Day("today", "100 × 5 · 70 × 12 drop · 60 × 9 failure")),
                     Record.page(record, now = today).days)
    }

    @Test
    fun testALoadedMovementWithNoEstimateSaysWhereTheEstimateLives() {
        val record = MovementRecord(exercise = squat, routineCount = 0, sessionCount = 1,
                                    heaviest = RecordMark(105.0, 5, today))
        val page = Record.page(record, now = today)

        assertEquals("e1RM needs your account — sign in for the chart.", page.noEstimate)
        assertNull(page.nothingYet)
        assertEquals(listOf(Record.Tile("heaviest", "105", "kg · for 5", loud = false)), page.tiles)
    }

    @Test
    fun testTheShelfComposesTheSameRecordMinusTheEstimator() {
        val routines = listOf(
            Routine(id = "rt_1", name = "Push A", entries = listOf(
                RoutineEntry(position = 1, exerciseId = "back-squat", targetSets = 5))),
            Routine(id = "rt_2", name = "Pull A", entries = listOf(
                RoutineEntry(position = 1, exerciseId = "chin-up", targetSets = 3))),
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
        assertNull("Epley lives in one place per language and this phone is not one of them",
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
    fun testAMovementTheShelfNeverSawIsAnEmptyRecordAndNotAFailure() {
        val record = MovementRecord.of(chin, listOf(
            session("ses_1", today, listOf(set("s1", 105.0, 5, today)))), routines = emptyList())

        assertEquals(0, record.sessionCount)
        assertNull(record.heaviest)
        assertTrue(record.recentDays.isEmpty())
        assertEquals("Nothing logged for this movement yet. The first set you log lands here.",
                     Record.page(record, now = today).nothingYet)
    }

    @Test
    fun testTheRenameProofIsFourReadsAndNeverAConstant() {
        val record = MovementRecord(
            exercise = squat,
            routineCount = 2,
            routines = listOf("Push A", "Legs"),
            sessionCount = 34,
            bestE1rm = RecordMark(110.0, 5, today, e1rm = 122.5),
            records = listOf(RecordMark(110.0, 5, today, e1rm = 122.5),
                             RecordMark(105.0, 5, today, e1rm = 117.5),
                             RecordMark(100.0, 5, today, e1rm = 112.5)),
        )

        assertEquals(
            listOf(Record.Proof("sessions", "34 · unchanged"),
                   Record.Proof("records", "3 PRs · e1RM 122.5 kept"),
                   Record.Proof("routines", "Push A · Legs"),
                   Record.Proof("old name", "searchable as an alias")),
            Record.proof(record, aliased = true))
    }

    @Test
    fun testAProofLineWithNothingBehindItIsDroppedRatherThanZeroed() {
        val untouched = MovementRecord(exercise = squat, sessionCount = 0)
        assertEquals(emptyList<Record.Proof>(), Record.proof(untouched, aliased = false))

        val older = MovementRecord(exercise = squat, routines = listOf("Push A"))
        assertEquals(listOf(Record.Proof("routines", "Push A")), Record.proof(older, aliased = false))
    }

    @Test
    fun testTheAliasIsPromisedOnlyWhereTheRenameLandsOnTheAccount() {
        val record = MovementRecord(exercise = squat, sessionCount = 3)
        assertEquals(listOf(Record.Proof("sessions", "3 · unchanged")),
                     Record.proof(record, aliased = false))
        assertEquals(listOf(Record.Proof("sessions", "3 · unchanged"),
                            Record.Proof("old name", "searchable as an alias")),
                     Record.proof(record, aliased = true))
    }

    @Test
    fun testTheRecordsLineDropsWhicheverHalfIsMissing() {
        val noEstimate = MovementRecord(exercise = chin,
            records = listOf(RecordMark(0.0, 12, today)))
        assertEquals(listOf(Record.Proof("records", "1 PR kept")),
                     Record.proof(noEstimate, aliased = false))

        val onlyStanding = MovementRecord(exercise = squat,
            bestE1rm = RecordMark(110.0, 5, today, e1rm = 122.5))
        assertEquals(listOf(Record.Proof("records", "e1RM 122.5 kept")),
                     Record.proof(onlyStanding, aliased = false))
    }

    @Test
    fun testTheShelfNamesTheRoutinesAMovementIsIn() {
        val routines = listOf(
            Routine(id = "rt_1", name = "Push A", entries = listOf(
                RoutineEntry(position = 1, exerciseId = "back-squat", targetSets = 5))),
            Routine(id = "rt_2", name = "Legs", entries = listOf(
                RoutineEntry(position = 1, exerciseId = "back-squat"))),
            Routine(id = "rt_3", name = "Pull", entries = listOf(
                RoutineEntry(position = 1, exerciseId = "chin-up", targetSets = 3))),
        )

        val record = MovementRecord.of(squat, listOf(
            session("ses_1", today, listOf(set("s1", 105.0, 5, today)))), routines)

        assertEquals(listOf("Push A", "Legs"), record.routines)
        assertEquals("the count is exactly the list", 2, record.routineCount)
        assertEquals(listOf(Record.Proof("sessions", "1 · unchanged"),
                            Record.Proof("routines", "Push A · Legs")),
                     Record.proof(record, aliased = false))
    }
}
