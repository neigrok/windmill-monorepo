package works.windmill.gym.presentation

import androidx.annotation.StringRes
import works.windmill.gym.R
import works.windmill.platform.i18n.Words
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.Serializable

// One whole fact per local date, in kilograms. The newest engine stamp wins; recordedAt is the
// engine's commit moment, never the tie-breaker between saves.
@Serializable
data class WeighIn(val dateLocal: String, val weightKg: Double, val recordedAt: Long? = null) {
    val date: LocalDate get() = LocalDate.parse(dateLocal)
}

// What the field said, or the one refusal it met first.
sealed interface ParsedWeight {
    data class Ok(val weightKg: Double) : ParsedWeight
    data class Refused(val why: Words) : ParsedWeight
}

enum class ChartWindow(@StringRes val named: Int) {
    Ninety(R.string.gym_bodyweight_window_ninety), All(R.string.gym_bodyweight_window_all);
}

object Bodyweight {
    // The refusals, one at a time, in the order the field is read.
    val unreadable: Words = Words.Message(R.string.gym_entry_not_a_number)
    val extraPoint: Words = Words.Message(R.string.gym_entry_one_point)
    val outsideRange: Words = Words.Message(R.string.gym_bodyweight_out_of_range)
    val inTheFuture: Words = Words.Message(R.string.gym_bodyweight_not_a_forecast)

    // A segment is a connection and not data: none is drawn across a gap longer than this, and the
    // gap reads as a gap with no legend.
    const val maxGapDays = 7L

    const val minKg = 20.0
    const val maxKg = 400.0

    fun today(nowMs: Long): LocalDate =
        Instant.ofEpochMilli(nowMs).atZone(ZoneId.systemDefault()).toLocalDate()

    // Comma or point, at most one of either, digits on at least one side, and inside the bounds.
    fun parse(typed: String): ParsedWeight {
        val raw = typed.trim()
        if (raw.isEmpty() || raw.none { it in '0'..'9' } || raw.any { it !in '0'..'9' && it != '.' && it != ',' }) {
            return ParsedWeight.Refused(unreadable)
        }
        if (raw.count { it == '.' || it == ',' } > 1) return ParsedWeight.Refused(extraPoint)
        val normalised = raw.replace(',', '.')
        val value = normalised.toBigDecimalOrNull() ?: return ParsedWeight.Refused(unreadable)
        if (value < BigDecimal.valueOf(minKg) || value > BigDecimal.valueOf(maxKg)) return ParsedWeight.Refused(outsideRange)
        val rounded = value.setScale(2, RoundingMode.HALF_UP).toDouble()
        return ParsedWeight.Ok(rounded)
    }

    // A date past this device's local today is refused at the field; the log refuses one more than a
    // day past its own UTC today in the same words.
    fun dateRefusal(date: LocalDate, today: LocalDate): Words? =
        if (date.isAfter(today)) inTheFuture else null

    // Two decimals stored; trailing zeros are not drawn: 82.40 reads 82.4, 82.00 reads 82.
    fun kilograms(weightKg: Double): String =
        BigDecimal.valueOf(weightKg).setScale(2, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()

    fun fullDay(date: LocalDate): String = date.format(DateTimeFormatter.ofPattern("d MMMM uuuu", Locale.ENGLISH))

    // The reading: the newest day that has happened. A served row dated after this device's today is
    // never the reading and never a dot — the log refused it a day later than this phone would.
    fun latest(entries: List<WeighIn>, today: LocalDate): WeighIn? =
        entries.filter { !it.date.isAfter(today) }.maxByOrNull { it.dateLocal }

    // Ascending by date, never past today; the last 90 calendar days ending today for the narrow window.
    fun windowed(entries: List<WeighIn>, window: ChartWindow, today: LocalDate): List<WeighIn> {
        val sorted = entries.filter { !it.date.isAfter(today) }.sortedBy { it.dateLocal }
        if (window == ChartWindow.All) return sorted
        val from = today.minusDays(89)
        return sorted.filter { !it.date.isBefore(from) }
    }

    // The caption names the selected window and its measured points.
    fun windowWords(window: ChartWindow, shown: Int): Words = when (window) {
        ChartWindow.Ninety -> Words.Counted(R.plurals.gym_bodyweight_window_ninety_count, shown, listOf(shown.toString()))
        ChartWindow.All -> Words.Counted(R.plurals.gym_bodyweight_window_all_count, shown, listOf(shown.toString()))
    }

}
