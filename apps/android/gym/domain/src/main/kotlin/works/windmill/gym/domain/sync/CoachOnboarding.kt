package works.windmill.gym.domain.sync

import works.windmill.domain.kit.*
import works.windmill.sync.api.CommitContext
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.schema.Gym

data class CoachRoutineImport(val id: Id<Routine>, val name: String, val entries: List<RoutineEntry>)

data class CoachImportReceipt(val resultId: String, val fingerprint: String,
    val routines: List<Id<Routine>>, val movements: List<Id<Exercise>>) {
    val json: Json get() = Json.objectOf("resultId" to Json.of(resultId), "fingerprint" to Json.of(fingerprint),
        "routines" to Json.Arr(routines.map { it.json }), "movements" to Json.Arr(movements.map { it.json }))
    companion object {
        fun decode(value: Json): CoachImportReceipt {
            return CoachImportReceipt(value.member("resultId").str(), value.member("fingerprint").str(),
                value.member("routines").arr().map { Id(RecordID(it.str()), Routine) },
                value.member("movements").arr().map { Id(RecordID(it.str()), Exercise) })
        }
    }
}

class ImportCoachRoutineBatch(val replica: String, val resultId: String, val fingerprint: String, val receiptKey: String,
    val routines: List<CoachRoutineImport>, val movements: List<Exercise> = emptyList()) :
    Action<ImportCoachRoutineBatch.Loaded, CoachImportReceipt, GymRefusal> {
    data class Loaded(val replica: String, val receipt: CoachImportReceipt?, val routines: List<Routine>,
        val catalogue: Catalogue, val visibleExercises: Set<Id<Exercise>>, val moment: Moment)

    override val scope = Routine.scope
    override val refusals = GymRefusal

    override fun load(read: Reader) = Loaded((read.source as? CommitContext)?.replica.orEmpty(),
        if (validReceiptKey(receiptKey)) read.device(receiptKey)?.let(CoachImportReceipt::decode) else null,
        read.repository(Routine).all(ViewMode.stored),
        Catalogue(read, ViewMode.stored), Catalogue(read).exercises.map { it.id }.toSet(), read.moment)

    override fun decide(loaded: Loaded, ids: IDSource): Decision<CoachImportReceipt, GymRefusal> {
        if (loaded.replica != replica)
            throw Violation("coach.import", Path("replica"), Violation.Reason.Custom("seatChanged"))
        if (resultId.isEmpty() || resultId.length > 128 || resultId.any { it.code !in 33..126 } ||
            fingerprint.length != 64 || fingerprint.any { it !in '0'..'9' && it !in 'a'..'f' })
            throw Violation("coach.import", Path("resultId"), Violation.Reason.Custom("invalidResult"))
        if (!validReceiptKey(receiptKey))
            throw Violation("coach.import", Path("receiptKey"), Violation.Reason.Custom("invalidReceiptKey"))
        loaded.receipt?.let { receipt ->
            if (receipt.resultId != resultId || receipt.fingerprint != fingerprint)
                throw Violation("coach.import", Path("resultId"), Violation.Reason.Custom("payloadConflict"))
            return Decision.Unchanged(receipt)
        }
        if (routines.size !in 1..3 || routines.any { it.entries.size !in 1..6 || it.entries.any { entry -> (entry.sets?.size ?: 0) > 8 } })
            throw Violation("coach.import", Path("routines"), Violation.Reason.Custom("invalidCount"))
        if (routines.map { it.id }.distinct().size != routines.size || movements.map { it.id }.distinct().size != movements.size)
            throw Violation("coach.import", Path("routines"), Violation.Reason.Custom("duplicateIdentity"))
        val included = routines.flatMap { it.entries }.map { it.exerciseId }.toSet()
        if (movements.any { it.id !in included })
            throw Violation("coach.import", Path("movements"), Violation.Reason.Custom("unusedMovement"))
        val plan = Plan()
        for (movement in movements.sortedBy { it.id }) {
            if (loaded.catalogue.find(movement.id) != null)
                return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.idTaken, movement.id.ref, path = Refused.Path.predicted)))
            plan.createRoutineMovement(Valid(movement, Exercise, at = loaded.moment), loaded.moment)
        }
        val known = loaded.visibleExercises + movements.map { it.id }
        val firstPosition = (loaded.routines.maxOfOrNull { it.position } ?: -1).toLong() + 1
        for ((index, routine) in routines.withIndex()) {
            if (loaded.routines.any { it.id == routine.id })
                return Decision.Refuse(GymRefusal.of(Refused(RefusalCode.idTaken, routine.id.ref, path = Refused.Path.predicted)))
            if (routine.entries.any { it.exerciseId !in known })
                return Decision.Refuse(GymRefusal.predicted(Gym.Codes.unknownExercise, routine.id.ref))
            val position = firstPosition + index
            if (position > Int.MAX_VALUE)
                throw Violation("coach.import", Path("routines"), Violation.Reason.Custom("positionExhausted"))
            plan.create(Valid(Routine(routine.id, routine.name, position.toInt(), routine.entries), Routine, at = loaded.moment))
        }
        val receipt = CoachImportReceipt(resultId, fingerprint, routines.map { it.id }, movements.map { it.id })
        plan.device(receiptKey, receipt.json)
        return Decision.Write(plan, receipt)
    }

    companion object {
        const val receiptPrefix = "rack:coachImport"
        fun validReceiptKey(value: String): Boolean = value.startsWith(receiptPrefix) && value.length == receiptPrefix.length + 48 &&
            value.drop(receiptPrefix.length).all { it in '0'..'9' || it in 'a'..'f' }
    }
}
