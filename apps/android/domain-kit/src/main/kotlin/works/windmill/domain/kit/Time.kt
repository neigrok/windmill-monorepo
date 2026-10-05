package works.windmill.domain.kit

data class Instant(val ms: Long) : Comparable<Instant> {
    override fun compareTo(other: Instant): Int = ms.compareTo(other.ms)
}

fun interface Zone { fun offsetSeconds(at: Instant): Int }
data class FixedZone(val seconds: Int) : Zone { override fun offsetSeconds(at: Instant): Int = seconds }
data class Moment(val now: Instant, val zone: Zone) { val today: LocalDay get() = LocalDay.from(now, zone.offsetSeconds(now)) }

@ConsistentCopyVisibility
data class LocalDay private constructor(val year: Long, val month: Int, val day: Int) : Comparable<LocalDay> {
    val daysSinceEpoch: Long get() {
        val y = if (month <= 2) year - 1 else year
        val era = floorDivide(y, 400)
        val yoe = y - era * 400
        val mp = if (month > 2) month - 3 else month + 9
        val doy = (153 * mp + 2) / 5 + day - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }
    val text: String get() = year.toString().padStart(4, '0') + "-" + month.toString().padStart(2, '0') + "-" + day.toString().padStart(2, '0')
    val weekday: Int get() = ((daysSinceEpoch + 3) - floorDivide(daysSinceEpoch + 3, 7) * 7).toInt() + 1
    fun adding(days: Long): LocalDay = civil(daysSinceEpoch + days)
    fun daysUntil(other: LocalDay): Long = other.daysSinceEpoch - daysSinceEpoch
    override fun compareTo(other: LocalDay): Int = daysSinceEpoch.compareTo(other.daysSinceEpoch)
    override fun toString(): String = text
    companion object {
        fun parse(text: String): LocalDay? {
            if (text.length != 10 || text[4] != '-' || text[7] != '-' ||
                listOf(0, 1, 2, 3, 5, 6, 8, 9).any { text[it] !in '0'..'9' }) return null
            val year = text.take(4).toLong()
            val month = text.substring(5, 7).toInt()
            val day = text.takeLast(2).toInt()
            if (year < 1 || month !in 1..12 || day < 1 || day > monthLength(month, year)) return null
            return LocalDay(year, month, day)
        }
        fun from(instant: Instant, offsetSeconds: Int): LocalDay = civil(floorDivide(instant.ms + offsetSeconds.toLong() * 1000, 86400000))
        fun from(instant: Instant, zone: Zone): LocalDay = from(instant, zone.offsetSeconds(instant))
        fun civil(days: Long): LocalDay {
            val z = days + 719468
            val era = floorDivide(z, 146097)
            val doe = z - era * 146097
            val yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
            val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
            val mp = (5 * doy + 2) / 153
            val day = doy - (153 * mp + 2) / 5 + 1
            val month = if (mp < 10) mp + 3 else mp - 9
            val year = yoe + era * 400 + if (month <= 2) 1 else 0
            return LocalDay(year, month.toInt(), day.toInt())
        }
        fun floorDivide(a: Long, b: Long): Long {
            val quotient = a / b
            return if (a % b != 0L && (a < 0) != (b < 0)) quotient - 1 else quotient
        }
        fun monthLength(month: Int, year: Long): Int {
            val leap = year % 4 == 0L && (year % 100 != 0L || year % 400 == 0L)
            return listOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[month - 1]
        }
    }
}
