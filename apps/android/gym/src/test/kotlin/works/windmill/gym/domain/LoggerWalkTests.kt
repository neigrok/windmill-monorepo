package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The three collisions 13-gestures names for the logger's walk, decided here rather than inside a
// composable: a nested vertical scroll under the stroke, a full-width tap target under it, and the
// strip at either edge that the system takes for back — where, mid-workout, back already MEANS
// something (stay in the workout) and one stroke may not carry two meanings.
class LoggerWalkTests {
    private val slop = 96f       // 36dp at xhdpi
    private val edge = 64f       // 24dp at xhdpi

    @Test
    fun aStrokeShorterThanTheSlopIsNobodysWalk() {
        assertFalse(LoggerWalk.horizontal(dx = -40f, dy = 0f, slopPx = slop))
        assertTrue(LoggerWalk.horizontal(dx = -96f, dy = 0f, slopPx = slop))
        assertTrue("either direction", LoggerWalk.horizontal(dx = 96f, dy = 0f, slopPx = slop))
    }

    @Test
    fun aThumbSlidingDownTheTodayColumnNeverWalksSideways() {
        assertFalse("far enough sideways, but it is a scroll",
            LoggerWalk.horizontal(dx = -120f, dy = -300f, slopPx = slop))
        assertFalse("a diagonal is not a walk either",
            LoggerWalk.horizontal(dx = -120f, dy = -100f, slopPx = slop))
        assertTrue("clearly sideways, and it is the walk",
            LoggerWalk.horizontal(dx = -220f, dy = -60f, slopPx = slop))
    }

    @Test
    fun aStrokeThatBeginsInTheEdgeStripIsNotTheWalks() {
        assertTrue(LoggerWalk.startsInTheEdge(x = 4f, width = 1080f, edgePx = edge))
        assertTrue(LoggerWalk.startsInTheEdge(x = 1076f, width = 1080f, edgePx = edge))
        assertFalse(LoggerWalk.startsInTheEdge(x = 540f, width = 1080f, edgePx = edge))
        assertFalse("a frame before the first layout has no edges to speak of",
            LoggerWalk.startsInTheEdge(x = 540f, width = 0f, edgePx = edge))
    }

    @Test
    fun leftWalksForwardAndTheEndsOfTheWalkRefuseRatherThanWrap() {
        assertEquals("next", LoggerWalk.to(dx = -200f, previous = "prev", next = "next"))
        assertEquals("prev", LoggerWalk.to(dx = 200f, previous = "prev", next = "next"))
        assertNull("the last movement does not wrap round to the first",
            LoggerWalk.to(dx = -200f, previous = "prev", next = null))
        assertNull(LoggerWalk.to(dx = 200f, previous = null, next = "next"))
    }

    // The walk raises a question in ONE slot, so a second walk while the first is still standing is
    // refused rather than overwriting it — and the refusal is SAID: a stroke that quietly did
    // nothing reads as a broken stroke, so it names the movement whose question is still open.
    @Test
    fun aSecondWalkOverAPendingDeviationIsRefusedInWordsThatNameTheMovement() {
        assertEquals("Back Squat first — that question is still open.",
            LoggerWalk.oneAtATime("Back Squat"))
        assertEquals("Bench Press first — that question is still open.",
            LoggerWalk.oneAtATime("Bench Press"))
    }
}
