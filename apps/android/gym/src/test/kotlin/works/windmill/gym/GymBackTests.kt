package works.windmill.gym

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GymBackTests {
    @Test
    fun testTheFinishScreenClaimsBackAndDoesNothingWithIt() {
        assertEquals(
            BackMeans.Nothing,
            backMeans(finished = true, live = false, building = false, away = 0, tab = Tab.Routines),
        )
        assertEquals(
            "and it outranks everything under it",
            BackMeans.Nothing,
            backMeans(finished = true, live = true, building = true, away = 3, tab = Tab.Coach),
        )
    }

    @Test
    fun testMidWorkoutBackStaysInTheRoomAndNeverLeavesTheApp() {
        val means = backMeans(finished = false, live = true, building = false, away = 0, tab = Tab.Routines)
        assertEquals(BackMeans.StayInTheWorkout, means)
        assertTrue("a workout claims back, so the platform never backgrounds the app on it",
                   means != BackMeans.LeaveTheApp)
        assertEquals(
            "a pushed screen underneath does not change it: the logger is what stands",
            BackMeans.StayInTheWorkout,
            backMeans(finished = false, live = true, building = false, away = 2, tab = Tab.Log),
        )
    }

    @Test
    fun testBackIsCancelInTheEditorAndPopsOneScreenElsewhere() {
        assertEquals(
            BackMeans.LeaveTheDraft,
            backMeans(finished = false, live = false, building = true, away = 1, tab = Tab.Routines),
        )
        assertEquals(
            BackMeans.PopOnePushedScreen,
            backMeans(finished = false, live = false, building = false, away = 1, tab = Tab.Routines),
        )
        assertEquals(
            "one at a time, never the whole stack",
            BackMeans.PopOnePushedScreen,
            backMeans(finished = false, live = false, building = false, away = 4, tab = Tab.Coach),
        )
    }

    @Test
    fun testATabThatIsNotHomeGoesHomeAndHomeItselfLeavesTheApp() {
        assertEquals(
            BackMeans.ReturnToTheRoutinesTab,
            backMeans(finished = false, live = false, building = false, away = 0, tab = Tab.Log),
        )
        assertEquals(
            BackMeans.ReturnToTheRoutinesTab,
            backMeans(finished = false, live = false, building = false, away = 0, tab = Tab.Coach),
        )
        assertEquals(
            "and at the routines home back is the platform's again",
            BackMeans.LeaveTheApp,
            backMeans(finished = false, live = false, building = false, away = 0, tab = Tab.Routines),
        )
    }

    @Test
    fun testTheRailStandsForTheThreeTabsAndForNothingElse() {
        assertTrue(railStands(finished = false, live = false, building = false, away = 0))
        assertFalse("a finished session takes the whole frame",
                    railStands(finished = true, live = false, building = false, away = 0))
        assertFalse("so does a workout",
                    railStands(finished = false, live = true, building = false, away = 0))
        assertFalse("so does a draft",
                    railStands(finished = false, live = false, building = true, away = 0))
        assertFalse("and a pushed screen covers the rail too",
                    railStands(finished = false, live = false, building = false, away = 1))
    }
}
