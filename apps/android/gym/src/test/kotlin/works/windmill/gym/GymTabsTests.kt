package works.windmill.gym

import androidx.compose.runtime.saveable.SaverScope
import org.junit.Assert.assertEquals
import org.junit.Test

class GymTabsTests {
    @Test
    fun testATabRoundTripsThroughItsName() {
        val scope = SaverScope { true }
        Tab.entries.forEach { tab ->
            val written = with(tabSaver) { scope.save(tab) }
            assertEquals(tab.name, written)
            assertEquals(tab, tabSaver.restore(written!!))
        }
    }

    @Test
    fun testAStaleSavedTabLandsOnHomeRatherThanCrashing() {
        assertEquals("the retired tab's name lands on home", Tab.Routines, restoredTab("Today"))
        assertEquals("so does any name this build has never heard of", Tab.Routines, restoredTab("Insights"))
        assertEquals(Tab.Routines, restoredTab(""))
        assertEquals("and a value that is not even a String", Tab.Routines, restoredTab(42))
        assertEquals(Tab.Routines, restoredTab(null))
    }

    @Test
    fun testTheRailIsRoutinesTheLogAsk() {
        assertEquals(listOf("Routines", "The log", "Ask"), Tab.entries.map { it.title })
        assertEquals("home is the first seat on the rail", Tab.Routines, Tab.entries.first())
    }
}
