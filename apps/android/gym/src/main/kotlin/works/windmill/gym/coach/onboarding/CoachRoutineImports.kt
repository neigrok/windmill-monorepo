package works.windmill.gym.coach.onboarding

import java.io.IOException
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import works.windmill.domain.kit.*
import works.windmill.gym.presentation.Ids
import works.windmill.gym.domain.sync.*
import works.windmill.gym.store.withGymActionContext
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.sync.core.Sha256
import works.windmill.sync.engine.DeviceValueRewrite
import works.windmill.sync.engine.Engine
import works.windmill.sync.schema.Gym

sealed interface CoachImportOutcome {
    data class Committed(val receipt: CoachImportReceipt) : CoachImportOutcome
    data class Replayed(val receipt: CoachImportReceipt) : CoachImportOutcome
    data class Refused(val refusal: GymRefusal?) : CoachImportOutcome
    data object Failed : CoachImportOutcome
}

class CoachRoutineImports(
    private val engine: Engine,
    private val seat: () -> CoachOnboardingSeat?,
    private val scope: CoroutineScope,
    private val telemetry: Telemetry = Telemetry.None,
    private val mintRoutine: () -> String = Ids::routine,
) {
    private val zone = Zone { at -> ZoneId.systemDefault().rules.getOffset(java.time.Instant.ofEpochMilli(at.ms)).totalSeconds }

    fun receipt(resultId: String): CoachImportReceipt? = engine.read(Routine.scope) {
        it.device(receiptKey(resultId))?.let(CoachImportReceipt::decode)
    }

    suspend fun apply(record: CoachOnboardingRecord, drafts: List<CoachRoutineImport>? = null,
        movements: List<Exercise> = emptyList()): CoachImportOutcome = scope.async(start = CoroutineStart.UNDISPATCHED) {
        telemetry.event("gym_coach_import", mapOf("outcome" to "started"))
        var outcome = "failed"
        try {
            val response = record.response
            if (response == null || response.status != "completed" || response.requestId != record.requestId) {
                outcome = "refused"
                return@async CoachImportOutcome.Refused(null)
            }
            val origin = CoachOnboardingSeat(record.owner, record.replica)
            if (seat() != origin || engine.activeReplica() != record.replica) {
                outcome = "refused"
                return@async CoachImportOutcome.Refused(null)
            }
            withGymActionContext { context ->
                val runner = ActionRunner(engine, engine.registry, zone, context)
                val moment = runner.moment()
                val routines = drafts ?: response.routines.map { routine -> CoachRoutineImport(Id(mintRoutine(), Routine), routine.name,
                    routine.entries.map { entry -> RoutineEntry(Id(entry.exerciseId, Exercise), entry.sets.takeIf { it.isNotEmpty() }
                        ?.map { SetTarget(it.reps, it.weightKg) }, entry.restSeconds) }) }
                val normalized = routines.map { value ->
                    val checked = Valid(Routine(value.id, value.name, entries = value.entries), Routine, at = moment).value
                    value.copy(name = checked.name, entries = checked.entries)
                }
                val custom = movements.map { Valid(it, Exercise, at = moment).value }
                val payload = Json.objectOf("routines" to Json.Arr(normalized.map { Json.objectOf("name" to Json.of(it.name),
                    "entries" to Json.Arr(it.entries.map { entry -> entry.json })) }),
                    "movements" to Json.Arr(custom.sortedBy { it.id }.map { Json.objectOf("id" to it.id.json,
                        "fields" to Json.Obj(it.fields().toList()), "loadCount" to Json.of(it.loadCount)) }))
                val fingerprint = Sha256.hex(payload.jcs.toByteArray(Charsets.UTF_8))
                val action = ImportCoachRoutineBatch(record.replica, response.resultId, fingerprint, receiptKey(response.resultId), normalized, custom)
                val wrapped = object : Action<ImportCoachRoutineBatch.Loaded?, CoachImportReceipt, GymRefusal> {
                    override val scope = action.scope
                    override val refusals = GymRefusal
                    override fun load(read: Reader): ImportCoachRoutineBatch.Loaded? {
                        if (seat() != origin || engine.activeReplica() != record.replica || !read.isAnonymous) return null
                        return action.load(read)
                    }
                    override fun decide(loaded: ImportCoachRoutineBatch.Loaded?, ids: IDSource): Decision<CoachImportReceipt, GymRefusal> {
                        if (loaded == null) throw Violation("coach.import", Path("replica"), Violation.Reason.Custom("seatChanged"))
                        return action.decide(loaded, ids)
                    }
                }
                when (val result = runner.run(wrapped)) {
                    is Outcome.Committed -> { outcome = "committed"; CoachImportOutcome.Committed(result.result) }
                    is Outcome.Unchanged -> { outcome = "replayed"; CoachImportOutcome.Replayed(result.result) }
                    is Outcome.Refused -> { outcome = "refused"; CoachImportOutcome.Refused(result.refusal) }
                }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Violation) { outcome = "refused"; CoachImportOutcome.Refused(null) }
        catch (_: Exception) {
            telemetry.failure("gym.coachOnboarding", IOException("The Coach routines could not be committed."))
            CoachImportOutcome.Failed
        } finally { telemetry.event("gym_coach_import", mapOf("outcome" to outcome)) }
    }.await()

    companion object {
        fun receiptKey(resultId: String): String = ImportCoachRoutineBatch.receiptPrefix +
            Sha256.hex(resultId.toByteArray(Charsets.UTF_8)).take(48)
        val rewriteDeviceValue: DeviceValueRewrite = { product, key, value, type, from, to ->
            val field = when (type) { Gym.Types.routine -> "routines"; Gym.Types.exercise -> "movements"; else -> null }
            if (product != "gym" || !key.startsWith(ImportCoachRoutineBatch.receiptPrefix) || field == null) value
            else Json.Obj(value.obj().map { (name, items) -> name to if (name == field)
                Json.Arr(items.arr().map { if (it == from.json) to.json else it }) else items })
        }
    }
}
