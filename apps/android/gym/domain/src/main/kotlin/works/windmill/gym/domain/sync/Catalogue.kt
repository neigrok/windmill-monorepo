package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

data class Exercise(override val id: Id<Exercise>, val name: String, val pattern: String, val equipment: String,
    val stepKg: Double, val aliases: List<String> = emptyList()) : Writable<Exercise> {
    override fun fields(): Map<String, Json> = mapOf("name" to Json.of(name), "pattern" to Json.of(pattern), "equipment" to Json.of(equipment), "stepKg" to Json.of(stepKg))
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

data class ExerciseName(override val id: Id<ExerciseName>, val name: String?, val aliases: List<String> = emptyList()) : Writable<ExerciseName> {
    override fun fields(): Map<String, Json> = mapOf("name" to (name?.let(Json::of) ?: Json.Null))
    companion object : WritableType<ExerciseName> {
        override val type = Gym.Types.exerciseName
        override val scope = ScopeRef(Gym.scope)
        override fun decode(f: Fields) = ExerciseName(Id(f.id, this), f.optionalString("name"), f.json("aliases")?.orNull()?.let { json ->
                val items = (json as? Json.Arr)?.values ?: throw f.failure("aliases", "not an array")
                items.mapIndexed { index, item -> (item as? Json.Str)?.value ?: throw f.failure("aliases.$index", "not a string") }
            }.orEmpty())
        override val checks = listOf(Check<ExerciseName>("name") { value, _ -> value.copy(name = ExerciseRules.seedName.applyOptional(value.name, Path("name"))) })
    }
}

object ExerciseRules {
    val name = TextSpec("exercise.name", MeasureUnit.chars, 1, 60, trim = true, nfc = true)
    val seedName = TextSpec("exerciseName.name", MeasureUnit.chars, 1, 60, trim = true, nfc = true)
    val pattern = ChoiceSpec("exercise.pattern", listOf("squat", "hinge", "press", "pull", "carry", "core", "isolation"))
    val equipment = ChoiceSpec("exercise.equipment", listOf("barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell"))
    val stepKg = NumberSpec("exercise.stepKg", 0.01, 99.99, quantum = 0.01)
    val rules = listOf(name, seedName, pattern, equipment, stepKg).map(Rule::local)
    fun defaultStepKg(equipment: String): Double = when (equipment) {
        "dumbbell" -> 2.0; "machine" -> 5.0; "kettlebell" -> 4.0; else -> 2.5
    }
    fun renamedAliases(previous: String, next: String, aliases: List<String>): List<String> =
        (listOf(previous) + aliases).filter { it != next }.distinct().take(5)
}

data class Catalogue(val exercises: List<Exercise>) {
    constructor(custom: List<Exercise>, names: List<ExerciseName>) : this(
        (SeedExercises.all.map { seed ->
            val named = names.firstOrNull { it.id.record == seed.id.record }
            if (named == null) seed else seed.copy(name = named.name ?: seed.name, aliases = named.aliases)
        } + custom).sortedWith { a, b -> works.windmill.sync.core.compareBytes(a.name, b.name).takeIf { it != 0 } ?: a.id.compareTo(b.id) },
    )
    constructor(read: Reader, view: ViewMode = ViewMode.drawn) : this(read.repository(Exercise).all(view), read.repository(ExerciseName).all(view))
    fun find(id: Id<Exercise>): Exercise? = exercises.firstOrNull { it.id == id }
    fun search(text: String): List<Exercise> {
        val query = text.lowercase()
        return exercises.filter { it.name.lowercase().contains(query) || it.aliases.any { alias -> alias.lowercase().contains(query) } }
    }
}

class CreateExercise(val value: Exercise) : Action<Moment, Id<Exercise>, GymRefusal> {
    override val scope = Exercise.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = read.moment
    override fun decide(loaded: Moment, ids: IDSource): Decision<Id<Exercise>, GymRefusal> {
        val plan = Plan()
        plan.create(Valid(value, Exercise, at = loaded))
        return Decision.Write(plan, value.id)
    }
}

class RenameExercise(val id: Id<Exercise>, val name: String) : Action<RenameExercise.Loaded, Unit, GymRefusal> {
    data class Loaded(val exercise: Exercise?, val moment: Moment)
    override val scope = Exercise.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = Loaded(Catalogue(read, ViewMode.stored).find(id), read.moment)
    override fun decide(loaded: Loaded, ids: IDSource): Decision<Unit, GymRefusal> {
        val old = loaded.exercise ?: return Decision.Refuse(GymRefusal.of(Refused(works.windmill.sync.core.RefusalCode.unknownRecord, id.ref, path = Refused.Path.predicted)))
        val next = ExerciseRules.name.apply(name, Path("name"))
        if (old.name == next) return Decision.Unchanged(Unit)
        val plan = Plan()
        if (SeedExercises.all.any { it.id == id }) {
            val override = ExerciseName(Id(id.record, ExerciseName), next)
            plan.create(Valid(override, ExerciseName, at = loaded.moment))
        } else plan.update(Valid(old.copy(name = next), Exercise, listOf("name"), loaded.moment))
        return Decision.Write(plan, Unit)
    }
}
