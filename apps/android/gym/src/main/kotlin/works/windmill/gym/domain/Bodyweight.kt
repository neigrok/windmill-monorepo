package works.windmill.gym.domain

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlin.math.ceil
import kotlin.math.floor
import kotlinx.serialization.Serializable

// One row per local calendar date; the date IS the identity, so every write is idempotent by it and
// the server keeps whichever of two writes carries the later `recordedAt`. Kilograms only, on the
// wire and on this phone. `recordedAt` is this device's clock at the save and decides nothing but
// which of two writes is newer.
@Serializable
data class WeighIn(val dateLocal: String, val weightKg: Double, val recordedAt: Long) {
    val date: LocalDate get() = LocalDate.parse(dateLocal)
}

// PUT /v1/gym/bodyweight/{dateLocal}. Both fields ride explicitly: encodeDefaults is off and neither
// has a default to omit.
@Serializable
data class WeighInWrite(val weightKg: Double, val recordedAt: Long)

// What the field said, or the one refusal it met first.
sealed interface ParsedWeight {
    data class Ok(val weightKg: Double) : ParsedWeight
    data class Refused(val said: String) : ParsedWeight
}

// A dot per measurement; a segment joins two dots only when the gap between them is short enough to
// be an ordinary week. A longer gap is left empty and named.
sealed interface ChartRun {
    data class Segment(val from: WeighIn, val to: WeighIn) : ChartRun
    data class Gap(val from: WeighIn, val to: WeighIn) : ChartRun {
        val label: String get() = "no weigh-in · ${Bodyweight.shortDay(from.date)} – ${Bodyweight.shortDay(to.date)}"
    }
}

enum class ChartWindow(val label: String) {
    Ninety("90 days"), All("All");
}

object Bodyweight {
    const val title = "Bodyweight"
    const val chip = "Weigh in"
    const val save = "Save"
    const val fieldHint = "comma or point, both read as a decimal"
    const val unit = "kg"

    // The refusals, one at a time, in the order the field is read.
    const val notANumber = "That is not a number yet."
    const val onePoint = "One decimal point only."
    const val outOfRange = "Between 20 and 400 kg — check the number."
    const val notAForecast = "A weigh-in is not a forecast — today or earlier."

    const val deleteRow = "Delete weigh-in"
    const val deleteAsk = "Delete this weigh-in?"
    const val delete = "Delete"

    // Printed on the chart, because a segment is a connection and not data.
    const val gapRule = "no line is drawn across a gap longer than seven days"
    const val maxGapDays = 7L

    const val nothingYet = "No weigh-ins yet. Weigh in from the log."
    const val noneInWindow = "no weigh-in in the last 90 days"

    // The same words the settings screen uses: this phone converts nothing.
    const val kilogramsOnly = "This phone still draws every weight in kilograms — nothing on this screen converts one."

    const val minKg = 20.0
    const val maxKg = 400.0

    fun today(nowMs: Long): LocalDate =
        Instant.ofEpochMilli(nowMs).atZone(ZoneId.systemDefault()).toLocalDate()

    // Comma or point, at most one of either, digits on at least one side, and inside the bounds.
    fun parse(typed: String): ParsedWeight {
        val raw = typed.trim()
        if (raw.isEmpty() || raw.none { it.isDigit() }) return ParsedWeight.Refused(notANumber)
        if (raw.count { it == '.' || it == ',' } > 1) return ParsedWeight.Refused(onePoint)
        val normalised = raw.replace(',', '.')
        if (!normalised.all { it.isDigit() || it == '.' }) return ParsedWeight.Refused(notANumber)
        val value = normalised.toBigDecimalOrNull() ?: return ParsedWeight.Refused(notANumber)
        val rounded = value.setScale(2, RoundingMode.HALF_UP).toDouble()
        if (rounded < minKg || rounded > maxKg) return ParsedWeight.Refused(outOfRange)
        return ParsedWeight.Ok(rounded)
    }

    // A date past this device's local today is refused at the field; the log refuses one more than a
    // day past its own UTC today in the same words.
    fun dated(date: LocalDate, today: LocalDate): String? =
        if (date.isAfter(today)) notAForecast else null

    // Two decimals stored; trailing zeros are not drawn: 82.40 reads 82.4, 82.00 reads 82.
    fun kilograms(weightKg: Double): String =
        BigDecimal.valueOf(weightKg).setScale(2, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()

    // The y-axis names its unit: `85.5 kg`.
    fun axisLabel(weightKg: Double): String = "${kilograms(weightKg)} $unit"

    // `82.4 kg · 3 days ago`. A calendar claim: both ends are local dates.
    fun reading(latest: WeighIn?, nowMs: Long): String? {
        val held = latest ?: return null
        return "${kilograms(held.weightKg)} $unit · ${age(held.date, today(nowMs))}"
    }

    fun age(date: LocalDate, today: LocalDate): String {
        val days = ChronoUnit.DAYS.between(date, today)
        if (days <= 0) return "today"
        if (days == 1L) return "yesterday"
        return "$days days ago"
    }

    private val months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    private val weekdays = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

    fun shortDay(date: LocalDate): String = "${date.dayOfMonth} ${months[date.monthValue - 1]}"

    // `Tue 26 Aug`, or `Today · Tue 26 Aug` when it is.
    fun dayLine(date: LocalDate, today: LocalDate): String {
        val day = "${weekdays[date.dayOfWeek.value % 7]} ${shortDay(date)}"
        if (date == today) return "Today · $day"
        return day
    }

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

    // Printed on the chart: `last 90 days · 4 weigh-ins`, the same words on every surface.
    fun windowLine(window: ChartWindow, shown: Int): String {
        val counted = if (shown == 1) "1 weigh-in" else "$shown weigh-ins"
        return when (window) {
            ChartWindow.Ninety -> "last 90 days · $counted"
            ChartWindow.All -> "the whole series · $counted"
        }
    }

    // The repair sheet is titled by the day it repairs; the entry sheet by the verb.
    fun sheetTitle(fixedDate: LocalDate?): String =
        if (fixedDate == null) chip else "Weigh-in · ${shortDay(fixedDate)}"

    // Consecutive dots, joined or left apart on the seven-day rule.
    fun runs(entries: List<WeighIn>): List<ChartRun> =
        entries.sortedBy { it.dateLocal }.zipWithNext { from, to ->
            if (ChronoUnit.DAYS.between(from.date, to.date) > maxGapDays) ChartRun.Gap(from, to)
            else ChartRun.Segment(from, to)
        }

    // The y-axis is the series' own floor and ceiling plus padding, never zero: a bodyweight between
    // 82.0 and 84.5 has to be readable as a slope.
    data class Axis(val floorKg: Double, val ceilingKg: Double) {
        fun fraction(weightKg: Double): Float {
            val span = ceilingKg - floorKg
            if (span <= 0.0) return 0.5f
            return ((weightKg - floorKg) / span).toFloat().coerceIn(0f, 1f)
        }
    }

    fun axis(entries: List<WeighIn>): Axis? {
        if (entries.isEmpty()) return null
        val low = entries.minOf { it.weightKg }
        val high = entries.maxOf { it.weightKg }
        val padding = maxOf(1.0, (high - low) * 0.2)
        return Axis(
            floorKg = floor((low - padding) * 2) / 2,
            ceilingKg = ceil((high + padding) * 2) / 2,
        )
    }
}
