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
    fun testTheWebsRestDialPassesThroughUntouched() {
        assertEquals("{}", encoded(GymPreferences(restSeconds = null)))
        assertEquals("""{"restSeconds":120}""", encoded(GymPreferences(restSeconds = 120)))
        assertNull(decoded("""{"restSound":true}""").restSeconds)
        assertEquals(180, decoded("""{"restSeconds":180}""").restSeconds)
        assertEquals(4_000, decoded("""{"restSeconds":4000}""").restSeconds)
        assertEquals("""{"restSeconds":5,"restSound":false}""",
                     encoded(GymPreferences(restSeconds = 5, restSound = false)))
    }

    @Test
    fun testTheUnitIsAWordAndAnUnknownOneReadsAsKilograms() {
        assertEquals("""{"units":"lb"}""", encoded(GymPreferences(units = Units.Pounds)))
        assertEquals(Units.Pounds, decoded("""{"units":"lb"}""").units)
        assertEquals(Units.Kilograms, decoded("""{"units":"stone"}""").units)
    }

    @Test
    fun testNothingAboutEquipmentTravelsInEitherDirection() {
        assertEquals("""{"units":"lb"}""", encoded(GymPreferences(units = Units.Pounds)))
        val older = decoded("""{"units":"lb","barWeightKg":15,"platesKg":[25,20]}""")
        assertEquals(GymPreferences(units = Units.Pounds), older)
    }
}
