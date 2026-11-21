package works.windmill.agent.coach

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.Json

class TurnPolicyTests {
    @Test fun staleMeansRunningAndLiveWithAUsableCorrectedServerClock() {
        assertTrue(isStaleTurn("running", 1000, true, 1_801_000))
        assertFalse(isStaleTurn("running", 1000, true, 1_800_999))
        assertFalse(isStaleTurn("running", 1000, false, 1_801_000))
        assertFalse(isStaleTurn("running", null, true, 1_801_000))
        assertFalse(isStaleTurn("running", 1000, true, null))
        assertFalse(isStaleTurn("running", 1000, true, 999))
        EndState.entries.forEach { assertFalse(isStaleTurn(it.name, 1000, true, 1_801_000)) }
    }

    @Test fun invalidProfilesFailBeforeAnEngineCanAdmitThem() {
        val data = Json.parse(File(System.getProperty("windmill.contract"), "agent/turns/text.json").readText()).member("profile")
        for ((name, value) in listOf("version" to Json.of(0), "name" to Json.of("private content"), "model" to Json.of("unknown"), "effort" to Json.of("unknown"), "tools" to Json.array(data.member("tools").arr().first(), data.member("tools").arr().first()))) {
            val invalid = Json.Obj(data.obj().filterKeys { it != name }.toList() + (name to value))
            assertThrows(IllegalArgumentException::class.java) { Profile(invalid) }
        }
    }

    @Test fun accessLabelsExposeNoMoneyPolicy() {
        assertEquals(listOf("allowance", "capacity", "busy", "sign-in", "update", "off", "offline", "did-not-answer"),
            listOf("subject_exhausted", "free_day_exhausted", "busy", "device_bound", "client-update-required", "anonymous_ai_unavailable", null, "provider_failed")
                .map { accessState(AiFailure("transport", it, Admission.none)) })
    }
}
