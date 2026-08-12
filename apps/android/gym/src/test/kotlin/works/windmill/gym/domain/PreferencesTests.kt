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

    // An empty rack is a REAL value and must not be confused with an omitted one: omitted is the
    // full default set, and `[]` is a gym that owns no plates. They encode differently and they
    // decode differently.
    @Test
    fun testAnEmptyRackIsSentAndAFullDefaultRackIsNot() {
        assertEquals("""{"platesKg":[]}""", encoded(GymPreferences(platesKg = emptyList())))
        assertEquals("{}", encoded(GymPreferences(platesKg = GymPreferences.defaultPlatesKg)))
        assertEquals(emptyList<Double>(), decoded("""{"platesKg":[]}""").platesKg)
        assertEquals(GymPreferences.defaultPlatesKg, decoded("{}").platesKg)
    }

    // The unit is a word on the wire and never an ordinal. A word from a future server READS as kg
    // rather than crashing a room mid-workout; refusing it is the server's job, on the write.
    @Test
    fun testTheUnitIsAWordAndAnUnknownOneReadsAsKilograms() {
        assertEquals("""{"units":"lb"}""", encoded(GymPreferences(units = Units.Pounds)))
        assertEquals(Units.Pounds, decoded("""{"units":"lb"}""").units)
        assertEquals(Units.Kilograms, decoded("""{"units":"stone"}""").units)
    }

    // The server normalizes the rack and so does the device, because the device draws its own copy
    // before any reply arrives. Heaviest first, one of each, and every band clamped rather than
    // refused — a value outside the band is a deterministic 400 on the next PUT with nothing on
    // screen to explain it.
    @Test
    fun testTheRackIsSortedDeduplicatedAndTheBandsAreClamped() {
        val messy = GymPreferences(
            barWeightKg = 140.0,
            platesKg = listOf(2.5, 25.0, 20.0, 2.5, 25.0),
            restSeconds = 4_000,
        ).normalized()
        assertEquals(listOf(25.0, 20.0, 2.5), messy.platesKg)
        assertEquals(GymPreferences.maxBarKg, messy.barWeightKg, 1e-9)
        assertEquals(GymPreferences.maxRestSeconds, messy.restSeconds)
        assertNull("off survives normalizing — it is not a value to clamp",
                   GymPreferences(restSeconds = null).normalized().restSeconds)
    }

    // A chip is a membership and nothing else: tapping it twice returns the rack it started from,
    // still heaviest-first.
    @Test
    fun testTogglingAPlateIsItsOwnInverse() {
        val standard = GymPreferences()
        val without = standard.togglingPlate(15.0)
        assertEquals(listOf(25.0, 20.0, 10.0, 5.0, 2.5, 1.25), without.platesKg)
        assertEquals(GymPreferences.defaultPlatesKg, without.togglingPlate(15.0).platesKg)
    }

    // The chips the screen draws are the design's seven PLUS whatever the document already holds,
    // so a plate set from another surface still has somewhere to be turned off.
    @Test
    fun testTheChipRowHoldsPlatesThisScreenDidNotOffer() {
        assertEquals(
            listOf(25.0, 20.0, 15.0, 10.0, 5.0, 2.5, 1.25, 0.5),
            GymPreferences.offeredPlates(listOf(0.5, 25.0)),
        )
    }
}
