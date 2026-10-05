package works.windmill.sync.testing

import org.junit.Assert.*
import org.junit.Test

class ReplayFuzzTests {
    @Test fun networkAndLifecycleReplay() {
        val producing = linkedMapOf<String, Int>(); var entries = 0
        for (seed in 1L..128L) {
            val report = ReplayFuzz.run(CorpusTests.probe, seed, 128)
            for ((event, count) in report.events) if (count > 0) producing[event] = (producing[event] ?: 0) + 1
            entries += report.entriesChecked
            if (seed % 32 == 0L) println("network replay progress: $seed/128 seeds × 128 steps")
        }
        assertEquals("coverage floor 128 seeds × 128 steps", emptyList<String>(), ReplayFuzz.coverage.filter { producing[it] == null })
        println("network and lifecycle replay fuzz: 128 seeds × 128 steps, $entries entries checked; seeds producing=$producing")
    }
    @Test fun coverageFloorSurveyAcrossThirtyStartingSeeds() {
        val totals = ReplayFuzz.coverage.associateWith { 0 }.toMutableMap()
        repeat(30) { survey ->
            val first = 1 + survey * 1000L
            val producing = ReplayFuzz.coverage.associateWith { 0 }.toMutableMap()
            for (seed in first until first + ReplayFuzz.COVERAGE_SEEDS) {
                val report = ReplayFuzz.run(CorpusTests.probe, seed, ReplayFuzz.COVERAGE_STEPS)
                for (event in ReplayFuzz.coverage) if ((report.events[event] ?: 0) > 0) producing[event] = producing.getValue(event) + 1
            }
            assertTrue("first seed=$first missing=${producing.filterValues { it == 0 }}", producing.values.all { it > 0 })
            for (event in ReplayFuzz.coverage) totals[event] = totals.getValue(event) + producing.getValue(event)
            if ((survey + 1) % 5 == 0) println("network coverage survey progress: ${survey + 1}/30 starts × ${ReplayFuzz.COVERAGE_SEEDS} seeds × ${ReplayFuzz.COVERAGE_STEPS} steps")
        }
        val mean = totals.mapValues { it.value / 30.0 }
        assertTrue("coverage survey mean=$mean", mean.values.all { it >= 10 })
        println("replay coverage survey: 30 fuzzes × ${ReplayFuzz.COVERAGE_SEEDS} seeds × ${ReplayFuzz.COVERAGE_STEPS} steps, first seeds 1,1001,…,29001; no misses; mean producing=$mean")
    }
    @Test fun seedReplaysByteForByte() {
        for (seed in listOf(7L, 53L, 76L, 95L, 1037L)) {
            val a = ReplayFuzz.run(CorpusTests.probe, seed, 128); val b = ReplayFuzz.run(CorpusTests.probe, seed, 128)
            assertEquals(a, b)
        }
    }
}
