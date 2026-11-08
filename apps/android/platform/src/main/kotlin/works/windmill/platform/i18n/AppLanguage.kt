package works.windmill.platform.i18n

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.os.LocaleList
import androidx.annotation.PluralsRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import java.util.Locale

// The first system language the app ships resources for, else English; a second language is one more entry in `shipped`.
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

// Android picks a plural's category and formats its arguments in the system's first language, shipped or not.
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
