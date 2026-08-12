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

// THE LOG'S OWN ARITHMETIC, with no screen around it: which week a session fell in, what a row says,
// and the two places this product refuses to print a number it cannot stand behind — a tonnage of
// zero, and the tonnage of a week that is only half loaded.

class LogScreenTests {
    private val zone: ZoneId = ZoneId.systemDefault()

    private fun at(date: String, hour: Int = 18): Long =
        LocalDate.parse(date).atStartOfDay(zone).plusHours(hour.toLong()).toInstant().toEpochMilli()

    private fun set(weightKg: Double, reps: Int, at: Long, kind: SetKind = SetKind.Working) =
        TrainingSet(id = "set_$at$weightKg$reps", exerciseId = "bench-press", weightKg = weightKg,
                    reps = reps, kind = kind, completedAtMs = at)

    // Composed the way the device composes a session only the device holds — so the counts and the
    // tonnage under test are the ones a signed-out lifter really sees.
    private fun session(id: String, day: String, routine: String? = null, sets: List<TrainingSet>) =
        SessionSummary(
            Session(id = id, startedAtMs = at(day), finishedAtMs = at(day) + 3_600_000,
                    plan = routine?.let { PlanSnapshot(routine = it) }),
            sets,
        )

    private fun weeks(sessions: List<SessionSummary>, onThisDevice: Set<String> = emptySet(),
                      complete: Boolean = true) =
        LogFold.weeks(sessions, onThisDevice, complete = complete, nowMs = at("2026-08-09", hour = 20))

    // Newest first, and a week is the week the lifter trained in — Monday to Sunday, in their own
    // zone. A session on a Sunday night belongs to the week it was lived in.
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

    // Four facts and no fifth. The routine names the row, or the one word this product uses for a
    // session nobody planned.
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

    // §G'S GOLD DOT is the log's own verdict carried through and never re-derived: the three record
    // rules need the whole history and an Epley, and this phone holds neither. So a row the log
    // called a record draws one, and a row from a server that never spoke draws none — an omission,
    // which is exactly what saying nothing means.
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

    // Today's session still carries its clock — a workout finished an hour ago is placed by the
    // hour. Every older one is a date.
    @Test
    fun todaysRowKeepsItsClockAndOlderOnesAreDates() {
        val log = listOf(session("s1", "2026-08-09", "Push A", listOf(set(100.0, 5, at("2026-08-09")))))

        assertEquals("today · 18:00", weeks(log).single().rows.single().at)
    }

    // AN ASSISTED SET MOVED NO EXTERNAL LOAD, so it contributes zero rather than subtracting — and a
    // session that moved nothing at all says NOTHING where the tonnage would go. A chin-up-and-dips
    // day did not move zero kilograms; we simply have nothing true to say about it, and `0.0 t`
    // would be a false zero.
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

    // A release APK outlives a deploy. A log that sent neither number gets none invented for it —
    // the row draws what it has and nothing else, and the week keeps its caption to itself rather
    // than captioning a total that is quietly one session short.
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

    // Paging is newest-first, so every loaded week is whole EXCEPT possibly the oldest one — half of
    // it is in hand and the rest is one tap away. Its divider says nothing until the rest arrives,
    // for the same reason a zero says nothing.
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

    // The ring is REAL on this surface: a signed-out lifter's whole log is saved on this device, and
    // saying so is the same sentence Today's claim card says. It is a fact, never a warning.
    @Test
    fun aRowTheShelfHoldsIsMarkedAsSavedOnThisDeviceOnly() {
        val log = listOf(
            session("s1", "2026-08-07", "Pull A", listOf(set(60.0, 10, at("2026-08-07")))),
            session("s2", "2026-08-05", "Legs", listOf(set(60.0, 10, at("2026-08-05")))),
        )

        val rows = weeks(log, onThisDevice = setOf("s2")).single().rows

        assertEquals(listOf(false, true), rows.map { it.onThisDeviceOnly })
    }

    // AN OPEN SESSION IS NOT IN THE LOG. It is the workout the lifter is standing in, its numbers
    // change under them, and the logger is where it lives.
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
}
