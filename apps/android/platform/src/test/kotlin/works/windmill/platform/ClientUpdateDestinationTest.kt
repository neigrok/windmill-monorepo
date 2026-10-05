package works.windmill.platform

import org.junit.Assert.*
import org.junit.Test
import works.windmill.platform.telemetry.Telemetry

class ClientUpdateDestinationTest {
    @Test fun unavailableBrowserGivesAnInlineReasonAndBoundedTelemetryWithoutTheUrlOrException() {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { fail("No raw URI exception should be reported") }
        }
        val reason = ClientUpdateDestination("https://windmill.works/private/path").open({
            throw IllegalArgumentException("private URI contents")
        }, telemetry)
        assertEquals("The link could not be opened. Try again, or open Windmill’s website in your browser.", reason)
        assertEquals(listOf("client_update_required" to mapOf("action" to "update"),
            "client_update_required" to mapOf("action" to "update", "outcome" to "failed")), events)
    }

    @Test fun successfulOpenPassesTheConfiguredDestinationAndClearsAnEarlierInlineReason() {
        val opened = mutableListOf<String>()
        val destination = ClientUpdateDestination("https://windmill.works/android.apk", "Get the update")
        assertNull(destination.open(opened::add, Telemetry.None))
        assertEquals(listOf(destination.url), opened)
    }
}
