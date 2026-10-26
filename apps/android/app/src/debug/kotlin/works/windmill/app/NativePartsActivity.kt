package works.windmill.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import works.windmill.gym.ui.GymMaterial
import works.windmill.gym.ui.NativePartsSpecimen
import works.windmill.platform.design.WindmillMaterial
import works.windmill.platform.design.LocalWindmillDark

class NativePartsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val specimen = intent.getStringExtra("specimen")
        if (!designCaptureAllowed() || specimen == null || specimen !in setOf("board", "phone", "long-load", "bound-load", "fit-load", "refusal")) {
            finish()
            return
        }
        enableEdgeToEdge()
        if (specimen == "board")
            WindowCompat.getInsetsController(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
        setContent {
            CompositionLocalProvider(LocalWindmillDark provides isSystemInDarkTheme()) {
                WindmillMaterial {
                    GymMaterial { NativePartsSpecimen(specimen) }
                }
            }
        }
    }
}
