package works.windmill.platform.i18n

import android.os.Bundle
import android.os.LocaleList
import android.os.Parcel
import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import works.windmill.platform.R
import works.windmill.platform.spelled

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WordsTests {
    @get:Rule val compose = createComposeRule()

    private val counts = listOf(0, 1, 2, 3, 4, 5, 11, 12, 21, 22, 25, 100, 101, 102, 111, 1_000_001)

    private fun deleted(count: Int): String =
        if (count == 1) "1 change on this phone hasn’t been confirmed by your account. It is deleted too."
        else "$count changes on this phone haven’t been confirmed by your account. They are deleted too."

    private fun counted(count: Int) = Words.Counted(R.plurals.platform_delete_unconfirmed_changes, count, listOf(count.toString()))

    @Test fun aPluralReadsInEnglishUnderEverySystemLanguage() {
        for (system in listOf("en-rUS", "ar", "ar-rEG", "ru", "de", "pl", "fr", "b+sr+Latn")) {
            RuntimeEnvironment.setQualifiers(system)
            val context = RuntimeEnvironment.getApplication()
            assertEquals(system, counts.map(::deleted), counts.map { context.pluralString(R.plurals.platform_delete_unconfirmed_changes, it, it.toString()) })
            assertEquals(system, counts.map(::deleted), counts.map { counted(it).spelled() })
        }
    }

    @Test fun theSystemsOwnRulesWouldSayOneChangeForTwentyOneInRussian() {
        RuntimeEnvironment.setQualifiers("ru")
        val resources = RuntimeEnvironment.getApplication().resources
        assertEquals(
            "21 change on this phone hasn’t been confirmed by your account. It is deleted too.",
            resources.getQuantityString(R.plurals.platform_delete_unconfirmed_changes, 21, "21"),
        )
    }

    @Test fun aComposedPluralReadsInEnglishUnderArabic() {
        RuntimeEnvironment.setQualifiers("ar")
        compose.setContent {
            Text(pluralString(R.plurals.platform_sign_out_unconfirmed_changes, 21, 21.toString()))
        }
        compose.onNodeWithText(
            "21 changes haven’t been confirmed by your account yet. Keep them on this phone until you sign in again, or discard them from this phone.",
        ).assertExists()
    }

    @Test fun theAppSpeaksEnglishWhateverTheSystemLists() {
        val lists = listOf("ru,en-GB", "ar-EG", "de-DE,fr-FR", "en-US")
        assertEquals(List(lists.size) { "en" }, lists.map { AppLanguage.of(LocaleList.forLanguageTags(it)).toLanguageTag() })
    }

    @Test fun wordsInsideAMessageAreSpelledFirstAndPlainTextStandsAsWritten() {
        assertEquals("Ada Lovelace · Cancel · 2 changes on this phone haven’t been confirmed by your account. They are deleted too.",
            listOf(Words.Plain("Ada Lovelace"), Words.Message(R.string.platform_cancel), counted(2)).joined().spelled())
        assertEquals("Ada Lovelace", listOf(Words.Plain("Ada Lovelace")).joined().spelled())
        assertNull(emptyList<Words>().joined())
        assertEquals("100% synced", Words.Plain("100% synced").spelled())
    }

    // Saved state carries Words through a Bundle and a Parcel; what comes back is equal and says the same.
    @Test fun wordsComeBackFromSavedStateAsTheyWent() {
        val said = listOf(
            Words.Plain("Ada Lovelace"),
            Words.Message(R.string.platform_cancel),
            counted(21),
            Words.Message(R.string.platform_words_joined, listOf(Words.Plain("Ada Lovelace"), Words.Message(R.string.platform_words_joined, listOf(counted(1), "kept")))),
        )
        for (words in said) {
            val parcel = Parcel.obtain()
            parcel.writeBundle(Bundle().apply { putSerializable("words", words) })
            parcel.setDataPosition(0)
            val back = parcel.readBundle(Words::class.java.classLoader)!!.getSerializable("words", Words::class.java)
            parcel.recycle()
            assertEquals(words, back)
            assertEquals(words.spelled(), back.spelled())
        }
    }
}
