package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

data class Exercise(override val id: Id<Exercise>, val name: String, val pattern: String, val equipment: String,
    val stepKg: Double, val aliases: List<String> = emptyList(),
    val loadCount: Int = ExerciseRules.defaultLoadCount(equipment, id.record.string)) : Writable<Exercise> {
    override fun fields(): Map<String, Json> = mapOf("name" to Json.of(name), "pattern" to Json.of(pattern), "equipment" to Json.of(equipment), "stepKg" to Json.of(stepKg))
    val loadFloor: Double? get() = ExerciseRules.loadFloor(equipment, loadCount)
    fun floored(weightKg: Double, rule: String, at: Path): Double {
        val floor = loadFloor ?: return weightKg
        if (weightKg < floor) throw Violation(rule, at, Violation.Reason.Below(floor))
        return weightKg
    }
    companion object : WritableType<Exercise> {
        override val type = Gym.Types.exercise
        override val scope = ScopeRef(Gym.scope)
        override fun decode(f: Fields) = Exercise(Id(f.id, this), f.string("name"), f.string("pattern"), f.string("equipment"),
            f.double("stepKg"), f.json("aliases")?.orNull()?.let { json ->
                val items = (json as? Json.Arr)?.values ?: throw f.failure("aliases", "not an array")
                items.mapIndexed { index, item -> (item as? Json.Str)?.value ?: throw f.failure("aliases.$index", "not a string") }
            }.orEmpty())
        override val checks = listOf(
            Check<Exercise>("name") { value, _ -> value.copy(name = ExerciseRules.name.apply(value.name, Path("name"))) },
            Check<Exercise>("pattern") { value, _ -> value.copy(pattern = ExerciseRules.pattern.apply(value.pattern, Path("pattern"))) },
            Check<Exercise>("equipment") { value, _ -> value.copy(equipment = ExerciseRules.equipment.apply(value.equipment, Path("equipment"))) },
            Check<Exercise>("stepKg") { value, _ -> value.copy(stepKg = ExerciseRules.stepKg.apply(value.stepKg, Path("stepKg"))) },
        )
    }
}

data class ExerciseName(override val id: Id<ExerciseName>, val name: String?, val aliases: List<String> = emptyList(),
    val equipment: String? = null, val loadCount: Int? = null) : Writable<ExerciseName> {
    override fun fields(): Map<String, Json> = buildMap {
        name?.let { put("name", Json.of(it)) }
        equipment?.let { put("equipment", Json.of(it)) }
        loadCount?.let { put("loadCount", Json.of(it)) }
    }
    companion object : WritableType<ExerciseName> {
        override val type = Gym.Types.exerciseName
        override val scope = ScopeRef(Gym.scope)
        override fun decode(f: Fields) = ExerciseName(Id(f.id, this), f.optionalString("name"), f.json("aliases")?.orNull()?.let { json ->
                val items = (json as? Json.Arr)?.values ?: throw f.failure("aliases", "not an array")
                items.mapIndexed { index, item -> (item as? Json.Str)?.value ?: throw f.failure("aliases.$index", "not a string") }
            }.orEmpty(), f.optionalString("equipment"), f.optionalInt("loadCount"))
        override val checks = listOf(Check<ExerciseName>("name") { value, _ -> value.copy(name = ExerciseRules.seedName.applyOptional(value.name, Path("name"))) },
            Check<ExerciseName>("equipment") { value, _ -> value.copy(equipment = ExerciseRules.equipmentOverride.applyOptional(value.equipment, Path("equipment"))) },
            Check<ExerciseName>("loadCount") { value, _ -> value.copy(loadCount = ExerciseRules.loadCount.applyOptional(value.loadCount, Path("loadCount"))) })
    }
}

object ExerciseRules {
    val name = TextSpec("exercise.name", MeasureUnit.chars, 1, 60, trim = true, nfc = true)
    val seedName = TextSpec("exerciseName.name", MeasureUnit.chars, 1, 60, trim = true, nfc = true)
    val pattern = ChoiceSpec("exercise.pattern", listOf("squat", "hinge", "press", "pull", "carry", "core", "isolation"))
    val equipment = ChoiceSpec("exercise.equipment", listOf("barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell", "other"))
    val equipmentOverride = ChoiceSpec("exerciseName.equipment", listOf("barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell", "other"))
    val loadCount = NumberSpec("exerciseName.loadCount", 1.0, 2.0, integer = true)
    val stepKg = NumberSpec("exercise.stepKg", 0.01, 99.99, quantum = 0.01)
    val rules = listOf(name, seedName, pattern, equipment, equipmentOverride, loadCount, stepKg).map(Rule::local)
    fun defaultLoadCount(equipment: String, id: String?): Int =
        if (equipment == "dumbbell" && id !in listOf("goblet-squat", "dumbbell-row", "suitcase-carry", "overhead-triceps-extension")) 2 else 1
    fun loadingChoice(equipment: String, loadCount: Int): String = when {
        equipment == "barbell" -> "barbell"
        equipment == "dumbbell" && loadCount == 2 -> "dumbbell"
        else -> "other"
    }
    // A barbell or a pair of dumbbells carries 0 or more; every other loading keeps its sign, an assisted machine's included.
    fun loadFloor(equipment: String, loadCount: Int): Double? = if (loadingChoice(equipment, loadCount) == "other") null else 0.0
    fun defaultStepKg(equipment: String): Double = when (equipment) {
        "dumbbell" -> 2.0; "machine" -> 5.0; "kettlebell" -> 4.0; else -> 2.5
    }
    fun renamedAliases(previous: String, next: String, aliases: List<String>): List<String> =
        (listOf(previous) + aliases).filter { it != next }.distinct().take(5)
}

data class Catalogue(val exercises: List<Exercise>) {
    constructor(custom: List<Exercise>, names: List<ExerciseName>, formerNames: Map<String, Json> = emptyMap()) : this(
        (SeedExercises.all + custom).map { exercise ->
            val override = names.firstOrNull { it.id.record == exercise.id.record }
            val resolved = if (override == null) exercise else {
                val seed = SeedExercises.all.any { it.id == exercise.id }
                val equipment = override.equipment ?: exercise.equipment
                exercise.copy(name = if (seed) override.name ?: exercise.name else exercise.name,
                    aliases = if (seed) override.aliases else exercise.aliases, equipment = equipment,
                    loadCount = if (equipment == "dumbbell") override.loadCount ?: ExerciseRules.defaultLoadCount(equipment, exercise.id.record.string) else 1)
            }
            val former = formerNames[exercise.id.record.toString()]
            if (former == null || former.member("name").str() != resolved.name) resolved
            else resolved.copy(aliases = ExerciseRules.renamedAliases(resolved.name, resolved.name,
                former.member("aliases").arr().map { it.str() } + resolved.aliases))
        }.sortedWith { a, b -> works.windmill.sync.core.compareBytes(a.name, b.name).takeIf { it != 0 } ?: a.id.compareTo(b.id) },
    )
    constructor(read: Reader, view: ViewMode = ViewMode.drawn) : this(read.repository(Exercise).all(view),
        read.repository(ExerciseName).all(view), read.device(formerNamesKey)?.obj().orEmpty())
    fun find(id: Id<Exercise>): Exercise? = exercises.firstOrNull { it.id == id }
    fun search(text: String): List<Exercise> {
        val query = text.lowercase()
        return exercises.filter { it.name.lowercase().contains(query) || it.aliases.any { alias -> alias.lowercase().contains(query) } }
    }
    companion object { const val formerNamesKey = "rack:catalogue" }
}

class CreateExercise(val value: Exercise) : Action<Moment, Id<Exercise>, GymRefusal> {
    override val scope = Exercise.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = read.moment
    override fun decide(loaded: Moment, ids: IDSource): Decision<Id<Exercise>, GymRefusal> {
        val plan = Plan()
        plan.create(Valid(value, Exercise, at = loaded))
        if (value.equipment == "dumbbell" && value.loadCount != ExerciseRules.defaultLoadCount(value.equipment, value.id.record.string))
            plan.create(Valid(ExerciseName(Id(value.id.record, ExerciseName), null, loadCount = value.loadCount), ExerciseName, at = loaded))
        return Decision.Write(plan, value.id)
    }
}

class RenameExercise(val id: Id<Exercise>, val name: String) : Action<RenameExercise.Loaded, Unit, GymRefusal> {
    data class Loaded(val exercise: Exercise?, val override: ExerciseName?, val moment: Moment)
    override val scope = Exercise.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = Loaded(Catalogue(read, ViewMode.stored).find(id), read.repository(ExerciseName).find(Id(id.record, ExerciseName), ViewMode.stored), read.moment)
    override fun decide(loaded: Loaded, ids: IDSource): Decision<Unit, GymRefusal> {
        val old = loaded.exercise ?: return Decision.Refuse(GymRefusal.of(Refused(works.windmill.sync.core.RefusalCode.unknownRecord, id.ref, path = Refused.Path.predicted)))
        val next = ExerciseRules.name.apply(name, Path("name"))
        if (old.name == next) return Decision.Unchanged(Unit)
        val plan = Plan()
        if (SeedExercises.all.any { it.id == id }) {
            val override = (loaded.override ?: ExerciseName(Id(id.record, ExerciseName), null)).copy(name = next)
            if (loaded.override == null) plan.create(Valid(override, ExerciseName, at = loaded.moment))
            else plan.update(Valid(override, ExerciseName, listOf("name"), loaded.moment))
        } else plan.update(Valid(old.copy(name = next), Exercise, listOf("name"), loaded.moment))
        return Decision.Write(plan, Unit)
    }
}

class EditExercise(val base: Exercise, val name: String, val equipment: String, val loadCount: Int) :
    Action<EditExercise.Loaded, Exercise, GymRefusal> {
    data class Loaded(val exercise: Exercise?, val visible: Boolean, val formerNames: Map<String, Json>, val moment: Moment)
    val id get() = base.id
    override val scope = Exercise.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = Loaded(Catalogue(read, ViewMode.stored).find(id), Catalogue(read).find(id) != null,
        read.device(Catalogue.formerNamesKey)?.obj().orEmpty(), read.moment)

    override fun decide(loaded: Loaded, ids: IDSource): Decision<Exercise, GymRefusal> {
        val old = loaded.exercise
        if (old == null || !loaded.visible)
            return Decision.Refuse(GymRefusal.of(Refused(works.windmill.sync.core.RefusalCode.unknownRecord, id.ref, path = Refused.Path.predicted)))
        val nextName = ExerciseRules.name.apply(name, Path("name"))
        val nextEquipment = ExerciseRules.equipment.apply(equipment, Path("equipment"))
        val nextCount = if (nextEquipment == "dumbbell") ExerciseRules.loadCount.apply(loadCount, Path("loadCount")) else 1
        val renamed = nextName != base.name && nextName != old.name
        val unitsChanged = nextEquipment != base.equipment || nextCount != base.loadCount
        val unitsSettled = nextEquipment == old.equipment && nextCount == old.loadCount
        if ((renamed && old.name != base.name) || (unitsChanged && !unitsSettled &&
                (old.equipment != base.equipment || old.loadCount != base.loadCount)))
            return Decision.Refuse(GymRefusal.of(Refused(works.windmill.sync.core.RefusalCode.stale, id.ref, path = Refused.Path.predicted)))
        val equipped = unitsChanged && nextEquipment != old.equipment
        val counted = unitsChanged && nextEquipment == "dumbbell" && (equipped || nextCount != old.loadCount)
        if (!renamed && !equipped && !counted) return Decision.Unchanged(old)
        val seed = SeedExercises.all.any { it.id == id }
        val metadata = ExerciseName(Id(id.record, ExerciseName), if (seed && renamed) nextName else null,
            equipment = if (equipped) nextEquipment else null, loadCount = if (counted) nextCount else null)
        val plan = Plan()
        if (unitsChanged) plan.guardRead(metadata.id, listOf("equipment", "loadCount"))
        val aliases = if (renamed) ExerciseRules.renamedAliases(old.name, nextName, old.aliases + base.aliases) else old.aliases
        if (renamed) {
            if (!seed) plan.update(Valid(old.copy(name = nextName), Exercise, listOf("name"), loaded.moment), from = old, guarded = true)
            val former = loaded.formerNames + (id.record.toString() to Json.objectOf("name" to Json.of(nextName),
                "aliases" to Json.Arr(aliases.map(Json::of))))
            plan.device(Catalogue.formerNamesKey, Json.Obj(former.toList()))
        }
        val fields = metadata.fields().keys.sorted()
        if (fields.isNotEmpty()) {
            plan.guardRead(metadata.id, fields)
            plan.create(Valid(metadata, ExerciseName, fields, loaded.moment), fields = fields)
        }
        return Decision.Write(plan, old.copy(name = if (renamed) nextName else old.name,
            equipment = if (unitsChanged) nextEquipment else old.equipment,
            loadCount = if (unitsChanged) nextCount else old.loadCount, aliases = aliases))
    }
}
