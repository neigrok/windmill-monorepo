package works.windmill.sync.engine

import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.ScopeRef

class WriterSlicesTests {
    @Test fun measuredStepsRemainIndependentAndStartAtSwiftDefaults() {
        val slices = WriterSlices()
        val first = ScopeRef.product("gym")
        val second = ScopeRef.product("journal")
        assertEquals(64, slices.chunkRows(first)); assertEquals(32, slices.settleEntries); assertEquals(16, slices.resultsPerBatch)
        slices.recordChunk(first, 64, WriterSlices.aimNanos * 4)
        assertEquals(16, slices.chunkRows(first)); assertEquals(64, slices.chunkRows(second))
        slices.recordSettle(32, 0); slices.recordResults(16, WriterSlices.aimNanos * 8)
        assertEquals(64, slices.settleEntries); assertEquals(2, slices.resultsPerBatch)
    }
    @Test fun emptyStepsGiveNoRateAndUnmeasurablyFastStepsDoubleToCeiling() {
        assertEquals(64, WriterSlices.next(64, 0, 0))
        assertEquals(128, WriterSlices.next(64, 1, 0))
        assertEquals(4_096, WriterSlices.next(4_096, 4_096, 0))
    }
    @Test fun slowStepsShrinkAtLeastToOneAndShortPagesNeverShrinkWithinAim() {
        assertEquals(1, WriterSlices.next(64, 64, WriterSlices.aimNanos * 1_000))
        assertEquals(16, WriterSlices.next(64, 64, WriterSlices.aimNanos * 4))
        assertEquals(64, WriterSlices.next(64, 1, WriterSlices.aimNanos))
        assertEquals(128, WriterSlices.next(64, 64, WriterSlices.aimNanos / 4))
        assertThrows(IllegalArgumentException::class.java) { WriterSlices.next(0, 1, 1) }
    }
}
