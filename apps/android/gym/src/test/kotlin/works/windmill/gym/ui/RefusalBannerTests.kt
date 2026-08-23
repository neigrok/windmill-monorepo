package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.gym.domain.Exercise
import works.windmill.gym.store.RefusedClaim
import works.windmill.gym.store.RefusedSet

class RefusalBannerTests {
    @Test
    fun testALostSetAndALostClaimSpeakInTheBannersOneVoice() {
        val catalog = listOf(Exercise(id = "bench-press", name = "Bench Press"))

        assertEquals("Bench Press 82.5 × 5 never reached the log",
            refusalHeadline(RefusedSet(id = "set_a", exerciseId = "bench-press", weightKg = 82.5,
                reps = 5, reason = "the session closed before this set reached it"), catalog))

        assertEquals("“Push Day” couldn’t be claimed",
            refusalHeadline(RefusedClaim(id = "rt_push", name = "Push Day", reason = "that document is unclaimable"), catalog))
    }
}
