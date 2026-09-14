package works.windmill.gym.domain

import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

class LogReadoutTests {
    private fun at(date: String): Long = LocalDate.parse(date).atTime(18, 0)
        .atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()

    private fun session(id: String, date: String, routine: String? = null, sets: List<TrainingSet> = emptyList()): SessionSummary =
        SessionSummary(Session(id, at(date), finishedAtMs = at(date) + 3_600_000,
            plan = routine?.let { PlanSnapshot(routine = it) }), sets)

    @Test
    fun groupsActualMondayIdentitiesAndOrdersSessionsNewestFirst() {
        val sessions = listOf(session("s2", "2026-08-03"), session("s1", "2026-08-09"), session("s3", "2026-08-01"))
        val weeks = LogReadout.weeks(sessions, emptySet(), at("2026-08-09"))
        assertEquals(listOf("This week" to listOf("s1", "s2"), "Last week" to listOf("s3")),
            weeks.map { it.label to it.rows.map { row -> row.summary.id } })
        assertEquals(listOf("2026-08-03", "2026-07-27"), weeks.map {
            java.time.Instant.ofEpochMilli(it.startMs).atZone(ZoneId.systemDefault()).toLocalDate().toString() })
    }

    @Test
    fun fullRowUsesActualWorkingVolumeAndOnlyTheCompleteQualifiedEstimate() {
        val sets = listOf(
            TrainingSet("first", "bench", weightKg = 60.0, reps = 10, completedAtMs = at("2026-08-07")),
            TrainingSet("second", "bench", weightKg = 60.0, reps = 10, completedAtMs = at("2026-08-07") + 1),
            TrainingSet("warmup", "bench", weightKg = 40.0, reps = 8, kind = SetKind.Warmup, completedAtMs = at("2026-08-07") + 2))
        val summary = session("s1", "2026-08-07", "Pull A", sets).copy(topE1rm = 999.0, record = true)
        val progress = StatsProgress.of(listOf(SessionDetail(summary.session, sets)), at("2026-08-09"))
        assertEquals(LogReadout.Row(summary, "Pull A", "Friday · 60 min · 2 working sets",
            "1,200 kg volume · e1RM 80 kg", true, true),
            LogReadout.weeks(listOf(summary), setOf("s1"), at("2026-08-09"), progress).single().rows.single())
        assertEquals("1,200 kg volume",
            LogReadout.weeks(listOf(summary), emptySet(), at("2026-08-09")).single().rows.single().caption)
    }

    @Test
    fun signedLoadsDoNotInventExternalVolumeOrQualifiedEstimates() {
        val summary = session("s1", "2026-08-07", sets = listOf(
            TrainingSet("first", "pullup", weightKg = 0.0, reps = 9, completedAtMs = at("2026-08-07")),
            TrainingSet("second", "pullup", weightKg = -20.0, reps = 8, completedAtMs = at("2026-08-07") + 1)))
        assertEquals(LogReadout.Row(summary, Readout.noRoutine, "Friday · 60 min · 2 working sets", null, false, false),
            LogReadout.weeks(listOf(summary), emptySet(), at("2026-08-09")).single().rows.single())
    }

    @Test
    fun unknownCountsRemainAbsentAndSecondsLongSessionsNeverClaimAMinute() {
        val summary = SessionSummary("s1", at("2026-08-09"), finishedAtMs = at("2026-08-09") + 10_000)
        assertEquals(LogReadout.Row(summary, Readout.noRoutine, "Today · <1 min", null, false, false),
            LogReadout.weeks(listOf(summary), emptySet(), at("2026-08-09")).single().rows.single())
    }

    @Test
    fun openSessionsAreExcludedAndSameTimestampRowsHaveStableIdentityOrder() {
        val sessions = listOf(session("a", "2026-08-07"), SessionSummary(Session("live", at("2026-08-09")), emptyList()),
            session("b", "2026-08-07"))
        assertEquals(listOf("b" to false, "a" to true), LogReadout.weeks(sessions, setOf("a"), at("2026-08-09"))
            .flatMap { it.rows }.map { it.summary.id to it.onThisDeviceOnly })
    }

    @Test
    fun loadedCountsRemainSeparateFromPendingFailedAndHeldEmptyStates() {
        val weeks = LogReadout.weeks(listOf(session("s1", "2026-08-07"), session("s2", "2026-07-30")),
            emptySet(), at("2026-08-09"))
        assertEquals("2 sessions · 2 weeks loaded", LogReadout.head(weeks, false, true))
        assertEquals("1 session · 1 week loaded", LogReadout.head(weeks.take(1), true, true))
        assertNull(LogReadout.head(emptyList(), true, true))
        assertEquals("opening the log…", LogReadout.head(emptyList(), true, false))
        assertNull(LogReadout.head(emptyList(), false, false))
    }
}
