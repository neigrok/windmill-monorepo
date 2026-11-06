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

// The anonymous seat a retained answer was had on: its routines are saved only on that replica.
data class CoachOnboardingSeat(val owner: String, val replica: String)

sealed interface CoachImportOutcome {
    data class Committed(val receipt: CoachImportReceipt) : CoachImportOutcome
    data class Replayed(val receipt: CoachImportReceipt) : CoachImportOutcome
    data object Refused : CoachImportOutcome
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

    // A retained answer's routines, in one gesture on the replica it was had on: a second save replays the first by the answer's result identity.
    suspend fun apply(record: CoachOnboardingRecord): CoachImportOutcome = scope.async(start = CoroutineStart.UNDISPATCHED) {
        telemetry.event("gym_coach_import", mapOf("outcome" to "started"))
        var outcome = "failed"
        try {
            val response = record.response
            if (response == null || response.status != "completed" || response.requestId != record.requestId) {
                outcome = "refused"
                return@async CoachImportOutcome.Refused
            }
            val origin = CoachOnboardingSeat(record.owner, record.replica)
            if (seat() != origin || engine.activeReplica() != record.replica) {
                outcome = "refused"
                return@async CoachImportOutcome.Refused
            }
            withGymActionContext { context ->
                val runner = ActionRunner(engine, engine.registry, zone, context)
                val moment = runner.moment()
                val normalized = response.routines.map { routine ->
                    val entries = routine.entries.map { entry -> RoutineEntry(Id(entry.exerciseId, Exercise), entry.sets.takeIf { it.isNotEmpty() }?.map { SetTarget(it.reps, it.weightKg) }, entry.restSeconds) }
                    val checked = Valid(Routine(Id(mintRoutine(), Routine), routine.name, entries = entries), Routine, at = moment).value
                    CoachRoutineImport(checked.id, checked.name, checked.entries)
                }
                val payload = Json.objectOf("routines" to Json.Arr(normalized.map { Json.objectOf("name" to Json.of(it.name),
                    "entries" to Json.Arr(it.entries.map { entry -> entry.json })) }), "movements" to Json.Arr(emptyList()))
                val fingerprint = Sha256.hex(payload.jcs.toByteArray(Charsets.UTF_8))
                val action = ImportCoachRoutineBatch(record.replica, response.resultId, fingerprint, receiptKey(response.resultId), normalized)
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
                    is Outcome.Refused -> { outcome = "refused"; CoachImportOutcome.Refused }
                }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Violation) { outcome = "refused"; CoachImportOutcome.Refused }
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
