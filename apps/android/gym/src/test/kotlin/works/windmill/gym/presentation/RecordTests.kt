package works.windmill.gym.presentation

import android.content.Context
import androidx.annotation.StringRes
import androidx.test.core.app.ApplicationProvider
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.R
import works.windmill.gym.domain.sync.RecentDay
import works.windmill.platform.i18n.Words

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
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
            val page = Record.page(MovementRead(MovementRecord.of(chin, details, today), StatsProgress.of(details, today).movement(chin.id), today), today)
            assertEquals(Record.Tile(R.string.gym_record_tile_most_reps, "12", Words.Plain("reps · no added load"), false), page.tiles.last().spelled())
            assertEquals("Most reps", string(page.tiles.last().named))
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
        assertEquals(Record.Page("Back Squat", Words.Plain("Barbell"),
            listOf(Record.Tile(R.string.gym_record_tile_best, "116.7", Words.Plain("kg · today"), true), Record.Tile(R.string.gym_record_tile_heaviest, "120", Words.Plain("kg · 12 reps"), false)),
            emptyList(),
            listOf(Record.Day(Words.Plain("today"), "100 × 5 · 120 × 12")), null, null, true), Record.page(MovementRead(record, progress, today), today).spelled())
        assertEquals(listOf("Best e1RM", "Heaviest"), Record.page(MovementRead(record, progress, today), today).tiles.map { string(it.named) })
    }

    // The phone's copy of an account it has not pulled yet is partial: it lists the sets it holds and claims nothing.
    @Test
    fun beforeTheFirstPullThePageListsItsSetsAndLeavesEveryClaimOut() {
        val history = listOf(session("earlier", julyThirteenth, listOf(set("s1", 100.0, 5, julyThirteenth))),
            session("latest", today, listOf(set("s2", 110.0, 5, today))))
        val unread = StatsProgress.of(history, today, complete = false).movement(squat.id)
        assertEquals(2, unread.estimates.size)
        assertEquals(Record.Page("Back Squat", Words.Plain("Barbell"), emptyList(), emptyList(),
            listOf(Record.Day(Words.Plain("today"), "110 × 5"), Record.Day(Words.Plain("13 Jul"), "100 × 5")), null, null, false),
            Record.page(MovementRead(MovementRecord.of(squat, history, today), unread, today), today).spelled())
        assertEquals(Record.Page("Back Squat", Words.Plain("Barbell"), emptyList(), emptyList(), emptyList(), null, null, false),
            Record.page(MovementRead(MovementRecord(squat), StatsProgress.of(emptyList(), today, complete = false).movement(squat.id), today), today).spelled())
        assertEquals(Record.Page("Back Squat", Words.Plain("Barbell"),
            listOf(Record.Tile(R.string.gym_record_tile_best, "128.3", Words.Plain("kg · today"), true), Record.Tile(R.string.gym_record_tile_heaviest, "110", Words.Plain("kg · 5 reps"), false)),
            listOf(Record.Best("100 × 5", Words.Plain("e1RM 116.7"), Words.Plain("13 Jul"))),
            listOf(Record.Day(Words.Plain("today"), "110 × 5"), Record.Day(Words.Plain("13 Jul"), "100 × 5")), null, null, true),
            Record.page(MovementRead(MovementRecord.of(squat, history, today), StatsProgress.of(history, today).movement(squat.id), today), today).spelled())
    }

    @Test
    fun signedFactsAndSuccessfulUntrainedDataNeverBecomeZeroEstimates() {
        val detail = session("assisted", today, listOf(set("assistance", -20.0, 8, today, exerciseId = chin.id)))
        val movement = StatsProgress.of(listOf(detail), today).movement(chin.id)
        val page = Record.page(MovementRead(MovementRecord.of(chin, listOf(detail), today), movement, today), today)
        assertEquals(listOf(Record.Tile(R.string.gym_record_tile_heaviest, "−20", Words.Plain("kg · 8 reps"), false)), page.tiles.map { it.spelled() })
        assertNull(page.noEstimateYet)
        assertNull(page.untrained)
        assertEquals("Nothing logged for this movement yet. The first set you log lands here.",
            Record.page(MovementRead(MovementRecord(chin), StatsProgress.empty(today).movement(chin.id), today), today).untrained.spelled())
    }
    @Test
    fun earlierRecordsUseTheSharedStatedStepsWithoutRepeatingTheStandingBest() {
        val rows = listOf(46.0 to 8, 50.0 to 5, 51.5 to 4, 55.0 to 4).mapIndexed { index, (weight, reps) ->
            val at = today - (3 - index) * 86_400_000L
            session("workout$index", at, listOf(set("set$index", weight, reps, at)))
        }
        val progress = StatsProgress.of(rows, today).movement(squat.id)
        assertEquals(listOf("workout0", "workout2"), progress.earlierRecords.map { it.id })
        val page = Record.page(MovementRead(MovementRecord.of(squat, rows, today), progress, today), today)
        assertEquals(listOf(Record.Best("51.5 × 4", Words.Plain("e1RM 58.4"), Words.Plain("10 Aug")),
            Record.Best("46 × 8", Words.Plain("e1RM 58.3"), Words.Plain("8 Aug"))), page.records.map { it.spelled() })
        assertEquals(Record.Tile(R.string.gym_record_tile_best, "62.3", Words.Plain("kg · today"), true), page.tiles.first().spelled())
        assertEquals(emptyList<Record.Best>(), Record.page(MovementRead(MovementRecord.of(squat, rows.take(2), today), StatsProgress.of(rows.take(2), today).movement(squat.id), today), today).records)
    }

    @Test
    fun aSlightWorkoutsNewBestIsTheLogsAndTheRecordPagesAlike() {
        val week = 7 * 86_400_000L
        val baseline = session("baseline", today - 2 * week, (1..4).map { set("b$it", 100.0, 10, today - 2 * week + it) })
        val slight = session("slight", today - week, listOf(set("s1", 115.0, 8, today - week + 1)))
        val beyond = session("beyond", today, (1..4).map { set("c$it", 120.0, 8, today + it) })
        val rows = listOf(baseline, slight, beyond)
        val progress = StatsProgress.of(rows, today + week)
        val zone = ZoneId.of("UTC")

        assertEquals(listOf("slight", "beyond"), progress.newBests.map { it.sessionId })
        val page = Record.page(MovementRead(MovementRecord.of(squat, rows, today), progress.movement(squat.id), today), today)
        assertEquals(listOf(Record.Best("115 × 8", Words.Plain("e1RM 145.7"), Words.Plain("4 Aug")), Record.Best("100 × 10", Words.Plain("e1RM 133.3"), Words.Plain("28 Jul"))), page.records.map { it.spelled() })
        val timeline = logTimeline(rows.map { SessionSummary(it.session, it.sets, listOf(squat)) }, progress, emptyList(), today + week, zone)
        assertTrue("the log states it once, by its woven moment", timeline.any { it is LogEntry.Moment.Best && it.best.sessionId == "slight" })
        assertTrue("and by its dot wherever no moment states it",
            LogReadout.row(SessionSummary(slight.session, slight.sets, listOf(squat)), progress, today + week, zone).record)
    }

}

private fun Words?.spelled(): String? = this?.text(ApplicationProvider.getApplicationContext())

private fun Words.plain(): Words = Words.Plain(text(ApplicationProvider.getApplicationContext()))

private fun Record.Tile.spelled() = copy(said = said.plain())

private fun Record.Best.spelled() = copy(estimated = estimated.plain(), on = on.plain())

private fun Record.Page.spelled() = copy(equipment = equipment.plain(), tiles = tiles.map { it.spelled() }, records = records.map { it.spelled() },
    days = days.map { it.copy(on = it.on.plain()) }, untrained = untrained?.plain(), noEstimateYet = noEstimateYet?.plain())

private fun string(@StringRes id: Int, vararg args: Any): String = ApplicationProvider.getApplicationContext<Context>().getString(id, *args)
