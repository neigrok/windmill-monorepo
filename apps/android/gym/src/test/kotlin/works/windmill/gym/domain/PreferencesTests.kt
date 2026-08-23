package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.platform.net.WindmillJson

class PreferencesTests {
    private fun encoded(document: GymPreferences) =
        WindmillJson.encodeToString(GymPreferences.serializer(), document)

    private fun decoded(json: String) =
        WindmillJson.decodeFromString(GymPreferences.serializer(), json)

    @Test
    fun testADocumentAtItsDefaultsTravelsAsAnEmptyObject() {
        assertEquals("{}", encoded(GymPreferences()))
        assertEquals(GymPreferences(), decoded("{}"))
    }

    @Test
    fun testRestOffIsAnAbsentKeyInBothDirections() {
        assertEquals("{}", encoded(GymPreferences(restSeconds = null)))
        assertEquals("""{"restSeconds":120}""", encoded(GymPreferences(restSeconds = 120)))
        assertNull(decoded("""{"restSound":true}""").restSeconds)
        assertEquals(180, decoded("""{"restSeconds":180}""").restSeconds)
    }

    @Test
    fun testTheUnitIsAWordAndAnUnknownOneReadsAsKilograms() {
        assertEquals("""{"units":"lb"}""", encoded(GymPreferences(units = Units.Pounds)))
        assertEquals(Units.Pounds, decoded("""{"units":"lb"}""").units)
        assertEquals(Units.Kilograms, decoded("""{"units":"stone"}""").units)
    }

    @Test
    fun testTheRestBandIsClampedAndOffSurvives() {
        assertEquals(GymPreferences.maxRestSeconds,
                     GymPreferences(restSeconds = 4_000).normalized().restSeconds)
        assertEquals(GymPreferences.minRestSeconds,
                     GymPreferences(restSeconds = 5).normalized().restSeconds)
        assertNull("off survives normalizing — it is not a value to clamp",
                   GymPreferences(restSeconds = null).normalized().restSeconds)
    }

    @Test
    fun testNothingAboutEquipmentTravelsInEitherDirection() {
        assertEquals("""{"units":"lb"}""", encoded(GymPreferences(units = Units.Pounds)))
        val older = decoded("""{"units":"lb","barWeightKg":15,"platesKg":[25,20]}""")
        assertEquals(GymPreferences(units = Units.Pounds), older)
    }
}
