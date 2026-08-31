package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectedLogTests {
    private val everySentence = listOf(
        ConnectedLog.title,
        ConnectedLog.head,
        ConnectedLog.sub,
        ConnectedLog.sundayLabel,
        ConnectedLog.sundayLine,
        ConnectedLog.mondayLabel,
        ConnectedLog.mondayLine,
        ConnectedLog.precondition,
        ConnectedLog.connect,
        ConnectedLog.onTheWeb,
        ConnectedLog.free,
        ConnectedLog.canDoHead,
        ConnectedLog.canDo,
        ConnectedLog.cannotDoHead,
        ConnectedLog.cannotDo,
        ConnectedLog.deleteLevel,
        ConnectedLog.whereItLives,
        ConnectedLog.notNamedHere,
        ConnectedLog.deviceOnly,
    ) + ConnectedLog.truths

    @Test
    fun nothingOnTheseCardsNamesAPriceALockOrATier() {
        val refused = listOf(
            "windmill one", "upgrade", "subscription", "subscribe", "trial", "premium", "pro plan",
            "unlock", "per month", "/month", "$", "€", "£", "free for now", "founder", "limited time",
        )

        val offenders = everySentence.filter { sentence ->
            refused.any { sentence.lowercase().contains(it) }
        }

        assertEquals(emptyList<String>(), offenders)
        assertTrue(
            "where the price stood, the card says connecting is free",
            ConnectedLog.free.startsWith("Connecting your log is free."),
        )
    }

    @Test
    fun theGrantCardNamesWhatTheDeleteLevelActuallyDestroys() {
        assertTrue(
            "the delete level is named as a level of its own, never implied by write",
            ConnectedLog.deleteLevel.contains("its own level and is never implied by write"),
        )
        assertTrue(
            "and what it buys is said in the words a lifter would use",
            ConnectedLog.deleteLevel.contains("discard a whole workout"),
        )
        assertEquals(
            "no sentence claims a connection can delete nothing",
            emptyList<String>(),
            everySentence.filter { it.lowercase().contains("delete anything") },
        )
        assertEquals(
            "and none claims a connection never writes",
            emptyList<String>(),
            everySentence.filter { it.lowercase().contains("never writes") },
        )
    }

    @Test
    fun theGrantCardNamesTheOneCapabilityThatLeavesTheAccount() {
        assertTrue(
            "the write list says a link is minted and who can read it",
            ConnectedLog.canDo.contains("link") && ConnectedLog.canDo.contains("without signing in"),
        )
        assertTrue(
            "and its window in numerals, the way the web and the tool catalogue write it",
            ConnectedLog.canDo.contains("for 30 days") && !ConnectedLog.canDo.contains("thirty"),
        )
        assertTrue(
            "and the delete level says it can end one",
            ConnectedLog.deleteLevel.contains("end a share link"),
        )
        assertEquals(
            "one sentence of the pitch names the shared link too",
            1,
            ConnectedLog.truths.count { it.contains("link you shared") },
        )
    }

    @Test
    fun thePitchIsTheSameSentenceTheWebAndIosConnectPagesDraw() {
        assertEquals(
            "Not a chat in another tab. The twelve weeks of squats you already logged, readable by the " +
                "assistant you already use.",
            ConnectedLog.sub,
        )
    }

    @Test
    fun theWordCoachNamesTheRoomAndNothingOnTheseCards() {
        assertEquals(emptyList<String>(), everySentence.filter { it.lowercase().contains("coach") })
        assertTrue("the read list names the notes, which every connected agent reads",
            ConnectedLog.canDo.contains("notes"))
    }

    @Test
    fun thisPhoneDrawsNoConnectionStateItCannotRead() {
        assertEquals(
            emptyList<String>(),
            everySentence.filter { it.contains(" ago") || it.lowercase().contains("last read") },
        )
        assertTrue(ConnectedLog.notNamedHere.contains("does not read that list"))
    }

    @Test
    fun bothDoorsAreSpelledOffTheOriginTheAppTalksTo() {
        assertEquals("https://windmill.works/#/connect", ConnectedLog.setupUrl("https://windmill.works/"))
        assertEquals("https://windmill.works/#/connect", ConnectedLog.setupUrl("https://windmill.works"))
        assertEquals("http://10.0.2.2:8088/#/connect", ConnectedLog.setupUrl("http://10.0.2.2:8088/"))
        assertEquals("https://windmill.works/#/settings", ConnectedLog.connectionsUrl("https://windmill.works/"))
        assertEquals("http://10.0.2.2:8088/#/settings", ConnectedLog.connectionsUrl("http://10.0.2.2:8088"))
    }
}
