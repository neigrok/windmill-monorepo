package works.windmill.gym

import android.content.Context
import androidx.annotation.StringRes
import androidx.test.core.app.ApplicationProvider
import works.windmill.platform.i18n.Words

// What the app says, read by a test the way a screen reads it: through the app's own resources, in English.
internal fun Words.spelled(): String = text(ApplicationProvider.getApplicationContext())

@JvmName("spelledOrNull")
internal fun Words?.spelled(): String? = this?.spelled()

internal fun Words.plain(): Words = Words.Plain(text(ApplicationProvider.getApplicationContext()))

internal fun string(@StringRes id: Int, vararg args: Any): String {
    val context = ApplicationProvider.getApplicationContext<Context>()
    if (args.isEmpty()) return context.getString(id)
    return context.getString(id, *args)
}
