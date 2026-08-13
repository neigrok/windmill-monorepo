package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.platform.net.WindmillJson

// THE SETTINGS DOCUMENT ON THE WIRE, and the one property the whole route hangs off: an OMITTED
// field takes its DEFAULT on the server rather than keeping what is stored. WindmillJson omits a
// value that equals its declared default, so the two rules have to agree exactly — and this file is
// where that agreement is pinned, because nothing else would notice it breaking until a lifter
// dialled a setting back to the default and watched it not travel.

class PreferencesTests {
    private fun encoded(document: GymPreferences) =
        WindmillJson.encodeToString(GymPreferences.serializer(), document)

    private fun decoded(json: String) =
        WindmillJson.decodeFromString(GymPreferences.serializer(), json)

    // A document at its defaults travels as nothing at all — which is exactly right, because the
    // server fills an omitted field with the same default. The empty object is the send, and it is
    // the wave's landmine written down: nothing about this document may ever be inferred from the
    // BYTES being empty, only from the field it was read into being absent.
    @Test
    fun testADocumentAtItsDefaultsTravelsAsAnEmptyObject() {
        assertEquals("{}", encoded(GymPreferences()))
        assertEquals(GymPreferences(), decoded("{}"))
    }

    // OFF IS AN ABSENCE AND HAS NO OTHER SPELLING — no 0, no false. So a timer turned off sends no
    // `restSeconds` key at all, and a reply without one reads as off rather than as a value the
    // parser missed.
    @Test
    fun testRestOffIsAnAbsentKeyInBothDirections() {
        assertEquals("{}", encoded(GymPreferences(restSeconds = null)))
        assertEquals("""{"restSeconds":120}""", encoded(GymPreferences(restSeconds = 120)))
        assertNull(decoded("""{"restSound":true}""").restSeconds)
        assertEquals(180, decoded("""{"restSeconds":180}""").restSeconds)
    }

    // The unit is a word on the wire and never an ordinal. A word from a future server READS as kg
    // rather than crashing a room mid-workout; refusing it is the server's job, on the write.
    @Test
    fun testTheUnitIsAWordAndAnUnknownOneReadsAsKilograms() {
        assertEquals("""{"units":"lb"}""", encoded(GymPreferences(units = Units.Pounds)))
        assertEquals(Units.Pounds, decoded("""{"units":"lb"}""").units)
        assertEquals(Units.Kilograms, decoded("""{"units":"stone"}""").units)
    }

    // The band is clamped rather than refused, because the device draws its own copy before any reply
    // arrives — and a value outside the band is a deterministic 400 on the next PUT with nothing on
    // screen to explain it.
    @Test
    fun testTheRestBandIsClampedAndOffSurvives() {
        assertEquals(GymPreferences.maxRestSeconds,
                     GymPreferences(restSeconds = 4_000).normalized().restSeconds)
        assertEquals(GymPreferences.minRestSeconds,
                     GymPreferences(restSeconds = 5).normalized().restSeconds)
        assertNull("off survives normalizing — it is not a value to clamp",
                   GymPreferences(restSeconds = null).normalized().restSeconds)
    }

    // EQUIPMENT LEFT THIS DOCUMENT ON 2026-08-13, and this is where that is pinned rather than
    // assumed: nothing about a bar or a plate travels in either direction any more, and a document
    // from an older build carrying both still reads as the room it describes minus the equipment.
    @Test
    fun testNothingAboutEquipmentTravelsInEitherDirection() {
        assertEquals("""{"units":"lb"}""", encoded(GymPreferences(units = Units.Pounds)))
        val older = decoded("""{"units":"lb","barWeightKg":15,"platesKg":[25,20]}""")
        assertEquals(GymPreferences(units = Units.Pounds), older)
    }
}
