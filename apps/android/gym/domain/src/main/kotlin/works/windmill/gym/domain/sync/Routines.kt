package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.RefusalCode
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
    val entries: List<RoutineEntry> = emptyList(), val revision: Int? = null, val createdEntries: Int? = null, val createdDoor: String? = null) : Writable<Routine> {
    override fun fields(): Map<String, Json> = mapOf("name" to Json.of(name), "position" to Json.of(position), "entries" to Json.Arr(entries.map { it.json }))
    companion object : DraftableType<Routine>, RemovableType<Routine> {
        override val type = Gym.Types.routine
        override val scope = ScopeRef(Gym.scope)
        override val savesGuarded = true
        override val heldRemoval = true
        override fun decode(f: Fields) = Routine(Id(f.id, this), f.string("name"), f.optionalInt("position") ?: 0,
            f.list("entries", RoutineEntry), f.optionalInt("revision"), f.optionalInt("createdEntries"), f.optionalString("createdDoor"))
        fun ordered(routines: List<Routine>): List<Routine> = routines.sortedWith(compareBy({ it.position }, { it.id }))
        override val checks = listOf(
            Check<Routine>("name") { value, _ -> value.copy(name = RoutineRules.name.apply(value.name, Path("name"))) },
            Check<Routine>("position") { value, _ -> value.copy(position = RoutineRules.position.apply(value.position, Path("position"))) },
            Check<Routine>("entries") { value, _ -> value.copy(entries = RoutineRules.entries.apply(value.entries, Path("entries"))) },
        )
    }
}

data class RoutineCreation(override val id: Id<RoutineCreation>, val snapshot: Json? = null) : Entity<RoutineCreation> {
    companion object : EntityType<RoutineCreation> {
        override val type = Gym.Types.routineCreation
        override val scope = ScopeRef(Gym.scope)
        override fun decode(f: Fields) = RoutineCreation(Id(f.id, this), f.json("snapshot")?.orNull())
    }
}

data class PlanSnapshot(val routine: String, val entries: List<RoutineEntry>) {
    constructor(value: Routine) : this(value.name, value.entries)
    val json: Json get() = Json.objectOf("routine" to Json.of(routine), "entries" to Json.Arr(entries.map { it.json }))
    companion object {
        fun decode(json: Json?): PlanSnapshot? {
            if (json == null || json === Json.Null) return null
            val fields = Fields(json)
            return PlanSnapshot(fields.string("routine", ""), fields.optionalList("entries", RoutineEntry).orEmpty())
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

data class RoutineMovementChange(val base: Exercise?, val current: Exercise) {
    init { require(base == null || base.id == current.id) }
    val isDirty: Boolean get() = base == null || base.name != current.name ||
        base.equipment != current.equipment || base.loadCount != current.loadCount
}

class SaveRoutinePlan(val base: Routine, val current: Routine, val isNew: Boolean,
    val movements: List<RoutineMovementChange>) : Action<SaveRoutinePlan.Loaded, Id<Routine>, GymRefusal> {
    init { require(base.id == current.id) }
    data class Loaded(val routine: Routine?, val visible: Boolean, val catalogue: Catalogue,
        val visibleExercises: Set<Id<Exercise>>, val formerNames: Map<String, Json>, val moment: Moment)
    override val scope = Routine.scope
    override val refusals = GymRefusal

    override fun load(read: Reader): Loaded {
        val repository = read.repository(Routine)
        return Loaded(repository.find(current.id, ViewMode.stored), repository.find(current.id, ViewMode.drawn) != null,
            Catalogue(read, ViewMode.stored), Catalogue(read).exercises.map { it.id }.toSet(),
            read.device(Catalogue.formerNamesKey)?.obj().orEmpty(), read.moment)
    }

    override fun decide(loaded: Loaded, ids: IDSource): Decision<Id<Routine>, GymRefusal> {
        if (isNew && loaded.routine != null)
            return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.idTaken, current.id.ref, path = Refused.Path.predicted)))
        if (!isNew && (!loaded.visible || loaded.routine == null))
            return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, current.id.ref, path = Refused.Path.predicted)))
        val touched = current.fields().keys.filter { isNew || current.fields()[it] != base.fields()[it] }.sorted()
        val valid = Valid(current, Routine, touched, loaded.moment)
        val changed = touched.filter { loaded.routine?.fields()?.get(it) != valid.value.fields()[it] }
        if (!isNew && changed.any { loaded.routine?.fields()?.get(it) != base.fields()[it] })
            return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.stale, current.id.ref, path = Refused.Path.predicted)))

        val plan = Plan()
        if (isNew) plan.create(valid)
        else if (changed.isNotEmpty()) plan.update(valid, fields = changed, from = base, guarded = true)
        var wrote = isNew || changed.isNotEmpty()
        val former = loaded.formerNames.toMutableMap()
        val included = current.entries.map { it.exerciseId }.toSet()
        val edits = movements.filter { it.current.id in included }.sortedBy { it.current.id }
        require(edits.map { it.current.id }.distinct().size == edits.size)
        for (edit in edits) {
            val next = Valid(edit.current, Exercise, at = loaded.moment).value
            val before = edit.base
            if (before == null) {
                if (loaded.catalogue.find(next.id) != null)
                    return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.idTaken, next.id.ref, path = Refused.Path.predicted)))
                plan.create(Valid(next, Exercise, at = loaded.moment))
                if (next.equipment == "dumbbell" && next.loadCount != 2)
                    plan.create(Valid(ExerciseName(Id(next.id.record, ExerciseName), null, loadCount = next.loadCount),
                        ExerciseName, at = loaded.moment), fields = listOf("loadCount"))
                wrote = true
                continue
            }
            val stored = loaded.catalogue.find(next.id)
            if (stored == null || next.id !in loaded.visibleExercises)
                return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.unknownRecord, next.id.ref, path = Refused.Path.predicted)))
            val targetsChanged = current.entries.firstOrNull { it.exerciseId == next.id }?.sets !=
                base.entries.firstOrNull { it.exerciseId == next.id }?.sets
            val unitsChanged = next.equipment != before.equipment || next.loadCount != before.loadCount
            val unitsSettled = next.equipment == stored.equipment && next.loadCount == stored.loadCount
            if ((targetsChanged || unitsChanged) && !unitsSettled &&
                (stored.equipment != before.equipment || stored.loadCount != before.loadCount))
                return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.stale, next.id.ref, path = Refused.Path.predicted)))
            val seed = SeedExercises.all.any { it.id == next.id }
            if (targetsChanged || unitsChanged) {
                plan.guardRead(Id(next.id.record, ExerciseName), listOf("equipment", "loadCount"))
                if (!seed) plan.guardRead(next.id, listOf("equipment"))
            }
            val renamed = next.name != before.name && next.name != stored.name
            val equipped = next.equipment != before.equipment && next.equipment != stored.equipment
            val counted = next.loadCount != before.loadCount && next.loadCount != stored.loadCount
            if ((renamed && stored.name != before.name) || (equipped && stored.equipment != before.equipment) ||
                (counted && stored.loadCount != before.loadCount))
                return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.stale, next.id.ref, path = Refused.Path.predicted)))
            val metadata = ExerciseName(Id(next.id.record, ExerciseName), if (seed && renamed) next.name else null,
                equipment = if (equipped) next.equipment else null,
                loadCount = if (next.equipment == "dumbbell" && (equipped || counted)) next.loadCount else null)
            if (renamed) {
                former[next.id.record.toString()] = Json.objectOf("name" to Json.of(next.name),
                    "aliases" to Json.Arr(ExerciseRules.renamedAliases(stored.name, next.name, stored.aliases).map(Json::of)))
                if (!seed) plan.update(Valid(stored.copy(name = next.name), Exercise, listOf("name"), loaded.moment),
                    from = stored, guarded = true)
                wrote = true
            }
            val fields = metadata.fields().keys.sorted()
            if (fields.isNotEmpty()) {
                plan.guardRead(metadata.id, fields)
                plan.create(Valid(metadata, ExerciseName, fields, loaded.moment), fields = fields)
                wrote = true
            }
        }
        if (former != loaded.formerNames) plan.device(Catalogue.formerNamesKey, Json.Obj(former.toList()))
        return if (wrote) Decision.Write(plan, current.id) else Decision.Unchanged(current.id)
    }
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
