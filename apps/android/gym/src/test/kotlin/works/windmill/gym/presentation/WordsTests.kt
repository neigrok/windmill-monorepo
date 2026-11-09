package works.windmill.gym.presentation

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.R
import works.windmill.platform.i18n.Words
import works.windmill.platform.i18n.joined

// A phone set to Russian or Arabic counts in the app's English: 21 is "workouts" and 2 is "weeks", never the system's own categories.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WordsTests {
    private fun said(words: Words?): String? = words?.text(ApplicationProvider.getApplicationContext<Context>())

    private fun read(sessions: Int, weeks: Int) = listOf(
        Words.Counted(R.plurals.gym_coach_read_workouts, sessions, listOf(sessions.toString())),
        Words.Counted(R.plurals.gym_coach_weeks, weeks, listOf(weeks.toString())),
    ).joined()

    @Test @Config(qualifiers = "ru-rRU")
    fun aCountUnderRussianReadsInEnglish() {
        assertEquals(listOf("Read 1 workout · 1 week", "Read 2 workouts · 2 weeks", "Read 5 workouts · 0 weeks", "Read 21 workouts · 21 weeks", "Read 22 workouts · 101 weeks"),
            listOf(1 to 1, 2 to 2, 5 to 0, 21 to 21, 22 to 101).map { (sessions, weeks) -> said(read(sessions, weeks)) })
    }

    @Test @Config(qualifiers = "ar-rEG")
    fun aCountUnderArabicReadsInEnglishWithItsOwnDigits() {
        assertEquals(listOf("Read 0 workouts · 0 weeks", "Read 2 workouts · 3 weeks", "Read 11 workouts · 100 weeks"),
            listOf(0 to 0, 2 to 3, 11 to 100).map { (sessions, weeks) -> said(read(sessions, weeks)) })
    }

    @Test
    fun wordsJoinOneAfterAnotherAndPlainTextStandsAsWritten() {
        assertEquals("Push A · a removal · Leg day", said(listOf(Words.Plain("Push A"), Words.Message(R.string.gym_coach_a_removal), Words.Plain("Leg day")).joined()))
        assertEquals("Push A", said(listOf(Words.Plain("Push A")).joined()))
        assertNull(emptyList<Words>().joined())
        assertEquals("50% of 1RM", said(Words.Plain("50% of 1RM")))
    }
}
