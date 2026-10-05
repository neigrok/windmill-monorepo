package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

data class SetTarget(val reps: Int? = null, val weightKg: Double? = null) : ValueObject<SetTarget> {
    override val json: Json get() = Json.Obj(buildList {
        reps?.let { add("reps" to Json.of(it)) }
        weightKg?.let { add("weightKg" to Json.of(it)) }
    })
    override fun validated(at: Path): SetTarget {
        if (reps == 0) throw Violation("routine.zeroTarget", at + "reps", Violation.Reason.Custom("zeroTarget"))
        val checkedReps = RoutineRules.targetReps.applyOptional(reps, at + "reps")
        val rounded = RoutineRules.targetWeight.applyOptional(weightKg, at + "weightKg")
        if (rounded == 0.0) throw Violation("routine.zeroTarget", at + "weightKg", Violation.Reason.Custom("zeroTarget"))
        return copy(reps = checkedReps, weightKg = rounded)
    }
    companion object : ValueType<SetTarget> {
        override fun decode(f: Fields) = SetTarget(f.optionalInt("reps"), f.optionalDouble("weightKg"))
    }
}

data class RoutineEntry(val exerciseId: Id<Exercise>, val sets: List<SetTarget>? = null, val restSeconds: Int? = null) : ValueObject<RoutineEntry> {
    override val json: Json get() = Json.Obj(buildList {
        add("exerciseId" to exerciseId.json)
        sets?.let { add("sets" to Json.Arr(it.map(SetTarget::json))) }
        restSeconds?.let { add("restSeconds" to Json.of(it)) }
    })
    override fun validated(at: Path): RoutineEntry {
        RoutineRules.exercise.apply(exerciseId.record.string ?: "", at + "exerciseId")
        return copy(sets = RoutineRules.targets.applyOptional(sets, at + "sets"),
            restSeconds = RoutineRules.rest.applyOptional(restSeconds, at + "restSeconds"))
    }
    val isOpen: Boolean get() = sets == null
    companion object : ValueType<RoutineEntry> {
        override fun decode(f: Fields) = RoutineEntry(f.ref("exerciseId", Exercise), f.optionalList("sets", SetTarget), f.optionalInt("restSeconds"))
    }
}

data class Routine(override val id: Id<Routine>, val name: String = "", val position: Int = 0,
    val entries: List<RoutineEntry> = emptyList(), val revision: Int? = null, val createdEntries: Int? = null) : Writable<Routine> {
    override fun fields(): Map<String, Json> = mapOf("name" to Json.of(name), "position" to Json.of(position), "entries" to Json.Arr(entries.map { it.json }))
    companion object : DraftableType<Routine>, RemovableType<Routine> {
        override val type = Gym.Types.routine
        override val scope = ScopeRef(Gym.scope)
        override val savesGuarded = true
        override val heldRemoval = true
        override fun decode(f: Fields) = Routine(Id(f.id, this), f.string("name"), f.optionalInt("position") ?: 0,
            f.list("entries", RoutineEntry), f.optionalInt("revision"), f.optionalInt("createdEntries"))
        override val checks = listOf(
            Check<Routine>("name") { value, _ -> value.copy(name = RoutineRules.name.apply(value.name, Path("name"))) },
            Check<Routine>("position") { value, _ -> value.copy(position = RoutineRules.position.apply(value.position, Path("position"))) },
            Check<Routine>("entries") { value, _ -> value.copy(entries = RoutineRules.entries.apply(value.entries, Path("entries"))) },
        )
    }
}

data class RoutineCreation(override val id: Id<RoutineCreation>, val snapshot: Json) : Entity<RoutineCreation> {
    companion object : EntityType<RoutineCreation> {
        override val type = Gym.Types.routineCreation
        override val scope = ScopeRef(Gym.scope)
        override fun decode(f: Fields) = RoutineCreation(Id(f.id, this), f.present("snapshot"))
    }
}

data class PlanSnapshot(val routine: String, val entries: List<RoutineEntry>) {
    constructor(value: Routine) : this(value.name, value.entries)
    val json: Json get() = Json.objectOf("routine" to Json.of(routine), "entries" to Json.Arr(entries.map { it.json }))
    companion object {
        fun decode(json: Json?): PlanSnapshot? {
            if (json !is Json.Obj) return null
            val name = (json["routine"] as? Json.Str)?.value ?: ""
            val entries = (json["entries"] as? Json.Arr)?.values.orEmpty().mapNotNull { item ->
                if (item !is Json.Obj) return@mapNotNull null
                val exerciseId = (item["exerciseId"] as? Json.Str)?.value ?: return@mapNotNull null
                val rawSets = item["sets"]
                if (rawSets != null && rawSets !is Json.Arr) return@mapNotNull null
                val sets = if (rawSets is Json.Arr) try {
                    rawSets.values.map { SetTarget.decode(Fields(it)).validated(Path("sets")) }.takeIf { it.isNotEmpty() && it.size <= 20 }
                } catch (_: DecodeError) { null } catch (_: Violation) { null } else null
                val rest = (item["restSeconds"] as? Json.Num)?.value?.let { if (it == it.toInt().toDouble() && it.toInt() in 15..900) it.toInt() else null }
                RoutineEntry(Id(exerciseId, Exercise), sets, rest)
            }
            return PlanSnapshot(name, entries)
        }
    }
}

object RoutineRules {
    val name = TextSpec("routine.name", MeasureUnit.chars, 1, 60, trim = true, nfc = true)
    val position = NumberSpec("routine.position", 0.0, Int.MAX_VALUE.toDouble(), integer = true)
    val entries = CountSpec("routine.entries", 1, 50)
    val targets = CountSpec("routine.entries.sets", 1, 20)
    val targetReps = NumberSpec("routine.entries.sets.reps", 1.0, 100.0, integer = true)
    val targetWeight = NumberSpec("routine.entries.sets.weightKg", -500.0, 500.0, quantum = 0.01)
    val rest = NumberSpec("routine.entries.restSeconds", 15.0, 900.0, integer = true)
    val exercise = TextSpec("routine.entries.exerciseId", MeasureUnit.chars, 1, 64, false, false)
    val rules = listOf(name, position, entries, targets, targetReps, targetWeight, rest, exercise).map(Rule::local) + Rule.local("routine.zeroTarget", Routine.type)
}

class ReorderRoutines(val order: List<Id<Routine>>) : Action<ReorderRoutines.Loaded, Unit, GymRefusal> {
    data class Loaded(val routines: List<Routine>, val moment: Moment)
    override val scope = Routine.scope
    override val refusals = GymRefusal
    override fun load(read: Reader) = Loaded(read.repository(Routine).all(works.windmill.sync.api.ViewMode.stored), read.moment)
    override fun decide(loaded: Loaded, ids: IDSource): Decision<Unit, GymRefusal> {
        val routines = loaded.routines
        if (order.size != order.distinct().size || order.toSet() != routines.map { it.id }.toSet())
            throw Violation("routine.order", Path("order"), Violation.Reason.Custom("notPermutation"))
        val plan = Plan()
        for ((position, id) in order.withIndex()) {
            val routine = routines.firstOrNull { it.id == id } ?: error("a reorder requires every named routine")
            if (routine.position != position) plan.update(Valid(routine.copy(position = position), Routine, listOf("position"), loaded.moment))
        }
        if (routines.all { it.position == order.indexOf(it.id) }) return Decision.Unchanged(Unit)
        return Decision.Write(plan, Unit)
    }
}

fun saveRoutine(value: Routine) = SaveDraft(value, Routine, GymRefusal)
fun deleteRoutine(id: Id<Routine>) = Remove(Routine, id, GymRefusal)
