package works.windmill.gym.ui

import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.domain.PlanSnapshot
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.Older

class LogScreenTests {
    private val zone: ZoneId = ZoneId.systemDefault()

    private fun at(date: String, hour: Int = 18): Long =
        LocalDate.parse(date).atStartOfDay(zone).plusHours(hour.toLong()).toInstant().toEpochMilli()

    private fun set(weightKg: Double, reps: Int, at: Long, kind: SetKind = SetKind.Working) =
        TrainingSet(id = "set_$at$weightKg$reps", exerciseId = "bench-press", weightKg = weightKg,
                    reps = reps, kind = kind, completedAtMs = at)

    private fun session(id: String, day: String, routine: String? = null, sets: List<TrainingSet>) =
        SessionSummary(
            Session(id = id, startedAtMs = at(day), finishedAtMs = at(day) + 3_600_000,
                    plan = routine?.let { PlanSnapshot(routine = it) }),
            sets,
        )

    private fun weeks(sessions: List<SessionSummary>, onThisDevice: Set<String> = emptySet(),
                      complete: Boolean = true) =
        LogFold.weeks(sessions, onThisDevice, complete = complete, nowMs = at("2026-08-09", hour = 20))

    @Test
    fun sessionsFoldIntoMondayWeeksNewestFirst() {
        val log = listOf(
            session("s1", "2026-08-09", "Push A", listOf(set(100.0, 5, at("2026-08-09")))),
            session("s2", "2026-08-03", "Legs", listOf(set(100.0, 5, at("2026-08-03")))),
            session("s3", "2026-08-01", "Push B", listOf(set(100.0, 5, at("2026-08-01")))),
        )

        val folded = weeks(log)

        assertEquals(listOf("week of 3 Aug", "week of 27 Jul"), folded.map { it.label })
        assertEquals(listOf(listOf("s1", "s2"), listOf("s3")),
                     folded.map { week -> week.rows.map { it.summary.id } })
    }

    @Test
    fun aRowCarriesTheFourFactsALifterScans() {
        val log = listOf(session("s1", "2026-08-07", "Pull A", listOf(
            set(60.0, 10, at("2026-08-07")),
            set(60.0, 10, at("2026-08-07") + 1),
            set(40.0, 8, at("2026-08-07") + 2, kind = SetKind.Warmup),
        )))

        val row = weeks(log).single().rows.single()

        assertEquals("Pull A", row.title)
        assertEquals("Fri 7 Aug", row.at)
        assertEquals("the warmup counts toward nothing, here as everywhere", "2 working", row.working)
        assertEquals("1.2 t", row.tonnage)
        assertEquals("no phone computes an Epley, so a device-held row shows no estimate",
                     null, row.estimate)
        assertFalse("nor does a phone judge a record — that is the log's verdict", row.record)
    }

    @Test
    fun theGoldDotIsTheLogsVerdictAndNeverThisPhonesGuess() {
        val squat = set(180.0, 5, at("2026-08-07"))
        val log = listOf(
            SessionSummary(id = "s1", startedAtMs = at("2026-08-07"),
                finishedAtMs = at("2026-08-07") + 3_600_000, plan = PlanSnapshot(routine = "Push A"),
                workingSetCount = 11, topE1rm = 122.5, record = true),
            session("s2", "2026-08-05", "Legs", listOf(squat)),
        )

        val rows = weeks(log).single().rows

        assertTrue(rows.first().record)
        assertEquals("e1RM 122.5", rows.first().estimate)
        assertFalse("a session the device composed claims no record of its own", rows.last().record)
    }

    @Test
    fun aSessionNobodyPlannedIsNamedRatherThanLeftBlank() {
        val log = listOf(session("s1", "2026-08-07", null, listOf(set(60.0, 10, at("2026-08-07")))))

        assertEquals(Readout.noRoutine, weeks(log).single().rows.single().title)
    }

    @Test
    fun todaysRowKeepsItsClockAndOlderOnesAreDates() {
        val log = listOf(session("s1", "2026-08-09", "Push A", listOf(set(100.0, 5, at("2026-08-09")))))

        assertEquals("today · 18:00", weeks(log).single().rows.single().at)
    }

    @Test
    fun aSessionThatMovedNoExternalLoadPrintsNoTonnage() {
        val log = listOf(session("s1", "2026-08-07", "Pull A", listOf(
            set(0.0, 9, at("2026-08-07")),
            set(-20.0, 8, at("2026-08-07") + 1),
        )))

        val week = weeks(log).single()
        assertEquals("2 working", week.rows.single().working)
        assertNull(week.rows.single().tonnage)
        assertNull(week.tonnage)
    }

    @Test
    fun aRowFromALogThatSentNeitherNumberDrawsNeither() {
        val log = listOf(
            SessionSummary(id = "s1", startedAtMs = at("2026-08-07"),
                finishedAtMs = at("2026-08-07") + 3_600_000, plan = PlanSnapshot(routine = "Pull A")),
            session("s2", "2026-08-05", "Legs", listOf(set(100.0, 10, at("2026-08-05")))),
        )

        val week = weeks(log)

        assertNull(week.single().rows.first().working)
        assertNull(week.single().rows.first().tonnage)
        assertEquals("1.0 t", week.single().rows.last().tonnage)
        assertNull("one unknown session takes the week's caption with it", week.single().tonnage)
    }

    @Test
    fun theOldestLoadedWeekOmitsItsTonnageUntilTheLogHasBeenReadToTheBottom() {
        val log = listOf(
            session("s1", "2026-08-05", "Push A", listOf(set(100.0, 10, at("2026-08-05")))),
            session("s2", "2026-08-01", "Push B", listOf(set(100.0, 10, at("2026-08-01")))),
        )

        val partial = weeks(log, complete = false)
        assertEquals("1.0 t", partial[0].tonnage)
        assertNull("half a week is not a week's tonnage", partial[1].tonnage)

        val whole = weeks(log, complete = true)
        assertEquals(listOf("1.0 t", "1.0 t"), whole.map { it.tonnage })
    }

    @Test
    fun aRowTheShelfHoldsIsMarkedAsSavedOnThisDeviceOnly() {
        val log = listOf(
            session("s1", "2026-08-07", "Pull A", listOf(set(60.0, 10, at("2026-08-07")))),
            session("s2", "2026-08-05", "Legs", listOf(set(60.0, 10, at("2026-08-05")))),
        )

        val rows = weeks(log, onThisDevice = setOf("s2")).single().rows

        assertEquals(listOf(false, true), rows.map { it.onThisDeviceOnly })
    }

    @Test
    fun theOpenSessionIsNotADrawnRow() {
        val running = SessionSummary(
            Session(id = "live", startedAtMs = at("2026-08-09")),
            listOf(set(100.0, 5, at("2026-08-09"))),
        )
        val log = listOf(running,
            session("s1", "2026-08-07", "Pull A", listOf(set(60.0, 10, at("2026-08-07")))))

        val rows = weeks(log).flatMap { it.rows }

        assertEquals(listOf("s1"), rows.map { it.summary.id })
    }

    @Test
    fun aLogWithNothingInItFoldsIntoNoWeeks() {
        assertTrue(weeks(emptyList()).isEmpty())
    }

    // The head over the weeks counts what is IN HAND, and its silence is not a stance: `opening the
    // log…` says the read has not answered yet, so it may not be drawn over an account whose rows a
    // window is merely holding. A window decides which rows are drawn, never what state a screen is
    // in (`13-gestures.md`).
    @Test
    fun theHeadCountsTheRowsInHandAndSaysNothingIsOpeningOverALogTheAccountHolds() {
        val log = listOf(
            session("s1", "2026-08-07", "Pull A", listOf(set(60.0, 10, at("2026-08-07")))),
            session("s2", "2026-07-30", "Legs", listOf(set(60.0, 10, at("2026-07-30")))),
        )

        assertEquals("2 sessions · 2 weeks loaded",
                     LogFold.head(weeks(log), Older.End, logHolds = true))
        assertEquals("1 session · 1 week loaded",
                     LogFold.head(weeks(log.take(1)), Older.More, logHolds = true))

        // Every row withheld, and the account still holding them: neither the count nor the wait.
        assertNull("the read landed — nothing about this log is still opening",
                   LogFold.head(emptyList(), Older.More, logHolds = true))
        assertEquals("and with nothing in the account it IS the read still in flight",
                     "opening the log…", LogFold.head(emptyList(), Older.More, logHolds = false))
        assertNull("a log read to its bottom has nothing left to count",
                   LogFold.head(emptyList(), Older.End, logHolds = false))
        assertNull("and a read that failed says so at the foot, not here",
                   LogFold.head(emptyList(), Older.Failed, logHolds = false))
    }
}
