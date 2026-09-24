package works.windmill.gym.domain

import org.junit.Assert.assertEquals
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
    fun restFieldsFromOtherSurfacesAreIgnoredAndNeverStored() {
        val document = decoded("""{"restSeconds":180,"restSound":false,"units":"lb"}""")
        assertEquals(GymPreferences(units = Units.Pounds), document)
        assertEquals("""{"units":"lb"}""", encoded(document))
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
