package works.windmill.gym.domain

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// What the statistics screen is allowed to draw, and what it must refuse to invent. Two halves: the
// wire shape exactly as `adapters/json/TrainingJson` writes it — every optional OMITTED and never
// null — and the one rule that turns it into marks on a phone with no scrub and no hover.
//
// A DATE IN AN EXPECTED STRING IS SPELLED BY `Readout` ITSELF wherever the product spells it in the
// reader's own zone, so these assertions pin the SENTENCE and not this machine's calendar. The one
// exception is the weeks span: those instants are UTC Monday buckets and are rendered in UTC on
// purpose, so their days are the same everywhere and are written out.

class StatisticsTests {
    private val json = Json { ignoreUnknownKeys = true }

    private fun decoded(text: String): TrainingStatistics =
        json.decodeFromString(TrainingStatistics.serializer(), text)

    private val catalog = listOf(Exercise(id = "bench-press", name = "Bench press"),
                                 Exercise(id = "chin-up", name = "Chin-up"))

    // The reply as the server writes it, with the absences that mean something: a point with no
    // `e1rm` is a load Epley is undefined at, and a movement with no `bestE1rm` has never had one.
    @Test
    fun testTheWireShapeDecodesWithEveryAbsenceIntact() {
        val statistics = decoded("""
        {"weeks":[{"startedAt":1754006400000,"sessions":3,"workingSets":34}],
         "movements":[
           {"exerciseId":"bench-press","lastTrainedAt":1754400000000,
            "points":[{"at":1754006400000,"weightKg":82.5,"reps":5,"e1rm":96.3}],
            "bestE1rm":{"weightKg":82.5,"reps":5,"at":1754006400000,"e1rm":96.3},
            "heaviest":{"weightKg":90,"reps":3,"at":1754400000000,"e1rm":99}},
           {"exerciseId":"chin-up","lastTrainedAt":1754400000000,
            "points":[{"at":1754400000000,"weightKg":0,"reps":12}]}]}
        """)

        assertEquals(listOf(StatWeek(startedAtMs = 1_754_006_400_000, sessions = 3, workingSets = 34)),
                     statistics.weeks)
        assertEquals(2, statistics.movements.size)
        assertEquals(StatMovement(exerciseId = "bench-press",
                                  lastTrainedAtMs = 1_754_400_000_000,
                                  points = listOf(StatPoint(atMs = 1_754_006_400_000,
                                                            weightKg = 82.5, reps = 5, e1rm = 96.3)),
                                  bestE1rm = StatPoint(atMs = 1_754_006_400_000,
                                                       weightKg = 82.5, reps = 5, e1rm = 96.3),
                                  heaviest = StatPoint(atMs = 1_754_400_000_000,
                                                       weightKg = 90.0, reps = 3, e1rm = 99.0)),
                     statistics.movements[0])
        assertEquals(StatMovement(exerciseId = "chin-up",
                                  lastTrainedAtMs = 1_754_400_000_000,
                                  points = listOf(StatPoint(atMs = 1_754_400_000_000,
                                                            weightKg = 0.0, reps = 12))),
                     statistics.movements[1])
    }

    // An account with nothing finished answers with the two empty lists, and that is a fact rather
    // than a fault — the board says so instead of drawing an axis over nothing.
    @Test
    fun testAnEmptyLogIsAnEmptyBoardAndNotAFailure() {
        val statistics = decoded("""{"weeks":[],"movements":[]}""")
        val board = Stats.board(statistics, catalog = catalog, now = 1_754_400_000_000)

        assertNull(board.weeks)
        assertEquals(emptyList<Stats.Line>(), board.lines)
        assertTrue(board.isEmpty)
    }

    // Each row is measured against ITS OWN peak. Sessions and working sets count different things,
    // and one axis across both is the chart that made Lift's progress tab unreadable — three
    // sessions beside thirty-four sets would flatten the smaller row into the baseline.
    @Test
    fun testEachWeeklySeriesIsNormalisedToItsOwnPeak() {
        val weeks = Stats.weeks(listOf(StatWeek(startedAtMs = 1_753_660_800_000, sessions = 1, workingSets = 10),
                                       StatWeek(startedAtMs = 1_754_265_600_000, sessions = 4, workingSets = 40),
                                       StatWeek(startedAtMs = 1_754_870_400_000, sessions = 2, workingSets = 20)),
                                showing = 12)

        assertEquals("Working sets", weeks?.sets?.label)
        assertEquals("peak 40", weeks?.sets?.peak)
        assertEquals(listOf(0.25, 1.0, 0.5), weeks?.sets?.heights)
        assertEquals("Sessions", weeks?.sessions?.label)
        assertEquals("peak 4", weeks?.sessions?.peak)
        assertEquals(listOf(0.25, 1.0, 0.5), weeks?.sessions?.heights)
    }

    // The window is taken off the END — the recent weeks are the ones a lifter is asking about — and
    // the span prints the two dates it landed on rather than claiming a period. Weeks are UTC Monday
    // buckets, so the label is rendered in UTC: in a negative-offset zone the local rendering would
    // name Sunday, which is a week label that is simply wrong.
    @Test
    fun testTheWindowTakesTheMostRecentWeeksAndTheSpanNamesItsOwnEnds() {
        // Twenty weeks from Mon 6 Jan 2025 UTC. The window keeps the last twelve, which start at
        // week 8 (Mon 3 Mar) and end at week 19 (Mon 19 May).
        val series = (0 until 20).map {
            StatWeek(startedAtMs = 1_736_121_600_000 + it * 604_800_000L,
                     sessions = 1, workingSets = 10)
        }
        val weeks = Stats.weeks(series, showing = 12)

        assertEquals(12, weeks?.sets?.heights?.size)
        assertEquals("12 weeks · Mon 3 Mar → Mon 19 May", weeks?.span)
    }

    @Test
    fun testOneWeekSaysOneWeekAndNamesOnlyTheDayItHas() {
        val weeks = Stats.weeks(listOf(StatWeek(startedAtMs = 1_754_265_600_000, sessions = 2, workingSets = 0)),
                                showing = 12)

        assertEquals("1 week · Mon 4 Aug", weeks?.span)
        assertEquals("a week of warmups is a real zero, not a missing bar", "peak 0", weeks?.sets?.peak)
        assertEquals("nothing divides by a peak of nothing", listOf(0.0), weeks?.sets?.heights)
    }

    // A movement every one of whose sets carries an estimate draws the estimate. The line is
    // normalised to its OWN min and max, because a progression from 82.5 to 96.3 against a zero
    // baseline is a flat line and the shape is the whole content of a sparkline.
    @Test
    fun testALoadedMovementDrawsItsE1rmLineNormalisedToItsOwnRange() {
        val line = Stats.line(
            StatMovement(exerciseId = "bench-press", lastTrainedAtMs = 1_754_400_000_000,
                         points = listOf(StatPoint(atMs = 1, weightKg = 80.0, reps = 5, e1rm = 90.0),
                                         StatPoint(atMs = 2, weightKg = 82.5, reps = 5, e1rm = 95.0),
                                         StatPoint(atMs = 3, weightKg = 85.0, reps = 5, e1rm = 100.0))),
            catalog = catalog, now = 1_754_400_000_000)

        assertEquals("Bench press", line?.movement)
        assertEquals("e1RM", line?.unit)
        assertEquals("the newest point is the number a lifter is looking for", "100", line?.value)
        assertEquals(listOf(0.0, 0.5, 1.0), line?.heights)
        assertEquals("3 sessions · 90 → 100", line?.span)
        assertEquals("trained today", line?.lastTrained)
    }

    // One set Epley cannot speak for — a chin-up at zero, a band-assisted pull-up below it — and the
    // whole line switches to LOADS. That is not a fallback, it is the true story for the lifter who
    // went from assisted to bodyweight to weighted, and an estimate line with a hole in it is not.
    @Test
    fun testAMovementWithAnyUnestimatedSetDrawsItsLoadLineInstead() {
        val line = Stats.line(
            StatMovement(exerciseId = "chin-up", lastTrainedAtMs = 1_754_400_000_000,
                         points = listOf(StatPoint(atMs = 1, weightKg = -20.0, reps = 8),
                                         StatPoint(atMs = 2, weightKg = 0.0, reps = 8),
                                         StatPoint(atMs = 3, weightKg = 5.0, reps = 8, e1rm = 6.3))),
            catalog = catalog, now = 1_754_400_000_000)

        assertEquals("load", line?.unit)
        assertEquals("5", line?.value)
        assertEquals(listOf(0.0, 0.8, 1.0), line?.heights)
        assertEquals("a negative load is a point on the number line and prints as one",
                     "3 sessions · −20 → 5", line?.span)
    }

    // THE THIRD AXIS, and it is the one a chin-up needs. Epley has no answer at zero so the estimate
    // is gone, and the load never moves so the load is not the story either — the reps are. The iOS
    // phone had two branches where stats.js `axisOf` has three, so a lifter who went 8 → 12 read
    // "0 → 0" there off the same stored bytes the desk read 8 → 12 off.
    @Test
    fun testABodyweightMovementDrawsItsRepsWhenTheLoadNeverMoves() {
        val line = Stats.line(
            StatMovement(exerciseId = "chin-up", lastTrainedAtMs = 1_754_400_000_000,
                         points = listOf(StatPoint(atMs = 1, weightKg = 0.0, reps = 8),
                                         StatPoint(atMs = 2, weightKg = 0.0, reps = 10),
                                         StatPoint(atMs = 3, weightKg = 0.0, reps = 12))),
            catalog = catalog, now = 1_754_400_000_000)

        assertEquals("reps", line?.unit)
        assertEquals("12", line?.value)
        assertEquals(listOf(0.0, 0.5, 1.0), line?.heights)
        assertEquals("3 sessions · 8 → 12", line?.span)
    }

    // The ORDER of the three tests is the rule: an estimate on every point wins over a load that
    // moves, and a load that moves wins over the reps. A lifter coming off the band is drawn on the
    // LOAD even though the reps moved too, because that crossing is the story.
    @Test
    fun testTheAxisIsChosenInTheOrderTheWebChoosesIt() {
        assertEquals(Stats.Axis.E1rm,
                     Stats.Axis.of(listOf(StatPoint(atMs = 1, weightKg = 100.0, reps = 5, e1rm = 116.7),
                                          StatPoint(atMs = 2, weightKg = 105.0, reps = 5, e1rm = 122.5))))
        assertEquals(Stats.Axis.Load,
                     Stats.Axis.of(listOf(StatPoint(atMs = 1, weightKg = -20.0, reps = 8),
                                          StatPoint(atMs = 2, weightKg = 0.0, reps = 6))))
        assertEquals(Stats.Axis.Reps,
                     Stats.Axis.of(listOf(StatPoint(atMs = 1, weightKg = 0.0, reps = 8),
                                          StatPoint(atMs = 2, weightKg = 0.0, reps = 11))))
    }

    // A movement that has never moved is honestly flat, drawn down the middle — pinning it to an
    // edge would be a divide by nothing dressed up as a trend.
    @Test
    fun testAMovementThatNeverMovedIsFlatDownTheMiddle() {
        val line = Stats.line(
            StatMovement(exerciseId = "bench-press", lastTrainedAtMs = 1_754_313_600_000,
                         points = listOf(StatPoint(atMs = 1, weightKg = 60.0, reps = 5, e1rm = 70.0),
                                         StatPoint(atMs = 2, weightKg = 60.0, reps = 5, e1rm = 70.0))),
            catalog = catalog, now = 1_754_400_000_000)

        assertEquals(listOf(0.5, 0.5), line?.heights)
        assertEquals("2 sessions · 70 → 70", line?.span)
        assertEquals("trained yesterday", line?.lastTrained)
    }

    @Test
    fun testOneSessionIsOneDotAndSaysSoRatherThanDrawingADirection() {
        val line = Stats.line(
            StatMovement(exerciseId = "bench-press", lastTrainedAtMs = 1_754_400_000_000,
                         points = listOf(StatPoint(atMs = 1, weightKg = 60.0, reps = 5, e1rm = 70.0))),
            catalog = catalog, now = 1_754_400_000_000)

        assertEquals(listOf(0.5), line?.heights)
        assertEquals("1 session · 70", line?.span)
    }

    // The server builds a movement out of its points, so one with none cannot arrive — and if one
    // ever did, a name over an empty frame is not what this screen would draw.
    @Test
    fun testAMovementWithNoPointsIsLeftOutEntirely() {
        assertNull(Stats.line(StatMovement(exerciseId = "bench-press", lastTrainedAtMs = 0),
                              catalog = catalog, now = 1_754_400_000_000))
    }

    // A lifter adding 2.5 kg a week tops their estimate and their load on the SAME set every time,
    // so the common case is one line and not two printing one day twice.
    @Test
    fun testOneSetHoldingBothMarksIsOneLine() {
        val line = Stats.line(
            StatMovement(exerciseId = "bench-press", lastTrainedAtMs = 1_754_400_000_000,
                         points = listOf(StatPoint(atMs = 1, weightKg = 90.0, reps = 3, e1rm = 99.0)),
                         bestE1rm = StatPoint(atMs = 1_754_400_000_000, weightKg = 90.0, reps = 3, e1rm = 99.0),
                         heaviest = StatPoint(atMs = 1_754_400_000_000, weightKg = 90.0, reps = 3, e1rm = 99.0)),
            catalog = catalog, now = 1_754_400_000_000)

        assertEquals(listOf("best 90 × 3 · e1RM 99 kg · ${Readout.day(1_754_400_000_000)}"), line?.bests)
    }

    @Test
    fun testTwoDifferentSetsHoldingTheTwoMarksAreTwoLines() {
        val line = Stats.line(
            StatMovement(exerciseId = "bench-press", lastTrainedAtMs = 1_754_400_000_000,
                         points = listOf(StatPoint(atMs = 1, weightKg = 82.5, reps = 6, e1rm = 99.0)),
                         bestE1rm = StatPoint(atMs = 1_754_400_000_000, weightKg = 82.5, reps = 6, e1rm = 99.0),
                         heaviest = StatPoint(atMs = 1_754_313_600_000, weightKg = 90.0, reps = 1, e1rm = 93.0)),
            catalog = catalog, now = 1_754_400_000_000)

        assertEquals(listOf("best e1RM 99 kg · 82.5 × 6 · ${Readout.day(1_754_400_000_000)}",
                            "heaviest 90 × 1 · ${Readout.day(1_754_313_600_000)}"),
                     line?.bests)
    }

    // Zero is not a load, it is the absence of one — the finish screen's own rule, applied to a
    // standing best. "heaviest 0 × 12" is a sentence about a weight nobody lifted.
    @Test
    fun testABodyweightBestIsSpelledAsRepsAndNeverAsAZeroLoad() {
        val line = Stats.line(
            StatMovement(exerciseId = "chin-up", lastTrainedAtMs = 1_754_400_000_000,
                         points = listOf(StatPoint(atMs = 1, weightKg = 0.0, reps = 12)),
                         heaviest = StatPoint(atMs = 1_754_400_000_000, weightKg = 0.0, reps = 12)),
            catalog = catalog, now = 1_754_400_000_000)

        assertEquals(listOf("heaviest 12 reps · ${Readout.day(1_754_400_000_000)}"), line?.bests)
    }

    // The board is the whole screen, decided once and outside a composable body: the weeks window
    // and one line per movement, in the order the server sorted them (most recently trained first).
    @Test
    fun testTheBoardIsTheWholeScreenDecidedInOnePass() {
        val statistics = TrainingStatistics(
            weeks = listOf(StatWeek(startedAtMs = 1_754_006_400_000, sessions = 2, workingSets = 20)),
            movements = listOf(StatMovement(exerciseId = "chin-up", lastTrainedAtMs = 1_754_400_000_000,
                                            points = listOf(StatPoint(atMs = 1, weightKg = 0.0, reps = 12))),
                               StatMovement(exerciseId = "bench-press", lastTrainedAtMs = 1_754_313_600_000,
                                            points = listOf(StatPoint(atMs = 1, weightKg = 80.0, reps = 5, e1rm = 93.3)))))
        val board = Stats.board(statistics, catalog = catalog, now = 1_754_400_000_000)

        assertFalse(board.isEmpty)
        assertEquals(listOf(1.0), board.weeks?.sets?.heights)
        assertEquals(listOf("Chin-up", "Bench press"), board.lines.map { it.movement })
        assertEquals("a chin-up at one fixed load is drawn on its reps, never on a constant zero",
                     listOf("reps", "e1RM"), board.lines.map { it.unit })
    }
}
