package works.windmill.platform.i18n

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.os.LocaleList
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import java.io.Serializable
import java.util.Locale
import works.windmill.platform.R

// What a screen says, decided where no Context stands and spelled where one does; Serializable, so saved state keeps it.
sealed interface Words : Serializable {
    // One of the app's own messages; an argument that is Words itself is spelled first.
    data class Message(@StringRes val id: Int, val args: List<Serializable> = emptyList()) : Words

    // The message a count picks in the app's language.
    data class Counted(@PluralsRes val id: Int, val count: Int, val args: List<Serializable> = emptyList()) : Words

    // Text that already is what is said: a name, the server's own sentence, a number its formatter wrote.
    data class Plain(val text: String) : Words

    fun text(context: Context): String = when (this) {
        is Message -> if (args.isEmpty()) context.getString(id) else context.getString(id, *args.spelled(context))
        is Counted -> context.pluralString(id, count, *args.spelled(context))
        is Plain -> text
    }

    private fun List<Serializable>.spelled(context: Context): Array<Any> = map { if (it is Words) it.text(context) else it }.toTypedArray()
}

// Words said one after another on one line, a middle dot between each.
fun List<Words>.joined(): Words? = reduceOrNull { said, next -> Words.Message(R.string.platform_words_joined, listOf(said, next)) }

@Composable
fun Words.text(): String {
    val context = LocalContext.current
    return remember(this, context, LocalConfiguration.current) { text(context) }
}

// The first system language the app ships resources for, matched by language alone, else English.
object AppLanguage {
    private val shipped = listOf(Locale.ENGLISH)

    fun of(system: LocaleList): Locale =
        (0 until system.size()).firstNotNullOfOrNull { index -> shipped.firstOrNull { it.language == system[index].language } }
            ?: shipped.first()

    fun resources(context: Context): Resources {
        val configuration = Configuration(context.resources.configuration)
        configuration.setLocale(of(configuration.locales))
        return context.createConfigurationContext(configuration).resources
    }
}

// Android picks a plural's category in the system's first language, shipped or not, so a count asks the app's language.
@Composable
fun pluralString(@PluralsRes id: Int, count: Int, vararg args: Any): String {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val resources = remember(context, configuration) { AppLanguage.resources(context) }
    return resources.quantity(id, count, args)
}

fun Context.pluralString(@PluralsRes id: Int, count: Int, vararg args: Any): String =
    AppLanguage.resources(this).quantity(id, count, args)

private fun Resources.quantity(@PluralsRes id: Int, count: Int, args: Array<out Any>): String {
    if (args.isEmpty()) return getQuantityString(id, count)
    return getQuantityString(id, count, *args)
}
