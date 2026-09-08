package works.windmill.gym.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.McpKey
import works.windmill.gym.domain.OAuthGrant
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

    // The wire's `lastUsedMs` is a last-used and is not read: a row would draw it as a last-read. A
    // blank name and a missing scope both decode, because the server sends both.
    @Test
    fun testAGrantAndAKeyDecodeWithoutTheirLastUsedInstant() {
        assertEquals(
            OAuthGrant(clientId = "c1", name = "Claude Desktop", grantedMs = 1_700L, scope = "gym:read gym:write"),
            WindmillJson.decodeFromString(OAuthGrant.serializer(),
                """{"clientId":"c1","name":"Claude Desktop","grantedMs":1700,"lastUsedMs":1900,"scope":"gym:read gym:write"}"""),
        )
        assertEquals(
            OAuthGrant(clientId = "c2", name = "", grantedMs = 1_700L, scope = ""),
            WindmillJson.decodeFromString(OAuthGrant.serializer(), """{"clientId":"c2","grantedMs":1700}"""),
        )
        assertEquals(
            McpKey(id = "k1", name = "laptop", createdMs = 1_500L),
            WindmillJson.decodeFromString(McpKey.serializer(),
                """{"id":"k1","name":"laptop","createdMs":1500,"lastUsedMs":null}"""),
        )
    }
}
