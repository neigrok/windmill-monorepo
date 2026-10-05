package works.windmill.domain.kit

import java.text.Normalizer

object Nfc {
    fun normalise(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFC)
}
