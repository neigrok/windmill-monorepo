package works.windmill.gym

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The finish receipt is not among back's meanings: it is a sheet over the workout it closed, so back
// comes to the session underneath like any other pushed screen. `FinishSheetTests` is what pins the
// room actually pushing it.
class GymBackTests {
    @Test
    fun testMidWorkoutBackStaysInTheRoomAndNeverLeavesTheApp() {
        val means = backMeans(live = true, building = false, away = 0, tab = Tab.Routines)
        assertEquals(BackMeans.StayInTheWorkout, means)
        assertTrue("a workout claims back, so the platform never backgrounds the app on it",
                   means != BackMeans.LeaveTheApp)
        assertEquals(
            "the gear pushes settings over the workout, and back pops that one screen",
            BackMeans.PopOnePushedScreen,
            backMeans(live = true, building = false, away = 1, tab = Tab.Log),
        )
    }

    @Test
    fun testBackIsCancelInTheEditorAndPopsOneScreenElsewhere() {
        assertEquals(
            BackMeans.LeaveTheDraft,
            backMeans(live = false, building = true, away = 1, tab = Tab.Routines),
        )
        assertEquals(
            BackMeans.PopOnePushedScreen,
            backMeans(live = false, building = false, away = 1, tab = Tab.Routines),
        )
        assertEquals(
            "one at a time, never the whole stack",
            BackMeans.PopOnePushedScreen,
            backMeans(live = false, building = false, away = 4, tab = Tab.Coach),
        )
    }

    @Test
    fun testATabThatIsNotHomeGoesHomeAndHomeItselfLeavesTheApp() {
        assertEquals(
            BackMeans.ReturnToTheRoutinesTab,
            backMeans(live = false, building = false, away = 0, tab = Tab.Log),
        )
        assertEquals(
            BackMeans.ReturnToTheRoutinesTab,
            backMeans(live = false, building = false, away = 0, tab = Tab.Coach),
        )
        assertEquals(
            "and at the routines home back is the platform's again",
            BackMeans.LeaveTheApp,
            backMeans(live = false, building = false, away = 0, tab = Tab.Routines),
        )
    }

    // The rail is decided by what STANDS, and a receipt stands over a pushed session — so the rail is
    // down while the sheet is up and still down when it comes off, with nothing to flicker back.
    @Test
    fun testTheRailStandsForTheThreeTabsAndForNothingElse() {
        assertTrue(railStands(live = false, building = false, away = 0))
        assertFalse("a workout takes the whole frame",
                    railStands(live = true, building = false, away = 0))
        assertFalse("so does a draft",
                    railStands(live = false, building = true, away = 0))
        assertFalse("and a pushed screen covers the rail too — a finished workout included",
                    railStands(live = false, building = false, away = 1))
    }
}
