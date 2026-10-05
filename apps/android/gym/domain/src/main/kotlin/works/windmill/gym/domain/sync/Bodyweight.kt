package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

data class WeighIn(override val id: Id<WeighIn>, val kg: Double? = null, val recordedAt: Instant? = null) : Writable<WeighIn> {
    constructor(day: LocalDay, kg: Double? = null, recordedAt: Instant? = null) : this(Id(RecordID(day.text), Companion), kg, recordedAt)
    val day: LocalDay? get() = id.record.string?.let(LocalDay::parse)
    override fun fields(): Map<String, Json> = mapOf("kg" to (kg?.let(Json::of) ?: Json.Null), "recordedAt" to (recordedAt?.ms?.let(Json::of) ?: Json.Null))

    companion object : DraftableType<WeighIn>, RemovableType<WeighIn>, TimestampedType<WeighIn> {
        override val type = Gym.Types.weighin
        override val scope = ScopeRef(Gym.scope)
        override val savesGuarded = false
        override val heldRemoval = true
        override val timestampField = "recordedAt"
        override fun decode(f: Fields) = WeighIn(Id(f.id, this), f.optionalDouble("kg"), f.optionalInstant("recordedAt"))
        override val checks = listOf(
            Check.key<WeighIn> { value, moment ->
                val day = value.day ?: throw Violation(WeighInRules.dayRule, Path("id"), Violation.Reason.Custom("notADay"))
                if (day > WeighInRules.latestDay(moment)) throw Violation(WeighInRules.dayRule, Path("id"), Violation.Reason.Custom("future"))
            },
            Check<WeighIn>("kg") { value, _ ->
                val kg = value.kg ?: throw Violation(WeighInRules.kg.path, Path("kg"), Violation.Reason.NotANumber)
                value.copy(kg = WeighInRules.kg.apply(kg, Path("kg")))
            },
        )
    }
}

object WeighInRules {
    val kg = NumberSpec("weighin.kg", 20.0, 400.0, quantum = 0.01)
    const val dayRule = "weighin.day"
    fun latestDay(moment: Moment) = moment.today
    val rules = listOf(Rule.local(kg), Rule.local(dayRule, WeighIn.type, listOf(RefusalCode(Gym.Codes.badInstant))))
}

data class Bodyweight(val stance: Stance, val entries: List<Entry>, val today: LocalDay) {
    enum class Stance { unknown, empty, holding }
    data class Entry(val day: LocalDay, val kg: Double)
    data class Reading(val entry: Entry, val daysAgo: Long)
    enum class Window { recent, all }
    data class Gap(val after: LocalDay, val before: LocalDay)
    data class Chart(val window: Window, val dots: List<Entry>, val gaps: List<Gap>)

    constructor(stored: List<WeighIn>, drawn: List<WeighIn>, firstPullComplete: Boolean, moment: Moment) : this(
        if (stored.isNotEmpty()) Stance.holding else if (firstPullComplete) Stance.empty else Stance.unknown,
        drawn.mapNotNull { value -> value.day?.let { day -> value.kg?.let { Entry(day, it) } } }
            .filter { it.day <= moment.today }.sortedBy { it.day }, moment.today,
    )
    constructor(read: Reader) : this(read.repository(WeighIn).all(ViewMode.stored), read.repository(WeighIn).all(ViewMode.drawn), read.firstPullComplete(), read.moment)
    val reading: Reading? get() = entries.lastOrNull()?.let { Reading(it, it.day.daysUntil(today)) }
    fun entry(day: LocalDay): Entry? = entries.firstOrNull { it.day == day }
    fun entries(from: LocalDay?, to: LocalDay?): List<Entry> = entries.filter { (from == null || it.day >= from) && (to == null || it.day <= to) }
    fun chart(window: Window): Chart {
        val dots = if (window == Window.recent) entries(today.adding(1L - recentDays), null) else entries
        return Chart(window, dots, dots.zipWithNext().filter { (a, b) -> a.day.daysUntil(b.day) > gapDays }.map { (a, b) -> Gap(a.day, b.day) })
    }
    companion object { const val gapDays = 7; const val recentDays = 90 }
}

fun saveWeighIn(value: WeighIn) = SaveDraft(value, WeighIn, GymRefusal)
fun deleteWeighIn(id: Id<WeighIn>) = Remove(WeighIn, id, GymRefusal)
