package works.windmill.platform.i18n

import android.content.Context
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import java.io.Serializable
import works.windmill.platform.R

// What a screen says, decided where no Context stands and spelled where one does: one of the app's own messages, or the one a count picks in the app's language, its arguments spelled first when they are words themselves; or text that is already what is said — a name, the log's own refusal, a date the formatter wrote.
// Serializable, so a screen keeps what it said across a configuration change and spells it again in the new one.
sealed interface Words : Serializable {
    data class Message(@StringRes val id: Int, val args: List<Any> = emptyList()) : Words
    data class Counted(@PluralsRes val id: Int, val count: Int, val args: List<Any> = emptyList()) : Words
    data class Plain(val text: String) : Words

    fun text(context: Context): String = when (this) {
        is Message -> if (args.isEmpty()) context.getString(id) else context.getString(id, *args.spelled(context))
        is Counted -> context.pluralString(id, count, *args.spelled(context))
        is Plain -> text
    }

    private fun List<Any>.spelled(context: Context): Array<Any> = map { if (it is Words) it.text(context) else it }.toTypedArray()
}

// Words said one after another on one line, each standing apart: `Read 3 workouts · 2 weeks`.
fun List<Words>.joined(): Words? = reduceOrNull { said, next -> Words.Message(R.string.platform_words_joined, listOf(said, next)) }

@Composable
fun Words.text(): String {
    val context = LocalContext.current
    return remember(this, context, LocalConfiguration.current) { text(context) }
}
