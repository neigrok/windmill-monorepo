package works.windmill.gym.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.store.RefusalFacts
import works.windmill.gym.store.Verdict
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson

// The two seams GymHttp owns beyond the routes: the adapter that strips the platform's exception
// down to the facts the verdicts read, and the Json every body crosses through. VerdictTests proves
// the verdicts from bare facts; this file proves the wire reaches those facts and those verdicts.
class GymHttpTests {
    // The iOS twin's name — there the store maps WindmillApiError.offline/.malformed straight to
    // .retry; here the same rule crosses the RefusalFacts adapter first.
    @Test
    fun testAStorageFailureAndATransportFailureAreBothRetries() {
        assertEquals(RefusalFacts(offline = true), RefusalFacts(WindmillApiException.Offline))
        assertEquals(RefusalFacts(malformed = true), RefusalFacts(WindmillApiException.Malformed))
        assertEquals(Verdict.Retry, Verdict.refusing(RefusalFacts(WindmillApiException.Offline)))
        assertEquals(Verdict.Retry, Verdict.refusing(RefusalFacts(WindmillApiException.Malformed)))
        assertNull(Verdict.refusing(RefusalFacts(WindmillApiException.Offline)).terminalReason(afterRemints = 0))
    }

    // The wire form, through the transport's own Json. WindmillJson does not encode defaulted
    // values, so a default on pattern/equipment would VANISH from the wire and the server would
    // refuse the movement — this pins that both are stated.
    @Test
    fun testAnExerciseWriteStatesPatternAndEquipmentOnTheWire() {
        val encoded = WindmillJson.encodeToString(
            ExerciseWrite.serializer(),
            ExerciseWrite(id = "ex_probe", name = "Nordic Curl", pattern = "isolation", equipment = "barbell"),
        )
        assertEquals(
            """{"id":"ex_probe","name":"Nordic Curl","pattern":"isolation","equipment":"barbell"}""",
            encoded,
        )
    }

    @Test
    fun testAnAdHocStartOmitsTheRoutineRatherThanSendingNull() {
        val encoded = WindmillJson.encodeToString(
            SessionStart.serializer(),
            SessionStart(id = "ses_probe", startedAt = 1_000, routineId = null),
        )
        assertEquals("""{"id":"ses_probe","startedAt":1000}""", encoded)
    }
}
