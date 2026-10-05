package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

data class Preferences(override val id: Id<Preferences> = Id("prefs", Companion), val units: String = Gym.Defaults.Prefs.units,
    val confirmHaptic: Boolean = Gym.Defaults.Prefs.confirmHaptic, val confirmSound: Boolean = Gym.Defaults.Prefs.confirmSound) : Writable<Preferences> {
    override fun fields(): Map<String, Json> = mapOf("units" to Json.of(units), "confirmHaptic" to Json.of(confirmHaptic), "confirmSound" to Json.of(confirmSound))
    companion object : DraftableType<Preferences> {
        override val type = Gym.Types.prefs
        override val scope = ScopeRef(Gym.scope)
        override val savesGuarded = false
        override fun decode(f: Fields) = Preferences(Id(f.id, this), f.optionalString("units") ?: Gym.Defaults.Prefs.units,
            f.bool("confirmHaptic", Gym.Defaults.Prefs.confirmHaptic), f.bool("confirmSound", Gym.Defaults.Prefs.confirmSound))
        override val checks = listOf(Check<Preferences>("units") { value, _ -> value.copy(units = PreferencesRules.units.apply(value.units, Path("units"))) })
    }
}

data class RestSettings(val seconds: Int? = Gym.Defaults.Prefs.restSeconds?.toInt(), val sound: Boolean = Gym.Defaults.Prefs.restSound) {
    constructor(fields: Fields) : this(fields.optionalInt("restSeconds"), fields.bool("restSound", Gym.Defaults.Prefs.restSound))
}

fun restSettings(read: Reader): RestSettings = read.repository(Preferences).record(Preferences().id, works.windmill.sync.api.ViewMode.drawn)
    ?.let { RestSettings(Fields(it)) } ?: RestSettings()

object PreferencesRules {
    val units = ChoiceSpec("prefs.units", listOf("kg", "lb"))
    val rules = listOf(Rule.local(units))
}

fun savePreferences(value: Preferences) = SaveDraft(value, Preferences, GymRefusal)
