package works.windmill.gym.ui

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.store.RefusedChange
import works.windmill.gym.store.RefusedSet
import works.windmill.gym.store.RefusedWorkout
import works.windmill.gym.presentation.Readout
import works.windmill.platform.i18n.Words

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RefusalBannerTests {
    @Test fun workoutFallbackUsesItsKnownDayAndNeverInventsAnInstant() {
        val at = 0L
        assertEquals("Workout on ${Readout.date(at)} stays on this phone", refusalWords(RefusedWorkout("notice", at, Words.Plain("Refused")), emptyList()).spelled())
        assertEquals("Workout stays on this phone", refusalWords(RefusedWorkout("notice", null, Words.Plain("Refused")), emptyList()).spelled())
    }

    @Test
    fun testALostSetAndALostClaimSpeakInTheBannersOneVoice() {
        val catalog = listOf(Exercise(id = "bench-press", name = "Bench Press"))

        assertEquals("Bench Press 82.5 × 5 never reached the log",
            refusalWords(RefusedSet(id = "set_a", exerciseId = "bench-press", weightKg = 82.5,
                reps = 5, why = Words.Plain("the session closed before this set reached it")), catalog).spelled())

        assertEquals("“Push Day” stays on this phone",
            refusalWords(RefusedChange(id = "rt_push", named = Words.Plain("Push Day"), why = Words.Plain("that document is unclaimable")), catalog).spelled())

        assertEquals("That change could not be saved.",
            refusalWords(RefusedChange(id = "notice", named = null, why = Words.Plain("That changed. Open it again.")), catalog).spelled())
    }
}

private fun Words?.spelled(): String? = this?.text(ApplicationProvider.getApplicationContext())
