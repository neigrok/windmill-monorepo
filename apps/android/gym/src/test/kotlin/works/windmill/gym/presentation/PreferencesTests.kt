package works.windmill.gym.presentation

import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.platform.net.WindmillJson

class PreferencesTests {
    @Test fun defaultFeedbackHasNoFields() {
        assertEquals("{}", WindmillJson.encodeToString(GymPreferences.serializer(), GymPreferences()))
        assertEquals(GymPreferences(), WindmillJson.decodeFromString(GymPreferences.serializer(), "{}"))
    }

    @Test fun sharedWireUnitsRestAndEquipmentAreIgnoredByTheAndroidView() {
        val raw = """{"units":"lb","restSeconds":180,"restSound":true,"barWeightKg":15,"platesKg":[25,20],"confirmHaptic":false,"confirmSound":true}"""
        val expected = GymPreferences(confirmHaptic = false, confirmSound = true)
        assertEquals(expected, WindmillJson.decodeFromString(GymPreferences.serializer(), raw))
        assertEquals("""{"confirmHaptic":false,"confirmSound":true}""", WindmillJson.encodeToString(GymPreferences.serializer(), expected))
    }
}
