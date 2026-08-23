package works.windmill.gym.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.store.RefusalFacts
import works.windmill.gym.store.Verdict
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson

class GymHttpTests {
    @Test
    fun testAStorageFailureAndATransportFailureAreBothRetries() {
        assertEquals(RefusalFacts(offline = true), RefusalFacts(WindmillApiException.Offline))
        assertEquals(RefusalFacts(malformed = true), RefusalFacts(WindmillApiException.Malformed))
        assertEquals(Verdict.Retry, Verdict.refusing(RefusalFacts(WindmillApiException.Offline)))
        assertEquals(Verdict.Retry, Verdict.refusing(RefusalFacts(WindmillApiException.Malformed)))
        assertNull(Verdict.refusing(RefusalFacts(WindmillApiException.Offline)).terminalReason(afterRemints = 0))
    }

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

    @Test
    fun testASetFixStatesAllThreeFieldsEvenAtTheValuesADefaultWouldHide() {
        val encoded = WindmillJson.encodeToString(
            SetFix.serializer(),
            SetFix(weightKg = 0.0, reps = 0, kind = SetKind.Warmup),
        )
        assertEquals("""{"weightKg":0.0,"reps":0,"kind":"warmup"}""", encoded)
        assertEquals(
            """{"weightKg":82.5,"reps":5,"kind":"working"}""",
            WindmillJson.encodeToString(SetFix.serializer(),
                SetFix(weightKg = 82.5, reps = 5, kind = SetKind.Working)),
        )
    }
}
