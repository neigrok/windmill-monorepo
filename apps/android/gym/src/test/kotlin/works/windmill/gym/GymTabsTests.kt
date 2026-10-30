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
        assertEquals("and so does the room's old name", Tab.Routines, restoredTab("Ask"))
        assertEquals("so does any name this build has never heard of", Tab.Routines, restoredTab("Insights"))
        assertEquals(Tab.Routines, restoredTab(""))
        assertEquals("and a value that is not even a String", Tab.Routines, restoredTab(42))
        assertEquals(Tab.Routines, restoredTab(null))
    }

    @Test
    fun testTheRailIsRoutinesTheLogCoach() {
        assertEquals(listOf("Routines", "The log", "Coach"), Tab.entries.map { it.title })
        assertEquals("home is the first seat on the rail", Tab.Routines, Tab.entries.first())
    }
    @Test fun retiredSettingsIsRemovedWithoutLosingOtherRoutes() {
        val raw = """[{"type":"works.windmill.gym.Away.Notes"},{"type":"works.windmill.gym.Away.Settings"},{"type":"works.windmill.gym.Away.Connections"}]"""
        assertEquals(listOf(Away.Notes, Away.Connections), awaySaver(works.windmill.platform.telemetry.Telemetry.None).restore(raw))
    }

    @Test fun unknownOrMalformedRoutesStillReportOneStaticRestoreFailure() {
        val failures = mutableListOf<String>()
        val telemetry = object : works.windmill.platform.telemetry.Telemetry {
            override fun event(name: String, properties: Map<String, String>) = Unit
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        for (raw in listOf("""[{"type":"unknown"}]""", "null", "not json")) {
            assertEquals(emptyList<Away>(), awaySaver(telemetry).restore(raw))
        }
        assertEquals(List(3) { "gym.restoreNavigation" }, failures)
    }

}
