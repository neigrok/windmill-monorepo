package works.windmill.platform.i18n

import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import works.windmill.platform.R

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AppLanguageTests {
    @get:Rule val compose = createComposeRule()

    private val counts = listOf(0, 1, 2, 3, 4, 5, 11, 12, 21, 22, 25, 100, 101, 102, 111, 1_000_001)

    private fun english(count: Int): String =
        if (count == 1) "1 change on this phone hasn’t been confirmed by your account. It is deleted too."
        else "$count changes on this phone haven’t been confirmed by your account. They are deleted too."

    @Test fun aPluralReadsInEnglishUnderEverySystemLanguage() {
        for (system in listOf("en-rUS", "ar", "ar-rEG", "ru", "de", "pl", "fr", "b+sr+Latn")) {
            RuntimeEnvironment.setQualifiers(system)
            val context = RuntimeEnvironment.getApplication()
            val read = counts.map { context.pluralString(R.plurals.platform_delete_unconfirmed_changes, it, it.toString()) }
            assertEquals(system, counts.map(::english), read)
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
        assertEquals(List(lists.size) { "en" }, lists.map { AppLanguage.of(android.os.LocaleList.forLanguageTags(it)).toLanguageTag() })
    }
}
