package works.windmill.gym.store

import kotlinx.serialization.Serializable
import works.windmill.domain.kit.*
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.WorkoutEvent
import works.windmill.gym.domain.sync.ImportSession
import works.windmill.gym.domain.sync.ImportedSet
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.sync.api.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.PushResult
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.RecordKey
import works.windmill.sync.core.Sha256
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.DeviceValueRewrite
import works.windmill.sync.engine.confirmedRecords
import works.windmill.sync.engine.commitWithPrerequisites
import works.windmill.sync.engine.unsubmittedGestures
import works.windmill.sync.engine.reconcileConfirmedCommand
import works.windmill.sync.schema.Gym
import works.windmill.gym.domain.sync.Session as SyncSession
import works.windmill.gym.domain.sync.TrainingSet as SyncSet
import works.windmill.gym.domain.sync.Exercise as SyncExercise
import works.windmill.gym.domain.sync.Routine as SyncRoutine

// A workout this phone holds for an account: the journal keeps it exactly as it was saved, with the
// ids of sets deleted off it.
@Serializable
data class SavedWorkout(
    val session: Session,
    val sets: List<TrainingSet> = emptyList(),
    val deleted: List<String> = emptyList(),
)

// One set an unfinished workout still owes the account, replayed under its own id once the
// workout's start is confirmed.
@Serializable
data class OwedSet(
    val set: TrainingSet,
    val sessionId: String,
    val needsPush: Boolean,
    val remints: Int,
    val loggedAtMs: Long? = null,
    val event: WorkoutEvent? = null,
    val eventOrder: Long = 0,
    val attempted: Boolean = false,
    val write: Owed = Owed.Append,
) {
    val step: Owed get() = if (attempted) Owed.Append else write
}

// What an owed set asks of the account.
@Serializable
enum class Owed {
    Append,     // the account has never seen this row
    Fix,        // the account holds this row, and this phone holds numbers it does not
    Delete,     // the account holds this row, and this phone has taken it back
}

data class ImportRefusal(val id: String, val session: Session?, val sets: List<TrainingSet>,
    val deletedSetIds: List<String>, val code: String, val reason: String, val unrecognizedKindSetIds: List<String> = emptyList())

data class ImportOperation(val token: String, val sessionId: String, val entry: OwedSet)
data class ImportDeletion(val token: String, val sessionId: String, val setId: String)

// Signed-out training prepared for an account at sign-in. Each finished workout becomes one strict
// import and an unfinished one a start whose sets follow it; a refused workout stays on this phone,
// inspectable and correctable, until it is kept, retried or discarded.
class WorkoutImports(private val engine: Engine) {
    private data class Item(val seat: String, val kind: String, val id: String, val payload: Json, val sourceSeat: String = seat) {
        val token = Sha256.hex(Json.array(Json.of(seat), Json.of(sourceSeat), Json.of(kind), Json.of(id), payload).jcs.toByteArray())
    }

    fun prepare(row: SavedWorkout) {
        if (row.session.isOpen) retain(row, finished = false) else retain(row, finished = true)
    }

    private fun retain(row: SavedWorkout, finished: Boolean) {
        val result = engine.commitWithPrerequisites(scope) { context ->
            check(context.isAnonymous) { "Only training saved on this phone can be prepared for an account." }
            val key = key("engine:${context.replica}")
            val journal = journal(context, key)
            val items = journal["items"]?.obj().orEmpty().toMutableMap()
            val kind = if (finished) "finished" else "start"
            val previous = context.devices(journalPrefix).values.flatMap { it["items"]?.obj().orEmpty().values }.firstOrNull {
                it["id"] == Json.of(row.session.id) && it["kind"] == Json.of(kind) && it["state"] !in setOf(Json.of("resolved"), Json.of("discarded"))
            }
            val priorStart = context.devices(journalPrefix).values.flatMap { it["items"]?.obj().orEmpty().values }.firstOrNull {
                it["id"] == Json.of(row.session.id) && it["kind"] == Json.of("start") && it["state"] !in setOf(Json.of("discarded"), Json.of("resolved"))
            }?.get("source")
            val source = if (finished) {
                val typed = Json.parse(snapshotJson.encodeToString(SavedWorkout.serializer(), row))
                val old = previous?.get("source") ?: priorStart?.let { queue -> Json.objectOf("session" to queue.member("session"),
                    "sets" to Json.Arr(queue["entries"]?.obj().orEmpty().values.filter { decode(it, OwedSet.serializer()).write != Owed.Delete }.map { it.member("set") }),
                    "deleted" to Json.Arr(queue["entries"]?.obj().orEmpty().values.filter { decode(it, OwedSet.serializer()).write == Owed.Delete }.map { it.member("set").member("id") })) }
                val saved = old?.get("sets")?.arr().orEmpty().associateBy { it.member("id").str() }
                (old ?: typed).changed("session" to (old?.get("session") ?: typed.member("session")).changed(*typed.member("session").obj()
                    .filterKeys { it != "plan" || old == null || !unknownFinishedFields(old) }.map { it.key to it.value }.toTypedArray()),
                    "sets" to Json.Arr(typed.member("sets").arr().map { set ->
                        val original = saved[set.member("id").str()]
                        (original ?: set).changed(*set.obj().filterKeys { it != "kind" || original == null || !unknownKind(original) }.map { it.key to it.value }.toTypedArray())
                    }),
                    "deleted" to Json.Arr((old?.get("deleted")?.arr().orEmpty() + row.deleted.map(Json::of) +
                        context.devices("rack:deletedSet").values.filter { it["sessionId"] == Json.of(row.session.id) }.map { it.member("setId") }).distinct().sortedBy(Json::str)))
            } else {
                val entries = priorStart?.get("entries")?.obj().orEmpty().toMutableMap()
                row.sets.forEach { set ->
                    val saved = entries[set.id]
                    if (saved == null) entries[set.id] = Json.parse(snapshotJson.encodeToString(OwedSet.serializer(), OwedSet(set, row.session.id, true, 0)))
                    else if (decode(saved, OwedSet.serializer()).set != set && !unknownKind(saved.member("set"))) {
                        val previousEntry = decode(saved, OwedSet.serializer())
                        val typed = Json.parse(snapshotJson.encodeToString(OwedSet.serializer(), previousEntry.copy(set = set, needsPush = true, write = if (previousEntry.attempted) Owed.Fix else Owed.Append)))
                        entries[set.id] = saved.changed("set" to saved.member("set").changed(*typed.member("set").obj().map { it.key to it.value }.toTypedArray()),
                            "needsPush" to Json.of(true), "write" to typed["write"])
                    }
                }
                val typedSession = Json.parse(snapshotJson.encodeToString(Session.serializer(), row.session))
                val history = priorStart?.let { Json.objectOf("session" to it.member("session"), "sets" to Json.Arr(entries.values.map { value -> value.member("set") })) }
                (priorStart ?: Json.objectOf()).changed("session" to (priorStart?.get("session") ?: typedSession).changed(*typedSession.obj()
                    .filterKeys { it != "plan" || history == null || !unknownFinishedFields(history) }.map { it.key to it.value }.toTypedArray()), "entries" to Json.Obj(entries.toList()))
            }
            if (previous?.get("source") == source) return@commitWithPrerequisites null to null
            val records = (row.sets.map { RecordKey(Gym.Types.set, RecordID(it.id)) } + row.deleted.map { RecordKey(Gym.Types.set, RecordID(it)) } +
                context.devices("rack:deletedSet").values.filter { it["sessionId"] == Json.of(row.session.id) }.map { RecordKey(Gym.Types.set, RecordID(it.member("setId").str())) } +
                source["entries"]?.obj().orEmpty().keys.map { RecordKey(Gym.Types.set, RecordID(it)) } +
                listOf(RecordKey(Gym.Types.session, RecordID(row.session.id)))).toSet()
            val supersede = engine.unsubmittedGestures(context, scope, records)
            val item = Item(Seat.anonymous, kind, row.session.id, source, sourceSeat = "engine:${context.replica}")
            val gestureId = context.opaqueID()
            var code: String? = null
            val gesture = try { if (finished) imported(source, context, records) else gesture(item, context) }
                catch (refused: RefusedImport) { code = refused.code; Gesture(emptyList()) }
                catch (_: Exception) { code = "source-needs-correction"; Gesture(emptyList()) }
            gesture.gestureId = gestureId; gesture.supersede = supersede
            items[item.token] = Json.objectOf("id" to Json.of(item.id), "kind" to Json.of(kind), "seat" to Json.of(Seat.anonymous),
                "sourceSeat" to Json.of(item.sourceSeat), "source" to source, "state" to Json.of(if (code == "waiting-for-firstpull") "pending" else if (code != null) "refused" else "queued"), "gestureId" to Json.of(gestureId))
                .changed("code" to code?.let(Json::of), "original" to (previous?.get("original") ?: previous?.get("source") ?: priorStart))
            for ((otherKey, otherJournal) in context.devices(journalPrefix)) {
                val before = otherJournal["items"]?.obj().orEmpty()
                val changed = before.mapValues { (_, old) ->
                    if (old["id"] == Json.of(row.session.id) && old["kind"] in setOf(Json.of("start"), Json.of("finished")) ||
                        old["kind"] == Json.of("operation") && old["source"]?.get("sessionId") == Json.of(row.session.id)) old.changed("state" to Json.of("resolved")) else old
                }
                if (otherKey == key) items.putAll(changed)
                else if (before != changed) gesture.local += DeviceWrite(otherKey, withItems(otherJournal, changed))
            }
            if (!finished) for ((id, entry) in source.member("entries").obj()) {
                val operation = Item(Seat.anonymous, "operation", id, entry, sourceSeat = item.sourceSeat)
                items[operation.token] = Json.objectOf("id" to Json.of(id), "kind" to Json.of("operation"), "seat" to Json.of(Seat.anonymous),
                    "sourceSeat" to Json.of(item.sourceSeat), "source" to entry, "state" to Json.of("pending"))
            }
            gesture.local += DeviceWrite(key, withItems(journal, items))
            gesture to Triple(key, item.token, gesture)
        }
        retainRejected(result)
    }

    private fun retainRejected(result: Pair<CommitOutcome?, Triple<String, String, Gesture>?>) {
        val rejected = result.first as? CommitOutcome.Refused ?: return
        val prepared = result.second ?: return
        engine.commitWithPrerequisites(scope) { context ->
            val (key, token, originalGesture) = prepared
            val writes = originalGesture.local.map { write ->
                if (!write.key.startsWith(journalPrefix) || write.value == null) write else {
                    val journal = journal(context, write.key)
                    val items = journal["items"]?.obj().orEmpty() + write.value!!.member("items").obj().mapValues { (itemToken, value) ->
                        if (write.key == key && itemToken == token) value.changed("state" to Json.of("refused"), "code" to Json.of(rejected.code.text)) else value
                    }
                    DeviceWrite(write.key, withItems(journal, items))
                }
            }
            Gesture(emptyList(), supersede = originalGesture.supersede, local = writes) to Unit
        }
    }

    private fun gesture(item: Item, context: CommitContext): Gesture = when (item.kind) {
        "finished" -> imported(item.payload, context)
        "start" -> {
            val authored = Json.objectOf("session" to item.payload.member("session"), "sets" to Json.Arr(item.payload["entries"]?.obj().orEmpty().values.map { it.member("set") }))
            if (unknownFinishedFields(authored)) throw RefusedImport("source-needs-update")
            if (item.payload["entries"]?.obj().orEmpty().values.any { unknownKind(it.member("set")) }) throw RefusedImport("source-kind")
            val session = decode(item.payload.member("session"), Session.serializer())
            val fields = sessionFields(session)
            val known = context.confirmed(Gym.Types.session, RecordID(session.id))?.takeIf { it.isVisible && it.born != null }
            val writes = buildList {
                item.payload["order"]?.takeIf { it is Json.Arr }?.let { add(DeviceWrite("movementOrder:${session.id}", it)) }
                item.payload["chosenMovement"]?.takeIf { it is Json.Str }?.let { add(DeviceWrite("movement:${session.id}", it)) }
                item.payload["workout"]?.takeIf { it is Json.Obj }?.let { add(DeviceWrite("rack:${session.id}", it)) }
            }
            if (known != null) {
                if (known.values["startedAt"] != fields["startedAt"] || (known.values["plan"] ?: Json.Null) != fields["plan"] ||
                    (known.values["historyRoutineId"] ?: known.values["routineId"] ?: Json.Null) != fields["historyRoutineId"]) throw RefusedImport("session-id-taken")
                Gesture(emptyList(), local = writes)
            } else {
                if (session.routineId != null) {
                    if (!context.isAnonymous && (!context.firstPullComplete() || context.checkpoint().cleanSeq == null)) throw RefusedImport("waiting-for-firstpull")
                    val routine = context.drawn(Gym.Types.routine, RecordID(session.routineId))?.takeIf { it.isVisible && it.born != null }
                        ?: throw RefusedImport("routine-missing")
                    val plan = Json.objectOf("routine" to routine.values.getValue("name"), "entries" to routine.values.getValue("entries"))
                    if (plan != fields["plan"]) throw RefusedImport("frozen-plan-changed")
                }
                val args = mutableMapOf("id" to Json.of(session.id), "startedAt" to Json.of(session.startedAtMs), "joinOpenSession" to Json.of(false))
                session.routineId?.let { args["routineId"] = Json.of(it) }
                val predict = Change.create(Gym.Types.session, NewID.Given(RecordID(session.id)), fields)
                Gesture(session.routineId?.let { listOf(Change.update(Gym.Types.routine, RecordID(it))) }.orEmpty(),
                    command = Command(Gym.Commands.start, Json.Obj(args.toList())), predict = listOf(predict), local = writes,
                    guards = session.routineId?.let { id -> listOf("name", "entries").map { field -> RegisterRef(Gym.Types.routine, RecordID(id), field) } }.orEmpty())
            }
        }
        "operation" -> {
            if (unknownKind(item.payload.member("set"))) throw RefusedImport("source-kind")
            Gesture(emptyList())
        }
        else -> Gesture(emptyList())
    }

    private fun imported(source: Json, originalContext: CommitContext, replaced: Set<RecordKey> = emptySet()): Gesture {
        val context = if (replaced.isEmpty()) originalContext else object : CommitContext by originalContext {
            private fun visible(row: Record?) = row?.takeUnless { RecordKey(it.type, it.id) in replaced && originalContext.confirmed(it.type, it.id) == null }
            override fun drawn(type: String, id: RecordID) = visible(originalContext.drawn(type, id))
            override fun stored(type: String, id: RecordID) = visible(originalContext.stored(type, id))
            override fun drawn(type: String) = originalContext.drawn(type).mapNotNull(::visible)
            override fun stored(type: String) = originalContext.stored(type).mapNotNull(::visible)
            override fun drawn(type: String, field: String, id: RecordID) = originalContext.drawn(type, field, id).mapNotNull(::visible)
            override fun stored(type: String, field: String, id: RecordID) = originalContext.stored(type, field, id).mapNotNull(::visible)
        }
        if (unknownFinishedFields(source)) throw RefusedImport("source-needs-update")
        if (source["sets"]?.arr().orEmpty().any { set ->
                set["kind"]?.str()?.let { it !in setOf("warmup", "working", "drop", "failure") } == true
            }) throw RefusedImport("source-kind")
        val row = decode(source, SavedWorkout.serializer())
        val session = row.session
        val finished = session.finishedAtMs ?: throw RefusedImport("bad-instant")
        if (source["session"]?.get("closedItself") == Json.of(true) || source["session"]?.get("closedBy") == Json.of("stale"))
            throw RefusedImport("source-auto-closed")
        if (session.startedAtMs > context.now || finished > context.now) throw RefusedImport("bad-instant")
        if (row.sets.any { it.id in row.deleted }) throw RefusedImport("deleted-set-conflict")
        if (confirmedEquivalent(row, context)) return Gesture(emptyList())
        if (context.drawn(Gym.Types.session, RecordID(session.id)) != null) throw RefusedImport("session-id-taken")
        if (!context.isAnonymous && (!context.firstPullComplete() || context.checkpoint().cleanSeq == null))
            throw RefusedImport("waiting-for-firstpull")
        if (row.sets.size > 200) throw RefusedImport("too-many-sets")
        val numbers = mutableMapOf<String, Int>()
        row.sets.forEach { set ->
            val next = (numbers[set.exerciseId] ?: 0) + 1
            if (set.setNumber != null && set.setNumber != next) throw RefusedImport("source-numbering")
            numbers[set.exerciseId] = next
        }
        val routine = session.routineId?.let { context.drawn(Gym.Types.routine, RecordID(it))?.takeIf { row -> row.isVisible } }
        val currentPlan = routine?.let { Json.objectOf("routine" to it.values.getValue("name"), "entries" to it.values.getValue("entries")) }
        val frozenPlan = sessionFields(session).getValue("plan")
        if ((currentPlan ?: Json.Null) != frozenPlan) throw RefusedImport("frozen-plan-changed")
        if (session.routineId != null && routine == null) throw RefusedImport("routine-missing")
        val reader = Reader(context, scope, Moment(Instant(context.now), FixedZone(0)), works.windmill.sync.schema.SyncSchema.registry)
        val action = ImportSession(Id(session.id, SyncSession), Instant(session.startedAtMs), Instant(finished), row.sets.map { set ->
            val value = SyncSet(Id(set.id, SyncSet), Id(session.id, SyncSession), Id(set.exerciseId, SyncExercise), set.weightKg, set.reps,
                set.kind.wire, set.rpe, set.note, Instant(set.completedAtMs), set.setNumber)
            if (Valid(value, SyncSet, at = reader.moment).value != value) throw RefusedImport("source-needs-correction")
            ImportedSet(value.id, value.exerciseId, value.weightKg, value.reps, value.completedAt, value.kind, value.rpe, value.note, true)
        }, session.routineId?.let { Id(it, SyncRoutine) })
        val loaded = action.load(reader)
        if (loaded.state.overlap(Instant(session.startedAtMs), Instant(finished), Id(session.id, SyncSession)) != null)
            throw RefusedImport("session-overlap")
        return when (val decision = action.decision(loaded, IDSource(context))) {
            is Decision.Write -> decision.plan.gesture(scope, works.windmill.sync.schema.SyncSchema.registry).also { gesture ->
                gesture.atomic = true
                if (session.routineId != null) {
                    gesture.changes += Change.update(Gym.Types.routine, RecordID(session.routineId))
                    gesture.guards += listOf("name", "entries").map { field -> RegisterRef(Gym.Types.routine, RecordID(session.routineId), field) }
                }
                gesture.predict = gesture.predict.map { change -> if (change.type == Gym.Types.session) change.copy(values = sessionFields(session)) else change }
            }
            is Decision.Refuse -> throw RefusedImport(if (decision.refusal is GymRefusal.Invalid) "source-needs-correction" else "bad-instant")
            is Decision.Unchanged -> Gesture(emptyList())
        }
    }

    private fun confirmedEquivalent(source: SavedWorkout, context: CommitContext): Boolean {
        if (context.isAnonymous || !context.firstPullComplete() || context.checkpoint().cleanSeq == null) return false
        val session = context.confirmed(Gym.Types.session, RecordID(source.session.id))?.takeIf { it.isVisible && it.born != null } ?: return false
        val expected = sessionFields(source.session)
        if (listOf("startedAt", "finishedAt", "closedBy", "plan").any { (session.values[it] ?: Json.Null) != expected.getValue(it) }) return false
        val historicalRoutine = session.values["historyRoutineId"] ?: session.values["routineId"] ?: Json.Null
        if (historicalRoutine != expected.getValue("historyRoutineId")) return false
        val sets = engine.confirmedRecords(context, scope, Gym.Types.set).filter { it.isVisible && it.values["sessionId"] == Json.of(source.session.id) }
        if (sets.map { it.id.string }.toSet() != source.sets.map { it.id }.toSet() || sets.size != source.sets.size) return false
        return source.sets.all { original ->
            val set = sets.single { it.id == RecordID(original.id) }
            val f = set.values
            set.born != null && f["exerciseId"] == Json.of(original.exerciseId) && f["weightKg"] == Json.of(original.weightKg) &&
                f["reps"] == Json.of(original.reps) && (f["kind"] ?: Json.of("working")) == Json.of(original.kind.wire) &&
                (f["rpe"] ?: Json.Null) == (original.rpe?.let(Json::of) ?: Json.Null) && (f["note"] ?: Json.of("")) == Json.of(original.note) &&
                f["completedAt"] == Json.of(original.completedAtMs) && (original.setNumber == null || (set.serials["setNumber"] ?: f["setNumber"]) == Json.of(original.setNumber))
        }
    }

    fun operations(): List<ImportOperation> = engine.read(scope) { reader -> reader.devices(journalPrefix).values.flatMap { journal -> journal["items"]?.obj().orEmpty().mapNotNull { (token, item) ->
        if (item.member("kind").str() != "operation" || item.member("state").str() != "pending") return@mapNotNull null
        val entry = decode(item.member("source"), OwedSet.serializer())
        ImportOperation(token, item["targetSessionId"]?.str() ?: entry.sessionId, entry)
    } }.sortedWith(compareBy<ImportOperation>({ it.sessionId }, { it.entry.set.completedAtMs }, { it.entry.set.id }, { it.token })) }

    fun resolveOperation(token: String) { engine.commit(scope) { context ->
        val saved = context.devices(journalPrefix).entries.firstOrNull { token in it.value["items"]?.obj().orEmpty() }
            ?: return@commit null to Unit
        val key = saved.key
        val journal = saved.value
        val items = journal["items"]?.obj().orEmpty().toMutableMap()
        val item = items[token] ?: return@commit null to Unit
        items[token] = item.changed("state" to Json.of("resolved"))
        Gesture(emptyList(), local = listOf(DeviceWrite(key, withItems(journal, items)))) to Unit
    } }

    fun refuseOperation(token: String, code: String) { engine.commit(scope) { context ->
        val saved = context.devices(journalPrefix).entries.firstOrNull { token in it.value["items"]?.obj().orEmpty() }
            ?: return@commit null to Unit
        val items = saved.value["items"]?.obj().orEmpty().toMutableMap()
        val item = items.getValue(token)
        items[token] = item.changed("state" to Json.of("refused"), "code" to Json.of(code))
        Gesture(emptyList(), local = listOf(DeviceWrite(saved.key, withItems(saved.value, items)))) to Unit
    } }

    fun deletedSets(): List<ImportDeletion> = engine.read(scope) { reader ->
        reader.devices(journalPrefix).values.flatMap { journal -> journal["items"]?.obj().orEmpty().flatMap { (token, item) ->
            if (item["kind"] != Json.of("finished") || item["state"] in setOf(Json.of("discarded"), Json.of("resolved"))) emptyList() else item["source"]?.get("deleted")?.arr().orEmpty()
                .filter { it !in item["resolvedDeleted"]?.arr().orEmpty() }.map { id -> ImportDeletion("$token:${id.str()}", item["targetSessionId"]?.str() ?: item.member("id").str(), id.str()) }
        } }
    }

    fun resolveDeletion(token: String) { engine.commit(scope) { context ->
        val itemToken = token.substringBefore(':')
        val id = token.substringAfter(':')
        val saved = context.devices(journalPrefix).entries.firstOrNull { itemToken in it.value["items"]?.obj().orEmpty() }
            ?: return@commit null to Unit
        val items = saved.value["items"]?.obj().orEmpty().toMutableMap()
        val item = items.getValue(itemToken)
        items[itemToken] = item.changed("resolvedDeleted" to Json.Arr((item["resolvedDeleted"]?.arr().orEmpty() + Json.of(id)).distinct()))
        Gesture(emptyList(), local = listOf(DeviceWrite(saved.key, withItems(saved.value, items)))) to Unit
    } }

    // An unfinished workout's saved sets, drawn while the account's first pull has not landed.
    fun startSources(): List<Json> = engine.read(scope) { reader -> reader.devices(journalPrefix).values.flatMap { journal ->
        journal["items"]?.obj().orEmpty().values.filter { it["kind"] == Json.of("start") && it["state"] !in setOf(Json.of("discarded"), Json.of("resolved")) &&
            it["code"] != Json.of("source-kind") && it["cacheConsumed"] != Json.of(true) }.map { item -> effectiveSource(item) } } }

    fun retireStartSources() { engine.commit(scope) { context ->
        val writes = context.devices(journalPrefix).mapNotNull { (key, journal) ->
            val before = journal["items"]?.obj().orEmpty()
            val items = before.mapValues { (_, item) ->
                if (item["kind"] == Json.of("start")) item.changed("cacheConsumed" to Json.of(true)) else item
            }
            if (before == items) null else DeviceWrite(key, withItems(journal, items))
        }
        if (writes.isEmpty()) null to Unit else Gesture(emptyList(), local = writes) to Unit
    } }

    fun pendingFinished(): List<SavedWorkout> = engine.read(scope) { reader ->
        reader.devices(journalPrefix).values.flatMap { it["items"]?.obj().orEmpty().values }.filter { item ->
            item["kind"] == Json.of("finished") && item["state"] == Json.of("pending") && item["code"] == Json.of("waiting-for-firstpull")
        }.map { decode(it.member("source"), SavedWorkout.serializer()) }
    }

    fun retainedWorkouts(): List<SavedWorkout> = engine.read(scope) { reader ->
        reader.devices(journalPrefix).values.flatMap { it["items"]?.obj().orEmpty().values }.mapNotNull { item ->
            if (item["state"] !in setOf(Json.of("queued"), Json.of("pending"), Json.of("refused"), Json.of("retained"))) return@mapNotNull null
            val source = item.member("source")
            try { when (item["kind"]?.str()) {
                "finished" -> decode(source, SavedWorkout.serializer())
                "start" -> SavedWorkout(decode(source.member("session"), Session.serializer()), source["entries"]?.obj().orEmpty().values
                    .map { decode(it, OwedSet.serializer()) }.filter { it.write != Owed.Delete }.map { it.set }
                    .sortedWith(compareBy({ it.completedAtMs }, { it.id })))
                else -> null
            } } catch (_: Exception) { null }
        }.distinctBy { it.session.id }
    }

    fun keepWorkout(id: String) {
        val source = retainedWorkouts().firstOrNull { it.session.id == id } ?: return
        if (source.session.isOpen) {
            val finish = source.sets.maxOfOrNull { it.completedAtMs } ?: source.session.startedAtMs
            val result = engine.commitWithPrerequisites(scope) { context ->
                val saved = context.devices(journalPrefix).entries.firstOrNull { (_, journal) -> journal["items"]?.obj().orEmpty().values.any { it["id"] == Json.of(id) && it["kind"] == Json.of("start") && it["state"] == Json.of("refused") } }
                    ?: return@commitWithPrerequisites null to null
                val items = saved.value.member("items").obj().toMutableMap()
                val original = items.values.first { it["id"] == Json.of(id) && it["kind"] == Json.of("start") }.member("source")
                val entries = original["entries"]?.obj().orEmpty().values
                val sets = entries.filter { decode(it, OwedSet.serializer()).write != Owed.Delete }.map { it.member("set") }
                    .sortedWith(compareBy({ it.member("completedAt").long() }, { it.member("id").str() }))
                val payload = Json.objectOf("session" to original.member("session").changed("finishedAt" to Json.of(finish)), "sets" to Json.Arr(sets),
                    "deleted" to Json.Arr(entries.filter { decode(it, OwedSet.serializer()).write == Owed.Delete }.map { it.member("set").member("id") }))
                val item = Item(Seat.anonymous, "finished", id, payload, sourceSeat = "keep:${context.replica}")
                var code: String? = null
                val gesture = try { imported(payload, context) } catch (refused: RefusedImport) { code = refused.code; Gesture(emptyList()) }
                val gestureId = context.opaqueID(); gesture.gestureId = gestureId
                items.replaceAll { _, previous -> if (previous["id"] == Json.of(id) && previous["kind"] == Json.of("start") || previous["kind"] == Json.of("operation") && previous["source"]?.get("sessionId") == Json.of(id)) previous.changed("state" to Json.of("resolved")) else previous }
                items[item.token] = Json.objectOf("id" to Json.of(id), "kind" to Json.of("finished"), "seat" to Json.of(item.seat),
                    "sourceSeat" to Json.of(item.sourceSeat), "source" to payload, "original" to original,
                    "state" to Json.of(if (code == null) "queued" else if (code == "waiting-for-firstpull") "pending" else "refused"), "gestureId" to Json.of(gestureId)).changed("code" to code?.let(Json::of))
                gesture.local += DeviceWrite(saved.key, withItems(saved.value, items))
                gesture to Triple(saved.key, item.token, gesture)
            }
            retainRejected(result)
        } else retry(id)
    }

    fun reconcileConfirmed() {
        engine.commitWithPrerequisites(scope) { context ->
            if (context.isAnonymous || !context.firstPullComplete() || context.checkpoint().cleanSeq == null) return@commitWithPrerequisites null to Unit
            val writes = context.devices(journalPrefix).mapNotNull { (key, journal) ->
                val before = journal["items"]?.obj().orEmpty()
                val items = before.mapValues { (_, item) ->
                    if (item["kind"] != Json.of("start") || item["state"] != Json.of("queued")) item else {
                        val session = decode(item.member("source").member("session"), Session.serializer())
                        val known = context.confirmed(Gym.Types.session, RecordID(session.id))?.takeIf { it.isVisible && it.born != null }
                        if (known == null) item else {
                            val expected = sessionFields(session)
                            val matches = known.values["startedAt"] == expected["startedAt"] &&
                                (known.values["plan"] ?: Json.Null) == expected["plan"] &&
                                (known.values["historyRoutineId"] ?: known.values["routineId"] ?: Json.Null) == expected["historyRoutineId"]
                            val reconciled = engine.reconcileConfirmedCommand(context, scope, item.member("gestureId").str(), Gym.Commands.start, RecordKey(Gym.Types.session, RecordID(session.id)))
                            if (!matches) item.changed("state" to Json.of("refused"), "code" to Json.of("session-id-taken"))
                            else if (reconciled) item.changed("state" to Json.of("admitted")) else item
                        }
                    }
                }
                if (before == items) null else DeviceWrite(key, withItems(journal, items))
            }
            if (writes.isEmpty()) null to Unit else Gesture(emptyList(), local = writes) to Unit
        }
        val waiting = engine.read(scope) { reader ->
            if (!reader.firstPullComplete() || reader.checkpoint().cleanSeq == null) emptyList() else
                reader.devices(journalPrefix).values.flatMap { it["items"]?.obj().orEmpty().values }.filter { item ->
                    item["kind"] in setOf(Json.of("finished"), Json.of("start")) && item["state"] == Json.of("pending") && item["code"] == Json.of("waiting-for-firstpull")
                }.map { it.member("id").str() }
        }
        waiting.forEach { retry(it) }
        dismissResolvedNotices()
    }

    private fun dismissResolvedNotices() {
        val gestures = engine.read(scope) { reader -> reader.devices(journalPrefix).values.flatMap { it["items"]?.obj().orEmpty().values }
            .filter { it["kind"] == Json.of("finished") && it["state"] == Json.of("admitted") }.mapNotNull { it["resolvedGestureId"]?.str() }.toSet() }
        engine.notices("gym").notices.value.filter { !it.isDismissed && it.id in gestures.map { gesture -> "notice:$gesture/0" } }.forEach { engine.dismissNotice(it.id) }
    }

    fun refusals(): List<ImportRefusal> = engine.read(scope) { reader ->
        reader.devices(journalPrefix).values.flatMap { journal -> journal["items"]?.obj().orEmpty().values.filter { it["state"] == Json.of("refused") }.map { item ->
            val source = item.member("source")
            val row = if (item["kind"] == Json.of("finished")) try { decode(source, SavedWorkout.serializer()) } catch (_: Exception) { null } else null
            val start = if (item["kind"] == Json.of("start")) try { decode(source.member("session"), Session.serializer()) } catch (_: Exception) { null } else null
            val startSets = if (start != null) source["entries"]?.obj().orEmpty().values.mapNotNull { entry ->
                try { decode(entry, OwedSet.serializer()).set } catch (_: Exception) { null }
            } else null
            val operation = if (item["kind"] == Json.of("operation")) try { decode(source, OwedSet.serializer()) } catch (_: Exception) { null } else null
            val code = item["code"]?.str() ?: "source-unreadable"
            val savedSets = when (item["kind"]?.str()) {
                "operation" -> listOf(source.member("set"))
                "start" -> source["entries"]?.obj().orEmpty().values.map { it.member("set") }
                else -> source["sets"]?.arr().orEmpty()
            }
            val unknownKinds = savedSets.filter(::unknownKind).map { it.member("id").str() }
            val description = if (item["kind"] == Json.of("finished") && code in setOf("record-dead", "unknown-record")) reason("routine-missing") else reason(code)
            ImportRefusal(item.member("id").str(), row?.session ?: start,
                row?.sets ?: startSets ?: listOfNotNull(operation?.set), row?.deleted.orEmpty(), code, description, unknownKinds)
        } }
    }

    fun retry(id: String) = editAndRetry(id, null)
    fun replaceAndRetry(id: String, corrected: SavedWorkout, markFinished: Boolean = false, correctedKinds: Set<String> = emptySet()) =
        editAndRetry(id, Json.parse(diskJson.encodeToString(SavedWorkout.serializer(), corrected)), markFinished = markFinished, correctedKinds = correctedKinds)
    fun replaceStartAndRetry(id: String, corrected: Session, correctedKinds: Map<String, works.windmill.gym.domain.SetKind> = emptyMap()) {
        check(corrected.id == id && corrected.isOpen) { "An unfinished workout keeps its identity and remains unfinished." }
        editAndRetry(id, null, Json.parse(diskJson.encodeToString(Session.serializer(), corrected)), startKinds = correctedKinds)
    }
    fun replaceOperationKindAndRetry(id: String, kind: works.windmill.gym.domain.SetKind) = editAndRetry(id, null, startKinds = mapOf(id to kind))

    private fun editAndRetry(id: String, corrected: Json?, correctedStart: Json? = null,
        markFinished: Boolean = false, correctedKinds: Set<String> = emptySet(),
        startKinds: Map<String, works.windmill.gym.domain.SetKind> = emptyMap()) {
        engine.commitWithPrerequisites(scope) { context ->
            val all = context.devices(journalPrefix)
            val saved = all.entries.firstOrNull { entry -> entry.value["items"]?.obj().orEmpty().values.any { it["id"] == Json.of(id) && (it["state"] == Json.of("refused") || it["state"] == Json.of("pending") && it["code"] == Json.of("waiting-for-firstpull")) } }
                ?: all.entries.firstOrNull { entry -> entry.value["items"]?.obj().orEmpty().values.any { it["id"] == Json.of(id) } }
                ?: throw IllegalStateException("This saved workout is unavailable.")
            val key = saved.key
            val journal = saved.value
            val items = journal["items"]?.obj().orEmpty().toMutableMap()
            val token = (items.entries.firstOrNull { it.value["id"] == Json.of(id) && (it.value["state"] == Json.of("refused") || it.value["state"] == Json.of("pending") && it.value["code"] == Json.of("waiting-for-firstpull")) }
                ?: items.entries.firstOrNull { it.value["id"] == Json.of(id) })?.key
                ?: throw IllegalStateException("This saved workout is unavailable.")
            val item = items.getValue(token)
            if (item["state"] != Json.of("refused") && !(item["state"] == Json.of("pending") && item["code"] == Json.of("waiting-for-firstpull"))) return@commitWithPrerequisites null to Unit
            val before = item.member("source")
            if (corrected != null && unknownFinishedFields(before)) throw IllegalStateException(reason("source-needs-update"))
            var source = corrected ?: correctedStart?.let { before.changed("session" to it) } ?: before
            if (corrected != null) {
                if (!markFinished) {
                    val closure = before["session"]?.obj().orEmpty().filterKeys { it in setOf("closedItself", "closedBy") }
                    source = source.changed("session" to Json.Obj((source.member("session").obj() + closure).toList()))
                }
                val prior = before["sets"]?.arr().orEmpty().associateBy { it.member("id").str() }
                val sets = source["sets"]?.arr().orEmpty().map { set ->
                    val savedKind = prior[set.member("id").str()]?.get("kind")
                    if (savedKind?.str()?.let { it !in setOf("warmup", "working", "drop", "failure") } == true && set.member("id").str() !in correctedKinds)
                        set.changed("kind" to savedKind) else set
                }
                source = source.changed("sets" to Json.Arr(sets))
            }
            val kind = item.member("kind").str()
            if (startKinds.isNotEmpty()) {
                if (kind == "operation") source = source.changed("set" to source.member("set").changed("kind" to Json.of(startKinds.getValue(id).wire)))
                else {
                    check(kind == "start")
                    source = source.changed("entries" to Json.Obj(source["entries"]?.obj().orEmpty().mapValues { (_, entry) ->
                        startKinds[entry.member("set").member("id").str()]?.let { chosen -> entry.changed("set" to entry.member("set").changed("kind" to Json.of(chosen.wire))) } ?: entry
                    }.toList()))
                }
            }
            check(corrected == null || kind == "finished") { "Only a finished workout can be edited here." }
            check(correctedStart == null || kind == "start") { "Only an unfinished workout can be edited here." }
            if (kind in setOf("finished", "start")) check(source.member("session").member("id").str() == id) { "A saved workout keeps its identity." }
            val gesture = try { gesture(Item(item.member("seat").str(), kind, id, source), context) } catch (refusal: RefusedImport) {
                val changed = item.changed("source" to source, "state" to Json.of(if (refusal.code == "waiting-for-firstpull") "pending" else "refused"), "code" to Json.of(refusal.code),
                    "original" to (item["original"] ?: item.member("source")))
                items[token] = changed
                return@commitWithPrerequisites Gesture(emptyList(), local = listOf(DeviceWrite(key, withItems(journal, items)))) to Unit
            }
            val gestureId = context.opaqueID()
            gesture.gestureId = gestureId
            items[token] = item.changed("source" to source, "state" to Json.of(if (gesture.command != null) "queued" else if (kind == "operation") "pending" else if (kind in setOf("finished", "start")) "admitted" else "migrated"), "gestureId" to Json.of(gestureId),
                "original" to (item["original"] ?: item.member("source")), "code" to null)
            if (kind == "finished" && gesture.command == null && item["gestureId"] != null)
                items[token] = items.getValue(token).changed("resolvedGestureId" to item.member("gestureId"))
            if (kind == "start" && startKinds.isNotEmpty()) items.replaceAll { _, child ->
                val chosen = child["id"]?.str()?.let(startKinds::get)
                if (child["kind"] == Json.of("operation") && child["source"]?.get("sessionId") == Json.of(id) && chosen != null)
                    child.changed("source" to child.member("source").changed("set" to child.member("source").member("set").changed("kind" to Json.of(chosen.wire))),
                        "state" to Json.of("pending"), "original" to (child["original"] ?: child.member("source"))) else child
            }
            gesture.local += DeviceWrite(key, withItems(journal, items))
            gesture to Unit
        }
        dismissResolvedNotices()
    }

    fun discardRefusal(id: String) { engine.commit(scope) { context ->
        val writes = context.devices(journalPrefix).mapNotNull { (key, journal) ->
            val before = journal["items"]?.obj().orEmpty()
            val starts = before.values.filter { it["id"] == Json.of(id) && it["kind"] == Json.of("start") && it["state"] == Json.of("refused") }
                .map { it.member("source").member("session").member("id") }.toSet()
            val items = before.mapValues { (_, item) ->
                val child = item["kind"] == Json.of("operation") && item["source"]?.get("sessionId") in starts &&
                    item["state"] in setOf(Json.of("pending"), Json.of("refused"))
                if (child || item["id"] == Json.of(id) && (item["state"] == Json.of("refused") || item["state"] == Json.of("pending") && item["code"] == Json.of("waiting-for-firstpull"))) item.changed("state" to Json.of("discarded")) else item
            }
            if (items == before) null else DeviceWrite(key, withItems(journal, items))
        }
        if (writes.isEmpty()) null to Unit else Gesture(emptyList(), local = writes) to Unit
    } }

    companion object {
        const val journalPrefix = "rack:legacyMigration"
        val scope = ScopeRef(Gym.scope)
        private fun key(seat: String) = journalPrefix + Sha256.hex(seat.toByteArray()).take(16)
        private class RefusedImport(val code: String) : Exception(code)
        private val snapshotJson = kotlinx.serialization.json.Json(diskJson) { encodeDefaults = true; explicitNulls = true }
        private fun Json.changed(vararg values: Pair<String, Json?>) = Json.Obj(obj().toMutableMap().apply {
            values.forEach { (key, value) -> if (value == null) remove(key) else put(key, value) }
        }.toList())
        private fun withItems(journal: Json, items: Map<String, Json>): Json {
            val count = items.values.filter { it["state"] in setOf(Json.of("pending"), Json.of("refused"), Json.of("retained")) }
                .groupingBy { item -> when (item["kind"]?.str()) {
                    "finished", "start" -> Gym.Types.session
                    "operation" -> Gym.Types.set
                    else -> "pending"
                } }.eachCount().toMutableMap()
            val retainedSets = items.values.sumOf { item ->
                if (item["kind"] == Json.of("finished") && item["state"] in setOf(Json.of("pending"), Json.of("refused"), Json.of("retained")))
                    item["source"]?.get("sets")?.arr().orEmpty().size else 0
            }
            val deleted = items.values.sumOf { item ->
                if (item["kind"] != Json.of("finished") || item["state"] in setOf(Json.of("discarded"), Json.of("resolved"))) 0 else item["source"]?.get("deleted")?.arr().orEmpty()
                    .count { it !in item["resolvedDeleted"]?.arr().orEmpty() }
            }
            if (retainedSets + deleted > 0) count[Gym.Types.set] = (count[Gym.Types.set] ?: 0) + retainedSets + deleted
            return journal.changed("items" to Json.Obj(items.toList()), "count" to Json.Obj(count.map { it.key to Json.of(it.value) }))
        }
        private fun journal(reader: ScopeReader, key: String) = reader.device(key) ?: Json.objectOf("version" to Json.of(1), "items" to Json.objectOf())
        // A journal source may carry an earlier shape of a frozen plan's targets; it is read in this build's shape.
        private fun <T> decode(value: Json, serializer: kotlinx.serialization.KSerializer<T>): T =
            diskJson.decodeFromJsonElement(serializer, StoredDocument.migrated(diskJson.parseToJsonElement(value.jcs)))
        private fun sessionFields(session: Session) = mapOf("startedAt" to Json.of(session.startedAtMs),
            "finishedAt" to (session.finishedAtMs?.let(Json::of) ?: Json.Null), "closedBy" to (if (session.isOpen) Json.Null else Json.of("finish")),
            "routineId" to (session.routineId?.let(Json::of) ?: Json.Null), "historyRoutineId" to (session.routineId?.let(Json::of) ?: Json.Null),
            "plan" to (session.plan?.let(::planFields) ?: Json.Null), "displayName" to Json.Null)

        private fun planFields(plan: works.windmill.gym.domain.PlanSnapshot) = Json.objectOf("routine" to Json.of(plan.routine),
            "entries" to Json.Arr(plan.entries.map { entry -> Json.Obj(buildList {
                add("exerciseId" to Json.of(entry.exerciseId))
                if (entry.sets.isNotEmpty()) add("sets" to Json.parse(diskJson.encodeToString(kotlinx.serialization.builtins.ListSerializer(works.windmill.gym.domain.SetTarget.serializer()), entry.sets)))
            }) }))

        private fun unknownFinishedFields(source: Json): Boolean {
            fun extra(value: Json?, allowed: Set<String>) = value is Json.Obj && value.obj().keys.any { it !in allowed }
            if (extra(source, setOf("session", "sets", "deleted")) || extra(source["session"], setOf("id", "startedAt", "finishedAt", "routineId", "plan", "closedItself", "closedBy"))) return true
            if (source["sets"]?.arr().orEmpty().any { extra(it, setOf("id", "exerciseId", "setNumber", "weightKg", "reps", "kind", "rpe", "note", "completedAt")) }) return true
            val plan = source["session"]?.get("plan")
            if (extra(plan, setOf("routine", "entries"))) return true
            return plan?.get("entries")?.arr().orEmpty().any { entry ->
                extra(entry, setOf("exerciseId", "sets", "reps", "weightKg")) || entry["sets"]?.arr().orEmpty().any { extra(it, setOf("reps", "weightKg")) }
            }
        }

        private fun unknownKind(set: Json): Boolean = set["kind"]?.str()?.let { it !in setOf("warmup", "working", "drop", "failure") } == true

        private fun effectiveSource(item: Json): Json {
            val source = item.member("source")
            val target = item["targetSessionId"] ?: return source
            if (item["kind"] != Json.of("start")) return source
            val session = source["session"] ?: return source
            val entries = source["entries"]?.obj().orEmpty().mapValues { (_, entry) -> entry.changed("sessionId" to target) }
            return source.changed("session" to session.changed("id" to target), "entries" to Json.Obj(entries.toList()))
        }

        val commandResultWrites: CommandResultDeviceWrites = { command, result, _, values ->
            if (command.name !in setOf(Gym.Commands.importSession, Gym.Commands.start)) emptyList() else values.filterKeys { it.startsWith(journalPrefix) }.map { (key, journal) ->
                val items = journal["items"]?.obj().orEmpty().mapValues { (_, item) ->
                    val kind = if (command.name == Gym.Commands.importSession) "finished" else "start"
                    if (item["kind"] != Json.of(kind) || item["id"] != command.args["id"] || item["state"] != Json.of("queued")) item
                    else when (val verdict = result.verdict) {
                        is PushResult.Verdict.Ok -> if (command.name == Gym.Commands.start && verdict.write.orEmpty().any {
                            it.key.type == Gym.Types.session && it.from == RecordID(item.member("id")) && it.key.id != it.from
                        }) item.changed("state" to Json.of("refused"), "code" to Json.of("session-open"), "targetSessionId" to null)
                            else item.changed("state" to Json.of("admitted"))
                        is PushResult.Verdict.Refused -> if (verdict.code.text in setOf("clock-skew", "base-unknown")) item
                            else item.changed("state" to Json.of("refused"), "code" to Json.of(verdict.code.text))
                    }
                }
                DeviceWrite(key, withItems(journal, items))
            }
        }
        val pendingDeviceWork: PendingDeviceWork = { product, values ->
            if (product != "gym") emptyList() else values.filter { (key, journal) -> key.startsWith(journalPrefix) &&
                journal["count"]?.obj()?.values?.any { it.long() > 0 } == true
            }.keys.toList()
        }
        val rewriteDeviceValue: DeviceValueRewrite = { product, key, value, type, from, to ->
            if (product != "gym" || !key.startsWith(journalPrefix) || type != Gym.Types.session) value else {
                val items = value["items"]?.obj().orEmpty().mapValues { (_, item) ->
                    val source = item["source"]
                    val original = when (item["kind"]?.str()) {
                        "operation" -> source?.get("sessionId")
                        "start", "finished" -> source?.get("session")?.get("id")
                        else -> null
                    }
                    if ((item["targetSessionId"] ?: original) == from.json && from != to && item["kind"] in setOf(Json.of("start"), Json.of("operation"))) {
                        if (item["kind"] == Json.of("start")) item.changed("state" to Json.of("refused"), "code" to Json.of("session-open"), "targetSessionId" to null) else item
                    } else if ((item["targetSessionId"] ?: original) == from.json) item.changed("targetSessionId" to to.json) else item
                }
                withItems(value, items)
            }
        }
        fun reason(code: String): String = when (code) {
            "session-open" -> "Another workout is open on the account. Inspect this saved workout, then choose Keep to save it as a finished workout at its last set."
            "session-overlap" -> "This workout overlaps another workout. Correct its dates or times, then retry."
            "session-id-taken" -> "A workout with this identity is already on the log. Review that workout before retrying; this original stays on this phone."
            "bad-instant", "clock-skew" -> "The workout has a future or invalid time. Correct its dates or times, then retry."
            "too-many-sets", "too-large" -> "This workout exceeds the import limit. Edit the workout explicitly, then retry."
            "frozen-plan-changed", "routine-missing", "stale" -> "The linked routine differs from this workout’s saved plan. Restore that routine or explicitly remove the link, then retry."
            "source-numbering" -> "This workout’s saved set numbers cannot be imported unchanged. Explicitly re-number its sets, then retry."
            "source-auto-closed" -> "This workout closed automatically. Explicitly mark it finished before retrying."
            "source-kind" -> "A saved set kind is not recognized. Explicitly choose its kind, then retry."
            "source-needs-update" -> "This saved workout includes fields this build cannot preserve. Keep it on this phone and update the app."
            "source-unreadable" -> "This saved training cannot be read by this build. Keep it on this phone and update the app."
            "unknown-exercise" -> "A movement is missing. Restore the movement, then retry."
            "parent-dead" -> "A linked movement or routine was refused. Restore it, then retry this workout."
            else -> "This workout was refused ($code). Correct the saved workout, then retry."
        }
    }
}
