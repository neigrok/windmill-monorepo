package works.windmill.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import java.io.File
import kotlinx.coroutines.launch

class DesignCaptureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!designCaptureAllowed()) {
            finish()
            return
        }
        val tokenFile = File(filesDir, "design-capture-link")
        val resultFile = File(filesDir, "design-capture-result")
        resultFile.delete()
        lifecycleScope.launch {
            try {
                val token = tokenFile.readText().trim()
                check(tokenFile.delete())
                require(token.matches(Regex("[a-zA-Z0-9_-]{24,256}")))
                (application as WindmillApplication).auth.completeLink(token)
                resultFile.writeText("signed-in")
                startActivity(Intent(this@DesignCaptureActivity, MainActivity::class.java).apply {
                    action = Intent.ACTION_VIEW
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                })
            } catch (_: Exception) {
                resultFile.writeText("failed")
            } finally {
                tokenFile.delete()
                finish()
            }
        }
    }
}
