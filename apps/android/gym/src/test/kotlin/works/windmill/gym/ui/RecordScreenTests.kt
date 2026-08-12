package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// WHERE THE BARS STAND, with no canvas around it. One bar per session in twelve weeks is a count
// the log sets and nothing caps — five sessions a week is sixty of them — so the layout is the one
// piece of this page that can fail by drawing NOTHING at all: a card with its title, its window and
// its dates, and an empty band where the training was.
//
// Widths are the real ones: a card on a 320, 360 or 412dp phone, less the room's body padding and
// the card's own. Density is 1 here, so a dp is a px and the numbers below are the numbers on the
// glass.

class RecordScreenTests {
    private val gap = BarRow.gap.value
    private val widest = BarRow.widest.value
    private val narrowest = BarRow.narrowest.value

    private val cards = listOf(320f - 64, 360f - 64, 412f - 64)

    private fun layout(width: Float, count: Int) =
        BarRow.layout(width, count, gap = gap, widest = widest, narrowest = narrowest)

    // The regression this rule exists for: at 48 sessions a 6dp gap eats a 296dp card whole, and the
    // arithmetic that used to run went to zero and then NEGATIVE — an inverted rect draws nothing,
    // so the chart went blank exactly for the lifter with the most sessions in it.
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

    // THE GAP GIVES WAY BEFORE THE BAR DOES. A separation that costs the thing it separates has
    // stopped being one, so past the point where 6dp of air would crush the bars, the air yields
    // until the bars stand at their floor and no further.
    @Test
    fun testPastTheCrushTheGapYieldsAndTheBarsStandAtTheirFloor() {
        val width = 360f - 64
        val sixty = layout(width, 60)

        assertEquals("a bar at its floor and not a hairline under it", narrowest, sixty.width, 0.01f)
        assertTrue("the gap gave way rather than the bar", sixty.pitch - sixty.width < gap)
        assertTrue("there is still air between them", sixty.pitch > sixty.width)
    }

    // Between the two ends the rule is plain division: the gap is exactly 6dp and the pitch is
    // exactly slot + gap, laid out as if neither the cap nor the floor were there.
    @Test
    fun testAnOrdinaryWindowIsPlainDivisionAtTheFullGap() {
        val width = 360f - 64
        val slot = layout(width, 12)

        assertEquals((width - gap * 11) / 12, slot.width, 0.001f)
        assertEquals(slot.width + gap, slot.pitch, 0.001f)
        assertEquals(0f, slot.first, 0.001f)
    }

    // Three sessions divided across a card are three walls rather than three bars, and the shape of
    // a chart is what a chart is for — so a bar has a width it may not exceed, and a sparse window
    // is still read edge to edge under the dates that name its ends.
    @Test
    fun testASparseWindowIsCappedInWidthAndStillSpansTheCard() {
        val width = 412f - 64
        val slot = layout(width, 3)

        assertEquals(widest, slot.width, 0.001f)
        assertEquals(0f, slot.first, 0.001f)
        assertEquals(width, slot.first + slot.pitch * 2 + slot.width, 0.01f)
    }

    // One session is one bar, and it stands in the middle of the card under the one date the axis
    // has — spreading a lone bar across a card would draw a wall nobody lifted.
    @Test
    fun testOneSessionIsOneCenteredBar() {
        val width = 360f - 64
        val slot = layout(width, 1)

        assertEquals(widest, slot.width, 0.001f)
        assertEquals(0f, slot.pitch, 0.001f)
        assertEquals((width - widest) / 2, slot.first, 0.001f)
    }

    // A card that has not been measured yet, and a series with nothing in it: both draw nothing and
    // neither divides by a zero on the way there.
    @Test
    fun testAnUnmeasuredCardAndAnEmptySeriesBothCollapseToNothing() {
        assertEquals(BarRow.Slot(0f, 0f, 0f), layout(0f, 12))
        assertEquals(BarRow.Slot(0f, 0f, 0f), layout(296f, 0))
    }
}
