package works.windmill.platform

import androidx.test.core.app.ApplicationProvider
import works.windmill.platform.i18n.Words

// What the app says, read by a test the way a screen reads it: through the app's own resources, in English.
internal fun Words?.spelled(): String? = this?.text(ApplicationProvider.getApplicationContext())
