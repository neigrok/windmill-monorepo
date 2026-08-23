package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordScreenTests {
    private val gap = BarRow.gap.value
    private val widest = BarRow.widest.value
    private val narrowest = BarRow.narrowest.value

    private val cards = listOf(320f - 64, 360f - 64, 412f - 64)

    private fun layout(width: Float, count: Int) =
        BarRow.layout(width, count, gap = gap, widest = widest, narrowest = narrowest)

    @Test
    fun testEveryBarKeepsAWidthYouCanSeeAtEverySessionCountAWindowCanHold() {
        for (width in cards)
            for (count in 1..120) {
                val slot = layout(width, count)
                assertTrue("$count bars on a ${width}dp card drew nothing", slot.width > 0f)
                if (count > 1)
                    assertTrue("$count bars overlap on a ${width}dp card", slot.pitch >= slot.width)
                val last = slot.first + slot.pitch * (count - 1) + slot.width
                assertTrue("$count bars ran off a ${width}dp card", last <= width + 0.01f)
            }
    }

    @Test
    fun testPastTheCrushTheGapYieldsAndTheBarsStandAtTheirFloor() {
        val width = 360f - 64
        val sixty = layout(width, 60)

        assertEquals("a bar at its floor and not a hairline under it", narrowest, sixty.width, 0.01f)
        assertTrue("the gap gave way rather than the bar", sixty.pitch - sixty.width < gap)
        assertTrue("there is still air between them", sixty.pitch > sixty.width)
    }

    @Test
    fun testAnOrdinaryWindowIsPlainDivisionAtTheFullGap() {
        val width = 360f - 64
        val slot = layout(width, 12)

        assertEquals((width - gap * 11) / 12, slot.width, 0.001f)
        assertEquals(slot.width + gap, slot.pitch, 0.001f)
        assertEquals(0f, slot.first, 0.001f)
    }

    @Test
    fun testASparseWindowIsCappedInWidthAndStillSpansTheCard() {
        val width = 412f - 64
        val slot = layout(width, 3)

        assertEquals(widest, slot.width, 0.001f)
        assertEquals(0f, slot.first, 0.001f)
        assertEquals(width, slot.first + slot.pitch * 2 + slot.width, 0.01f)
    }

    @Test
    fun testOneSessionIsOneCenteredBar() {
        val width = 360f - 64
        val slot = layout(width, 1)

        assertEquals(widest, slot.width, 0.001f)
        assertEquals(0f, slot.pitch, 0.001f)
        assertEquals((width - widest) / 2, slot.first, 0.001f)
    }

    @Test
    fun testAnUnmeasuredCardAndAnEmptySeriesBothCollapseToNothing() {
        assertEquals(BarRow.Slot(0f, 0f, 0f), layout(0f, 12))
        assertEquals(BarRow.Slot(0f, 0f, 0f), layout(296f, 0))
    }
}
