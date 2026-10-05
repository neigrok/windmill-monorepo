package works.windmill.gym.domain.sync

import org.junit.Assert.*
import works.windmill.domain.kit.*
import works.windmill.domain.testing.VectorReader
import works.windmill.domain.testing.VectorRecords
import works.windmill.sync.api.Record
import works.windmill.sync.core.Json
import works.windmill.sync.core.Life
import works.windmill.sync.core.Stamp
import works.windmill.sync.schema.SyncSchema

internal val testMoment = Moment(Instant(1_800_000_000_000L), FixedZone(0))
internal val sessionId = Id("session1", Session)
internal val setId = Id("set00001", TrainingSet)
internal val routineId = Id("routine1", Routine)
internal val proposalId = Id("proposal1", Proposal)
internal val squat = Id("back-squat", Exercise)
internal val bench = Id("bench-press", Exercise)
internal val entry = RoutineEntry(squat, listOf(SetTarget(5, 80.0)), 120)
internal val routine = Routine(routineId, "Lower A", entries = listOf(entry))

internal fun row(type: EntityType<*>, id: works.windmill.sync.core.RecordID, fields: Map<String, Json>, visible: Boolean = true,
    held: Boolean = false, pending: Boolean = false, serials: Map<String, Json> = emptyMap()): Record =
    Record(type.type, id, if (SyncSchema.registry.type(type.type)!!.life) Life(if (visible) "alive" else "dead", Stamp.UNSET) else null,
        Stamp.UNSET, fields, emptyMap(), serials, null, null, visible, pending, held)

internal fun <E : Writable<E>> row(value: E, visible: Boolean = true, held: Boolean = false, pending: Boolean = false): Record =
    row(value.id.entity, value.id.record, value.fields(), visible, held, pending)

internal fun row(value: Session, visible: Boolean = true, held: Boolean = false, pending: Boolean = false): Record =
    row(Session, value.id.record, value.fields(), visible, held, pending)

internal fun proposalRow(value: Proposal, visible: Boolean = true): Record = row(Proposal, value.id.record,
    value.fields() + mapOf("state" to Json.of(value.state), "supersededBy" to (value.supersededBy?.json ?: Json.Null),
        "settledAt" to (value.settledAt?.ms?.let(Json::of) ?: Json.Null)), visible)

internal fun setRow(value: TrainingSet, visible: Boolean = true): Record = row(TrainingSet, value.id.record, value.fields(), visible,
    serials = value.setNumber?.let { mapOf("setNumber" to Json.of(it)) } ?: emptyMap())

internal fun reader(stored: List<Record> = emptyList(), drawn: List<Record> = stored, moment: Moment = testMoment,
    pulled: Boolean = true): Reader = Reader(VectorReader(VectorRecords(drawn, stored), moment.now.ms, pulled = pulled,
        scope = Session.scope, registry = SyncSchema.registry), Session.scope, moment, SyncSchema.registry)

internal fun <L, T> decide(action: Decider<L, T, GymRefusal>, read: Reader = reader()): Decision<T, GymRefusal> =
    action.decision(action.load(read), IDSource(read.source as VectorReader))

internal fun <T> writing(decision: Decision<T, GymRefusal>): Decision.Write<T> {
    assertTrue("Expected a write, got $decision", decision is Decision.Write)
    return decision as Decision.Write<T>
}

internal fun invalid(decision: Decision<*, GymRefusal>, rule: String, path: String, reason: Violation.Reason) {
    val refusal = (decision as? Decision.Refuse)?.refusal as? GymRefusal.Invalid
    assertNotNull("Expected invalid, got $decision", refusal)
    assertEquals(Violation(rule, Path(path), reason).json, refusal!!.violation.json)
}

internal fun invalidValue(rule: String, path: String, reason: Violation.Reason, body: () -> Unit) {
    val violation = try { body(); null } catch (value: Violation) { value }
    assertNotNull("Expected violation $rule", violation)
    assertEquals(Violation(rule, Path(path), reason).json, violation!!.json)
}

internal fun trainingSet(id: Id<TrainingSet> = setId, completedAt: Instant = Instant(testMoment.now.ms - 1000),
    number: Int? = null): TrainingSet = TrainingSet(id, sessionId, squat, 80.0, 5, completedAt = completedAt, setNumber = number)

internal fun session(finishedAt: Instant? = null, closedBy: String? = null): Session =
    Session(sessionId, Instant(testMoment.now.ms - 60_000), finishedAt, closedBy)
