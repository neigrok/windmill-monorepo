package works.windmill.gym.store

import kotlinx.serialization.Serializable
import works.windmill.domain.kit.*
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.WorkoutEvent
import works.windmill.gym.domain.sync.Catalogue
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.gym.domain.sync.ImportSession
import works.windmill.gym.domain.sync.SavedSets
import works.windmill.gym.domain.sync.SignedOutWorkout
import works.windmill.gym.domain.sync.StrandedSet
import works.windmill.gym.domain.sync.TrainingLog
import works.windmill.gym.domain.sync.WorkoutFix
import works.windmill.gym.domain.sync.WorkoutRecovery
import works.windmill.gym.domain.sync.nonJoiningStart
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
import works.windmill.sync.engine.pendingGesture
import works.windmill.sync.engine.refusedDeltas
import works.windmill.sync.schema.Gym
import works.windmill.gym.domain.sync.Session as SyncSession
import works.windmill.gym.domain.sync.TrainingSet as SyncSet
import works.windmill.gym.domain.sync.Exercise as SyncExercise
import works.windmill.gym.domain.sync.Routine as SyncRoutine
import works.windmill.gym.domain.sync.PlanSnapshot as SyncPlan

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
)

// What an owed set asks of the account.
@Serializable
enum class Owed {
    Append,     // the account has never seen this row
    Fix,        // the account holds this row, and this phone holds numbers it does not
    Delete,     // the account holds this row, and this phone has taken it back
}

data class ImportRefusal(val id: String, val session: Session?, val sets: List<TrainingSet>,
    val deletedSetIds: List<String>, val code: String, val reason: String,
    val kind: String = "finished", val workoutId: String? = session?.id)

data class ImportOpening(val id: String, val replica: String, val anonymous: Boolean, val sources: Map<String, String>)

data class ImportRecovery(val id: String, val workout: SavedWorkout?, val refusals: List<ImportRefusal>, val openings: List<ImportOpening>) {
    val sourceKey = Sha256.hex(Json.Arr(openings.map { opening -> Json.array(Json.of(opening.id), Json.of(opening.replica),
        Json.Obj(opening.sources.toSortedMap().map { it.key to Json.of(it.value) })) }).jcs.toByteArray())
    val adding: Boolean get() = refusals.isEmpty()
    val operationsOnly: Boolean get() = refusals.isNotEmpty() && refusals.all { it.kind == "operation" } || openings.isNotEmpty() && openings.none { it.id == id }
}


data class ImportOperation(val token: String, val sessionId: String, val entry: OwedSet)
data class ImportDeletion(val token: String, val sessionId: String, val setId: String)

// Signed-out training prepared for an account at sign-in. Each finished workout becomes one strict
// import and an unfinished one a start whose sets follow it; a refused workout stays on this phone,
// inspectable and correctable, until it is kept, retried or discarded.
class WorkoutImports(private val engine: Engine, private val writeAuthority: () -> Boolean = { true }) {
    private data class Item(val seat: String, val kind: String, val id: String, val payload: Json, val sourceSeat: String = seat) {
        val token = Sha256.hex(Json.array(Json.of(seat), Json.of(sourceSeat), Json.of(kind), Json.of(id), payload).jcs.toByteArray())
    }

    fun reviewWorkouts(): List<ImportRecovery> {
        val refused = refusals()
        val copies = retainedWorkouts().toMutableList()
        val retainedIds = copies.mapTo(mutableSetOf()) { it.session.id }
        val waiting = engine.read(scope) { reader -> reader.devices(journalPrefix).values.flatMap { journal ->
            journal["items"]?.obj().orEmpty().values.filter { it["state"] in setOf(Json.of("queued"), Json.of("pending"), Json.of("refused"), Json.of("retained"), Json.of("recovering"), Json.of("submitted")) }
        } }
        val operations = waiting.filter { it["kind"] == Json.of("operation") }
        val operationSources = operations.map { item -> item to runCatching { decode(item.member("source"), OwedSet.serializer()) }.getOrNull() }
        val operationParents = operationSources.mapNotNullTo(mutableSetOf()) { it.second?.sessionId }
        val starts = engine.read(scope) { reader -> reader.devices(journalPrefix).values.flatMap { journal ->
            journal["items"]?.obj().orEmpty().values.filter { it["kind"] == Json.of("start") && it["id"]?.str() in operationParents && it["state"] !in setOf(Json.of("resolved"), Json.of("discarded")) }
                .mapNotNull { item -> runCatching {
                    val source = item.member("source")
                    SavedWorkout(decode(source.member("session"), Session.serializer()), source["entries"]?.obj().orEmpty().values
                        .map { decode(it, OwedSet.serializer()) }.filter { it.write != Owed.Delete }.map { it.set }.sortedWith(compareBy({ it.completedAtMs }, { it.id })))
                }.getOrNull() }
        } }
        for (copy in starts) if (copies.none { it.session.id == copy.session.id }) copies += copy
        val rows = copies.map { copy ->
            val failures = refused.filter { (it.workoutId ?: it.id) == copy.session.id }
            val ids = if (failures.isNotEmpty() && failures.all { it.kind == "operation" }) failures.map { it.id }
                else if (copy.session.id !in retainedIds && copy.session.id in operationParents)
                operations.filter { it["source"]?.get("sessionId") == Json.of(copy.session.id) }.map { it.member("id").str() }
                else listOf(copy.session.id)
            ImportRecovery(copy.session.id, copy, failures, ids.distinct().map(::opening))
        }.toMutableList()
        for ((id, failures) in refused.filter { failure -> rows.none { it.id == (failure.workoutId ?: failure.id) } }.groupBy { it.workoutId ?: it.id }) {
            rows += ImportRecovery(id, null, failures, failures.map { it.id }.distinct().map(::opening))
        }
        for (id in operationParents) if (rows.none { it.id == id }) {
            rows += ImportRecovery(id, null, emptyList(), operations.filter { it["source"]?.get("sessionId") == Json.of(id) }
                .map { opening(it.member("id").str()) })
        }
        for ((item, source) in operationSources) if (source == null) {
            val id = item.member("id").str()
            if (rows.none { it.id == id }) rows += ImportRecovery(id, null,
                listOf(ImportRefusal(id, null, emptyList(), emptyList(), "source-unreadable", reason("source-unreadable"), kind = "operation")), listOf(opening(id)))
        }
        for (item in waiting.filter { it["kind"] in setOf(Json.of("start"), Json.of("finished")) }) {
            val id = item.member("id").str()
            if (rows.none { it.id == id }) rows += ImportRecovery(id, null, emptyList(), listOf(opening(id)))
        }
        return rows.sortedWith(compareByDescending<ImportRecovery> { it.workout?.session?.startedAtMs ?: Long.MIN_VALUE }.thenBy { it.id })
    }

    fun opening(id: String): ImportOpening {
        val replica = engine.activeReplica()
        return engine.read(scope) { reader ->
            if (engine.activeReplica() != replica) throw TrainingRefused("account-changed", "The account changed. Open this again.")
            ImportOpening(id, replica, reader.isAnonymous, sources(reader, id))
        }
    }

    private fun sources(reader: ScopeReader, id: String): Map<String, String> = reader.devices(journalPrefix).flatMap { (key, journal) ->
        journal["items"]?.obj().orEmpty().mapNotNull { (token, item) ->
            if (item["id"] == Json.of(id) || item["kind"] == Json.of("operation") && item["source"]?.get("sessionId") == Json.of(id))
                "$key:$token" to item.jcs else null
        }
    }.toMap()

    private fun requireOpening(context: CommitContext, opening: ImportOpening?, allowed: () -> Boolean) {
        if (!allowed() || opening != null && (context.replica != opening.replica || context.isAnonymous != opening.anonymous))
            throw TrainingRefused("account-changed", "The account changed. Open this again.")
        if (opening != null && (opening.sources.isEmpty() || sources(context, opening.id) != opening.sources))
            throw TrainingRefused("saved-workout-changed", "This saved workout changed. Open it again.")
    }

    fun preview(opening: ImportOpening, corrected: SavedWorkout, markFinished: Boolean, now: Long): String? = engine.read(scope) { reader ->
        if (engine.activeReplica() != opening.replica || reader.isAnonymous != opening.anonymous)
            throw TrainingRefused("account-changed", "The account changed. Open this again.")
        if (sources(reader, opening.id) != opening.sources)
            throw TrainingRefused("saved-workout-changed", "This saved workout changed. Open it again.")
        val item = reader.devices(journalPrefix).values.flatMap { it["items"]?.obj().orEmpty().values }
            .firstOrNull { it["id"] == Json.of(opening.id) && it["state"] == Json.of("refused") }
            ?: return@read "saved-workout-changed"
        try {
            val before = item.member("source")
            val original = if (item["kind"] == Json.of("start")) authored(before) else before
            val candidate = editedFinished(original, corrected, markFinished)
            floorEdits(item, corrected.signedOut(), reader, now)
            if (corrected.session.isOpen) {
                val readerAt = Reader(reader, scope, Moment(Instant(now), FixedZone(0)), engine.registry)
                corrected.signedOut().retryRefusal(readerAt.moment, TrainingLog(readerAt).drawnSessions, Catalogue(readerAt))
                    ?.let { throw RefusedImport(code(it)) }
                checkRoutine(corrected.session, reader)
            } else checkedImport(candidate, reader, now)
            null
        } catch (refusal: RefusedImport) { refusal.code }
        catch (invalid: Violation) { code(GymRefusal.Invalid(invalid)) }
    }

    // A load the person changed in the fix editor meets its movement's floor; a load the saved workout first recorded
    // stands as recorded.
    private fun floorEdits(item: Json, edited: SignedOutWorkout, reader: ScopeReader, now: Long) {
        val catalogue = Catalogue(Reader(reader, scope, Moment(Instant(now), FixedZone(0)), engine.registry))
        edited.floorRefusal(signedOutSource(item, item["original"] ?: item.member("source")), catalogue)?.let { throw RefusedImport(code(it)) }
    }

    // A journal item's workout as the domain reads it.
    private fun signedOutSource(item: Json, source: Json): SignedOutWorkout =
        decode(if (item["kind"] == Json.of("start")) authored(source) else source, SavedWorkout.serializer()).signedOut()

    private fun editedStart(before: Json, corrected: SavedWorkout): Json {
        val old = before["entries"]?.obj().orEmpty()
        val edited = editedFinished(authored(before), corrected, markFinished = false)
        val sets = edited.member("sets").arr().associateBy { it.member("id").str() }
        val entries = old.mapValues { (id, entry) ->
            val value = decode(entry, OwedSet.serializer())
            val set = sets[id]
            if (set == entry["set"] || value.write == Owed.Delete) entry
            else entry.changed("set" to (set ?: entry.member("set")), "needsPush" to Json.of(true),
                "write" to Json.of(if (set == null) "Delete" else if (value.attempted) "Fix" else "Append"))
        }
        return before.changed("session" to edited.member("session"), "entries" to Json.Obj(entries.toList()))
    }

    private fun checkRoutine(session: Session, context: ScopeReader) {
        val id = session.routineId ?: return
        if (!context.isAnonymous && (!context.firstPullComplete() || context.checkpoint().cleanSeq == null)) throw RefusedImport("waiting-for-firstpull")
        val routine = context.drawn(Gym.Types.routine, RecordID(id))?.takeIf { it.isVisible && it.born != null }
            ?: throw RefusedImport("routine-missing")
        val plan = Json.objectOf("routine" to routine.values.getValue("name"), "entries" to routine.values.getValue("entries"))
        if (plan != sessionFields(session).getValue("plan")) throw RefusedImport("frozen-plan-changed")
    }

    private fun editedFinished(before: Json, corrected: SavedWorkout, markFinished: Boolean): Json {
        if (unknownFinishedFields(before)) throw RefusedImport("source-needs-update")
        if (before.member("session").member("id") != Json.of(corrected.session.id)) throw RefusedImport("saved-workout-changed")
        val typed = Json.parse(snapshotJson.encodeToString(SavedWorkout.serializer(), corrected))
        val prior = Json.parse(snapshotJson.encodeToString(SavedWorkout.serializer(), decode(before, SavedWorkout.serializer())))
        val priorSets = prior.member("sets").arr().associateBy { it.member("id").str() }
        val oldSets = before["sets"]?.arr().orEmpty().associateBy { it.member("id").str() }
        if (corrected.sets.any { it.id !in oldSets }) throw RefusedImport("saved-workout-changed")
        var session = before.member("session").changed(*typed.member("session").obj().filter { prior.member("session")[it.key] != it.value }.map { it.key to it.value }.toTypedArray())
        if (markFinished) session = session.changed("closedItself" to null, "closedBy" to null)
        return before.changed("session" to session, "sets" to Json.Arr(typed.member("sets").arr().map { set ->
            oldSets.getValue(set.member("id").str()).changed(*set.obj().filter { priorSets.getValue(set.member("id").str())[it.key] != it.value }.map { it.key to it.value }.toTypedArray())
        }), "deleted" to Json.Arr((before["deleted"]?.arr().orEmpty() + corrected.deleted.map(Json::of)).distinct()).takeIf { before["deleted"] != null || corrected.deleted.isNotEmpty() })
    }

    fun prepare(row: SavedWorkout) {
        if (row.session.isOpen) retain(row, finished = false) else retain(row, finished = true)
    }

    private fun retain(row: SavedWorkout, finished: Boolean) {
        val result = engine.commitWithPrerequisites(scope) { context ->
            if (!writeAuthority()) throw TrainingRefused("account-changed", "The account changed. Open this again.")
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
                        (original ?: set).changed(*set.obj().map { it.key to it.value }.toTypedArray())
                    }),
                    "deleted" to Json.Arr((old?.get("deleted")?.arr().orEmpty() + row.deleted.map(Json::of) +
                        context.devices("rack:deletedSet").values.filter { it["sessionId"] == Json.of(row.session.id) }.map { it.member("setId") }).distinct().sortedBy(Json::str)))
            } else {
                val entries = priorStart?.get("entries")?.obj().orEmpty().toMutableMap()
                row.sets.forEach { set ->
                    val saved = entries[set.id]
                    if (saved == null) entries[set.id] = Json.parse(snapshotJson.encodeToString(OwedSet.serializer(), OwedSet(set, row.session.id, true, 0)))
                    else if (decode(saved, OwedSet.serializer()).set != set) {
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

    private fun retainRejected(result: Pair<CommitOutcome?, Triple<String, String, Gesture>?>, opening: ImportOpening? = null, allowed: () -> Boolean = { true }) {
        val rejected = result.first as? CommitOutcome.Refused ?: return
        val prepared = result.second ?: return
        engine.commitWithPrerequisites(scope) { context ->
            if (!writeAuthority()) throw TrainingRefused("account-changed", "The account changed. Open this again.")
            requireOpening(context, opening, allowed)
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
            if (unknownFinishedFields(authored(item.payload))) throw RefusedImport("source-needs-update")
            val session = decode(item.payload.member("session"), Session.serializer())
            val fields = sessionFields(session)
            val known = context.confirmed(Gym.Types.session, RecordID(session.id))?.takeIf { it.isVisible && it.born != null }
            val writes = buildList {
                item.payload["order"]?.takeIf { it is Json.Arr }?.let { add(DeviceWrite("movementOrder:${session.id}", it)) }
                item.payload["chosenMovement"]?.takeIf { it is Json.Str }?.let { add(DeviceWrite("movement:${session.id}", it)) }
                item.payload["workout"]?.takeIf { it is Json.Obj }?.let { add(DeviceWrite("rack:${session.id}", it)) }
            }
            if (known != null) {
                if (!startedAs(known, session)) throw RefusedImport("session-id-taken")
                Gesture(emptyList(), local = writes)
            } else {
                checkRoutine(session, context)
                val owed = item.payload["entries"]?.obj().orEmpty().values.map { decode(it, OwedSet.serializer()) }.filter { it.write != Owed.Delete }
                val copy = SavedWorkout(session, owed.map { it.set }).signedOut()
                if (context.isAnonymous || context.firstPullComplete()) {
                    val reader = Reader(context, scope, Moment(Instant(context.now), FixedZone(0)), engine.registry)
                    copy.retryRefusal(reader.moment, TrainingLog(reader).drawnSessions, Catalogue(reader))?.let { throw RefusedImport(code(it)) }
                }
                val start = nonJoiningStart(copy.session)
                val predict = Change.create(Gym.Types.session, NewID.Given(RecordID(session.id)), fields)
                Gesture(session.routineId?.let { listOf(Change.update(Gym.Types.routine, RecordID(it))) }.orEmpty(),
                    command = start.command, predict = listOf(predict), local = writes,
                    guards = session.routineId?.let { id -> listOf("name", "entries").map { field -> RegisterRef(Gym.Types.routine, RecordID(id), field) } }.orEmpty())
            }
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
        val checked = checkedImport(source, context, context.now) ?: return Gesture(emptyList())
        val session = checked.session
        val action = checked.copy.importAction
        val loaded = checked.loaded
        return when (val decision = action.recorded.decision(loaded, IDSource(context))) {
            is Decision.Write -> decision.plan.gesture(scope, engine.registry).also { gesture ->
                gesture.atomic = true
                if (session.routineId != null) {
                    gesture.changes += Change.update(Gym.Types.routine, RecordID(session.routineId))
                    gesture.guards += listOf("name", "entries").map { field -> RegisterRef(Gym.Types.routine, RecordID(session.routineId), field) }
                }
                gesture.predict = gesture.predict.map { change -> if (change.type == Gym.Types.session) change.copy(values = sessionFields(session)) else change }
            }
            is Decision.Refuse -> throw RefusedImport(code(decision.refusal))
            is Decision.Unchanged -> Gesture(emptyList())
        }
    }

    private data class ImportCheck(val session: Session, val copy: SignedOutWorkout, val loaded: ImportSession.Loaded)

    private fun checkedImport(source: Json, context: ScopeReader, now: Long): ImportCheck? {
        if (unknownFinishedFields(source)) throw RefusedImport("source-needs-update")
        val row = decode(source, SavedWorkout.serializer())
        val session = row.session
        val finished = session.finishedAtMs ?: throw RefusedImport("bad-instant")
        if (source["session"]?.get("closedItself") == Json.of(true) || source["session"]?.get("closedBy") == Json.of("stale"))
            throw RefusedImport("source-auto-closed")
        if (row.sets.any { it.id in row.deleted }) throw RefusedImport("deleted-set-conflict")
        if (context is CommitContext && confirmedEquivalent(row, context)) return null
        if (context.drawn(Gym.Types.session, RecordID(session.id)) != null) throw RefusedImport("session-id-taken")
        if (!context.isAnonymous && (!context.firstPullComplete() || context.checkpoint().cleanSeq == null))
            throw RefusedImport("waiting-for-firstpull")
        if (!SavedSets.numberedAsSaved(row.sets.map { it.synced(Id(session.id, SyncSession)) })) throw RefusedImport("source-numbering")
        val routine = session.routineId?.let { context.drawn(Gym.Types.routine, RecordID(it))?.takeIf { row -> row.isVisible } }
        val currentPlan = routine?.let { Json.objectOf("routine" to it.values.getValue("name"), "entries" to it.values.getValue("entries")) }
        val frozenPlan = sessionFields(session).getValue("plan")
        if ((currentPlan ?: Json.Null) != frozenPlan) throw RefusedImport("frozen-plan-changed")
        if (session.routineId != null && routine == null) throw RefusedImport("routine-missing")
        val reader = Reader(context, scope, Moment(Instant(now), FixedZone(0)), engine.registry)
        val copy = row.signedOut(finishedAtMs = finished)
        val loaded = copy.importAction.load(reader)
        copy.importRefusal(reader.moment, loaded.state.stored, loaded.state.catalogue)?.let { throw RefusedImport(code(it)) }
        if (!copy.importsUnchanged(reader.moment)) throw RefusedImport("source-needs-correction")
        return ImportCheck(row.session, copy, loaded)
    }

    private fun confirmedEquivalent(source: SavedWorkout, context: CommitContext): Boolean {
        if (context.isAnonymous || !context.firstPullComplete() || context.checkpoint().cleanSeq == null) return false
        val session = context.confirmed(Gym.Types.session, RecordID(source.session.id))?.takeIf { it.isVisible && it.born != null } ?: return false
        val expected = sessionFields(source.session)
        if (!startedAs(session, source.session) || listOf("finishedAt", "closedBy").any { (session.values[it] ?: Json.Null) != expected.getValue(it) }) return false
        val sets = engine.confirmedRecords(context, scope, Gym.Types.set).filter { it.isVisible && it.values["sessionId"] == Json.of(source.session.id) }
        return SavedSets.heldBy(source.sets.map { it.synced(Id(source.session.id, SyncSession)) }, sets)
    }

    fun operations(): List<ImportOperation> = engine.read(scope) { reader -> reader.devices(journalPrefix).values.flatMap { journal -> journal["items"]?.obj().orEmpty().mapNotNull { (token, item) ->
        if (item.member("kind").str() != "operation" || item.member("state").str() != "pending") return@mapNotNull null
        val entry = decode(item.member("source"), OwedSet.serializer())
        ImportOperation(token, item["targetSessionId"]?.str() ?: entry.sessionId, entry)
    } }.sortedWith(compareBy<ImportOperation>({ it.sessionId }, { it.entry.set.completedAtMs }, { it.entry.set.id }, { it.token })) }

    fun hasOwedSets(sessionId: String): Boolean = engine.read(scope) { reader ->
        reader.devices(journalPrefix).values.any { journal -> journal["items"]?.obj().orEmpty().values.any { item ->
            item["kind"] == Json.of("operation") && item["state"] !in setOf(Json.of("resolved"), Json.of("discarded")) &&
                (item["targetSessionId"] ?: item["source"]?.get("sessionId")) == Json.of(sessionId)
        } }
    }

    fun hasUnsubmittedSets(sessionId: String): Boolean = engine.read(scope) { reader ->
        reader.devices(journalPrefix).values.any { journal -> journal["items"]?.obj().orEmpty().values.any { item ->
            item["kind"] == Json.of("operation") && item["state"] !in setOf(Json.of("submitted"), Json.of("resolved"), Json.of("discarded")) &&
                (item["targetSessionId"] ?: item["source"]?.get("sessionId")) == Json.of(sessionId)
        } }
    }

    fun retainedOperationSetIds(): Set<String> = engine.read(scope) { reader ->
        reader.devices(journalPrefix).values.flatMap { journal -> journal["items"]?.obj().orEmpty().values.filter { item ->
            item["kind"] == Json.of("operation") && item["state"] !in setOf(Json.of("resolved"), Json.of("discarded"))
        }.map { it.member("id").str() } }.toSet()
    }

    internal fun operationSubmission(operation: ImportOperation, reader: ScopeReader, gestureId: String?): DeviceWrite? {
        val saved = reader.devices(journalPrefix).entries.firstOrNull { operation.token in it.value["items"]?.obj().orEmpty() } ?: return null
        val items = saved.value.member("items").obj().toMutableMap()
        val item = items.getValue(operation.token)
        if (!pendingOperation(item, operation)) return null
        items[operation.token] = item.changed("state" to Json.of(if (gestureId == null) "resolved" else "submitted"),
            "submissionGesture" to gestureId?.let(Json::of))
        return DeviceWrite(saved.key, withItems(saved.value, items))
    }

    private fun pendingOperation(item: Json, operation: ImportOperation, includesRefused: Boolean = false): Boolean {
        if (item["state"] != Json.of("pending") && !(includesRefused && item["state"] == Json.of("refused"))) return false
        val entry = decode(item.member("source"), OwedSet.serializer())
        return entry == operation.entry && (item["targetSessionId"]?.str() ?: entry.sessionId) == operation.sessionId
    }

    fun continuesRecovery(operation: ImportOperation): Boolean = engine.read(scope) { reader ->
        reader.devices(journalPrefix).values.any { journal ->
            journal["items"]?.get(operation.token)?.let { it["recoveryPhase"] != null || it["fallback"] == Json.of(true) } == true
        }
    }

    // A finished workout's missing adopted set retains its source until the account accepts it.
    fun retryOperation(opening: ImportOpening, allowed: () -> Boolean) {
        val operation = engine.read(scope) { reader -> reader.devices(journalPrefix).values.flatMap { it["items"]?.obj().orEmpty().entries }
            .firstOrNull { (_, item) -> item["id"] == Json.of(opening.id) && item["kind"] == Json.of("operation") && item["state"] == Json.of("refused") }
            ?.let { (token, item) ->
                val entry = decode(item.member("source"), OwedSet.serializer())
                ImportOperation(token, item["targetSessionId"]?.str() ?: entry.sessionId, entry)
            } } ?: throw TrainingRefused("saved-workout-changed", reason("saved-workout-changed"))
        if (!recoverFinishedOperation(operation, opening, allowed)) throw TrainingRefused("recovery-unavailable", reason("recovery-unavailable"))
    }

    fun recoverFinishedOperation(operation: ImportOperation, opening: ImportOpening? = null, allowed: () -> Boolean = { true }): Boolean {
        val result = engine.commit(scope) { context ->
            if (!writeAuthority()) throw TrainingRefused("account-changed", "The account changed. Open this again.")
            requireOpening(context, opening, allowed)
            val saved = context.devices(journalPrefix).entries.firstOrNull { operation.token in it.value["items"]?.obj().orEmpty() }
                ?: return@commit null to false
            val items = saved.value.member("items").obj().toMutableMap()
            val item = items.getValue(operation.token)
            if (!pendingOperation(item, operation, includesRefused = opening != null)) return@commit null to true
            val entry = decode(item.member("source"), OwedSet.serializer())
            val sessionId = item["targetSessionId"]?.str() ?: entry.sessionId
            if (context.isAnonymous || entry.write == Owed.Delete) return@commit null to false
            if (!context.firstPullComplete()) return@commit null to true
            val schema = context.serverSchema() ?: return@commit null to true
            val session = context.confirmed(Gym.Types.session, RecordID(sessionId))?.takeIf { it.isVisible }
                ?.let { SyncSession.decode(Fields(it)) }
            val standing = session?.let { context.stored(Gym.Types.set, "sessionId", it.id.record) }.orEmpty()
            val stranded = StrandedSet(entry.set.synced(Id(sessionId, SyncSession)))
            if (session != null && context.drawn(Gym.Types.session, session.id.record)?.isVisible != true) return@commit null to false
            if (standing.any { it.isPending || context.drawn(Gym.Types.set, it.id)?.isVisible != true }) return@commit null to true
            val separateWorkout = session != null && stranded.apart(session, standing.mapNotNull { it.values["completedAt"]?.long()?.let(::Instant) })
            if (schema < 6 || item["fallback"] == Json.of(true) || item["recoveryPhase"] != null || separateWorkout) {
                if (item["recoveryPhase"] == null || item["recoveryPhase"] == Json.of("start")) {
                    val active = context.devices(journalPrefix).values.any { journal -> journal.member("items").obj().any { (token, other) ->
                        token != operation.token && other["recoveryPhase"] != null &&
                            (other["state"] == Json.of("recovering") ||
                                other["state"] == Json.of("pending") && other["recoveryPhase"] != Json.of("start"))
                    } }
                    if (active) return@commit null to true
                }
                if (item["recoveryPhase"] == Json.of("set")) {
                    val parent = context.confirmed(Gym.Types.session, RecordID(item.member("recoverySessionId")))
                        ?: return@commit null to true
                    if (!parent.isVisible) {
                        items[operation.token] = item.changed("state" to Json.of("refused"), "code" to Json.of("record-dead"),
                            "recoveryPhase" to null, "recoverySessionId" to null, "recoverySetId" to null)
                        return@commit Gesture(emptyList(), local = listOf(DeviceWrite(saved.key, withItems(saved.value, items)))) to true
                    }
                }
                val recovery = recoveryGesture(item, stranded, context)
                items[operation.token] = recovery.second
                recovery.first.local += DeviceWrite(saved.key, withItems(saved.value, items))
                return@commit recovery.first to true
            }
            if (context.checkpoint().cleanSeq == null) return@commit null to true
            if (session == null || session.finishedAt == null) return@commit null to false
            if (context.commands().any { it.command.name == Gym.Commands.correctSession &&
                    it.command.args["sessionId"] == Json.of(sessionId) }) return@commit null to true
            val gesture = try {
                if (context.stored(Gym.Types.set, stranded.set.id.record) != null) throw RefusedImport("record-dead")
                val action = stranded.correction(session, standing.map { SyncSet.decode(Fields(it)) }, context.opaqueID())
                    ?: throw RefusedImport("source-numbering")
                val reader = Reader(context, scope, Moment(Instant(context.now), FixedZone(0)), engine.registry)
                val decision = action.recorded.decision(action.load(reader), IDSource(context))
                if (decision !is Decision.Write) throw RefusedImport("bad-instant")
                decision.plan.guardRead(session.id, listOf("startedAt", "finishedAt", "displayName", "closedBy"))
                decision.plan.guardRead(stranded.set.id, listOf("sessionId", "exerciseId", "weightKg", "reps", "rpe", "note", "completedAt"))
                decision.plan.gesture(scope, engine.registry).also { repair ->
                    repair.gestureId = context.opaqueID()
                    items[operation.token] = item.changed("state" to Json.of("recovering"), "code" to null,
                        "recoveryRequestId" to Json.of(action.requestId), "recoveryGestures" to
                            Json.Arr(item["recoveryGestures"]?.arr().orEmpty() + Json.of(repair.gestureId!!)))
                }
            } catch (refusal: RefusedImport) {
                items[operation.token] = item.changed("state" to Json.of("refused"), "code" to Json.of(refusal.code))
                Gesture(emptyList())
            } catch (_: Violation) {
                items[operation.token] = item.changed("state" to Json.of("refused"), "code" to Json.of("source-needs-correction"))
                Gesture(emptyList())
            }
            gesture.local += DeviceWrite(saved.key, withItems(saved.value, items))
            gesture to true
        }
        (result.first as? CommitOutcome.Refused)?.let { refuseOperation(operation, it.code.text, opening, allowed) }
        return result.second
    }

    private fun recoveryGesture(item: Json, stranded: StrandedSet, context: CommitContext): Pair<Gesture, Json> {
        val sessionId = item["recoverySessionId"]?.str() ?: context.mintID(Gym.Types.session).string!!
        val setId = item["recoverySetId"]?.str() ?: context.mintID(Gym.Types.set).string!!
        val phase = item["recoveryPhase"]?.str() ?: "start"
        val session = Id(sessionId, SyncSession)
        var saved = item.changed("recoverySessionId" to Json.of(sessionId), "recoverySetId" to Json.of(setId),
            "recoveryPhase" to Json.of(phase), "fallback" to Json.of(true))
        val gesture = try {
            val step = StrandedSet.Step.of(phase)
            if (step == StrandedSet.Step.start && context.stored(Gym.Types.set, stranded.set.id.record) != null) throw RefusedImport("record-dead")
            val queued = when (step) {
                StrandedSet.Step.start -> Gesture(emptyList(), command = stranded.start(session).command)
                StrandedSet.Step.set -> {
                    val action = stranded.append(session, Id(setId, SyncSet))
                    val reader = Reader(context, scope, Moment(Instant(context.now), FixedZone(0)), engine.registry)
                    when (val decision = action.recorded.decision(action.load(reader), IDSource(context))) {
                        is Decision.Write -> decision.plan
                        is Decision.Refuse -> throw RefusedImport(if (decision.refusal is GymRefusal.SessionFinished) "session-finished" else "recovery-retry")
                        is Decision.Unchanged -> Plan()
                    }.gesture(scope, engine.registry)
                }
                StrandedSet.Step.finish -> Gesture(emptyList(), command = stranded.finish(session).command)
            }
            val gestureId = context.opaqueID()
            queued.gestureId = gestureId
            saved = saved.changed("state" to Json.of("recovering"), "code" to null,
                "recoveryGestures" to Json.Arr(item["recoveryGestures"]?.arr().orEmpty() + Json.of(gestureId)))
            queued
        } catch (refusal: RefusedImport) {
            saved = if (refusal.code == "session-finished") saved.changed("state" to Json.of("pending"), "code" to null,
                "recoverySessionId" to null, "recoverySetId" to null, "recoveryPhase" to null)
                else saved.changed("state" to Json.of("refused"), "code" to Json.of(refusal.code))
            Gesture(emptyList())
        } catch (_: Violation) {
            saved = saved.changed("state" to Json.of("refused"), "code" to Json.of("source-needs-correction"))
            Gesture(emptyList())
        }
        return gesture to saved
    }

    fun refuseOperation(operation: ImportOperation, code: String, opening: ImportOpening? = null, allowed: () -> Boolean = { true }) { engine.commit(scope) { context ->
        if (!writeAuthority()) throw TrainingRefused("account-changed", "The account changed. Open this again.")
        requireOpening(context, opening, allowed)
        val saved = context.devices(journalPrefix).entries.firstOrNull { operation.token in it.value["items"]?.obj().orEmpty() }
            ?: return@commit null to Unit
        val items = saved.value["items"]?.obj().orEmpty().toMutableMap()
        val item = items.getValue(operation.token)
        if (!pendingOperation(item, operation, includesRefused = opening != null)) return@commit null to Unit
        items[operation.token] = item.changed("state" to Json.of("refused"), "code" to Json.of(code))
        Gesture(emptyList(), local = listOf(DeviceWrite(saved.key, withItems(saved.value, items)))) to Unit
    } }

    fun deletedSets(): List<ImportDeletion> = engine.read(scope) { reader ->
        reader.devices(journalPrefix).values.flatMap { journal -> journal["items"]?.obj().orEmpty().flatMap { (token, item) ->
            if (item["kind"] != Json.of("finished") || item["state"] in setOf(Json.of("discarded"), Json.of("resolved"))) emptyList() else item["source"]?.get("deleted")?.arr().orEmpty()
                .filter { it !in item["resolvedDeleted"]?.arr().orEmpty() }.map { id -> ImportDeletion("$token:${id.str()}", item["targetSessionId"]?.str() ?: item.member("id").str(), id.str()) }
        } }
    }

    fun resolveDeletion(token: String) { engine.commit(scope) { context ->
        if (!writeAuthority()) throw TrainingRefused("account-changed", "The account changed. Open this again.")
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
            it["cacheConsumed"] != Json.of(true) }.map { item -> effectiveSource(item) } } }

    fun retireStartSources() { engine.commit(scope) { context ->
        if (!writeAuthority()) throw TrainingRefused("account-changed", "The account changed. Open this again.")
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

    fun keepWorkout(id: String, opening: ImportOpening? = null, allowed: () -> Boolean = { true }, corrected: SavedWorkout? = null) {
        val source = retainedWorkouts().firstOrNull { it.session.id == id }
        if (source == null) {
            if (opening == null) return
            engine.commit<Unit>(scope) { context ->
                if (!writeAuthority()) throw TrainingRefused("account-changed", "The account changed. Open this again.")
                requireOpening(context, opening, allowed)
                throw TrainingRefused("saved-workout-changed", reason("saved-workout-changed"))
            }
            return
        }
        if (source.session.isOpen) {
            val finish = corrected?.session?.finishedAtMs ?: checkNotNull(WorkoutFix(source.signedOut()).markFinished().finishedAt).ms
            val result = engine.commitWithPrerequisites(scope) { context ->
                if (!writeAuthority()) throw TrainingRefused("account-changed", "The account changed. Open this again.")
                requireOpening(context, opening, allowed)
                val saved = context.devices(journalPrefix).entries.firstOrNull { (_, journal) -> journal["items"]?.obj().orEmpty().values.any { it["id"] == Json.of(id) && it["kind"] == Json.of("start") && it["state"] == Json.of("refused") } }
                    ?: return@commitWithPrerequisites null to null
                val items = saved.value.member("items").obj().toMutableMap()
                val original = items.values.first { it["id"] == Json.of(id) && it["kind"] == Json.of("start") }.member("source")
                val entries = original["entries"]?.obj().orEmpty().values
                val sets = entries.filter { decode(it, OwedSet.serializer()).write != Owed.Delete }.map { it.member("set") }
                    .sortedWith(compareBy({ it.member("completedAt").long() }, { it.member("id").str() }))
                val savedCopy = Json.objectOf("session" to original.member("session").changed("finishedAt" to Json.of(finish)), "sets" to Json.Arr(sets),
                    "deleted" to Json.Arr(entries.filter { decode(it, OwedSet.serializer()).write == Owed.Delete }.map { it.member("set").member("id") }))
                val payload = corrected?.let { editedFinished(savedCopy, it, markFinished = true) } ?: savedCopy
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
            retainRejected(result, opening, allowed)
        } else retry(id, opening, allowed)
    }

    fun reconcileConfirmed() {
        engine.commitWithPrerequisites(scope) { context ->
            if (!writeAuthority()) throw TrainingRefused("account-changed", "The account changed. Open this again.")
            if (context.isAnonymous || !context.firstPullComplete() || context.checkpoint().cleanSeq == null) return@commitWithPrerequisites null to Unit
            val legacyRefusals = engine.refusedDeltas(context, scope, Gym.Codes.sessionFinished)
            val writes = context.devices(journalPrefix).mapNotNull { (key, journal) ->
                val before = journal["items"]?.obj().orEmpty()
                val items = before.mapValues { (_, item) ->
                    val refused = if (item["state"] == Json.of("resolved") && item["submissionGesture"] == null)
                        legacyRefusals.firstOrNull { matchesSubmittedSet(item, listOf(it.second)) } else null
                    if (refused != null) {
                        val gestureId = refused.first.removePrefix("notice:").substringBeforeLast('/')
                        val restored = context.confirmed(Gym.Types.set, refused.second.key.id) != null
                        item.changed("state" to Json.of(if (restored) "resolved" else "pending"), "fallback" to Json.of(true),
                            "submissionGesture" to Json.of(gestureId),
                            "recoveryGestures" to Json.Arr(item["recoveryGestures"]?.arr().orEmpty() + Json.of(gestureId)))
                    }
                    else if (item["kind"] == Json.of("operation") && item["state"] == Json.of("recovering") &&
                        item["recoveryGestures"]?.arr()?.lastOrNull()?.str()?.let { engine.pendingGesture(context, scope, it) } != true)
                        item.changed("state" to Json.of("refused"), "code" to Json.of("recovery-retry"))
                    else if (item["kind"] != Json.of("start") || item["state"] != Json.of("queued")) item else {
                        val session = decode(item.member("source").member("session"), Session.serializer())
                        val known = context.confirmed(Gym.Types.session, RecordID(session.id))?.takeIf { it.isVisible && it.born != null }
                        if (known == null) item else {
                            val reconciled = engine.reconcileConfirmedCommand(context, scope, item.member("gestureId").str(), Gym.Commands.start, RecordKey(Gym.Types.session, RecordID(session.id)))
                            if (!startedAs(known, session)) item.changed("state" to Json.of("refused"), "code" to Json.of("session-id-taken"))
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
            .flatMap { item ->
                if (item["kind"] == Json.of("operation") && item["state"] == Json.of("resolved")) item["recoveryGestures"]?.arr().orEmpty().map(Json::str)
                else if (item["kind"] == Json.of("finished") && item["state"] == Json.of("admitted")) listOfNotNull(item["resolvedGestureId"]?.str())
                else emptyList()
            }.toSet() }
        engine.notices("gym").notices.value.filter { !it.isDismissed && it.id in gestures.map { gesture -> "notice:$gesture/0" } }.forEach {
            if (!writeAuthority()) throw TrainingRefused("account-changed", "The account changed. Open this again.")
            engine.dismissNotice(it.id)
        }
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
            val unreadable = when (item["kind"]) {
                Json.of("finished") -> row == null
                Json.of("start") -> start == null
                Json.of("operation") -> operation == null
                else -> true
            }
            val code = if (unreadable) "source-unreadable" else item["code"]?.str() ?: "source-unreadable"
            val description = if (item["kind"] == Json.of("finished") && code in setOf("record-dead", "unknown-record")) reason("routine-missing") else reason(code)
            ImportRefusal(item.member("id").str(), row?.session ?: start,
                row?.sets ?: startSets ?: listOfNotNull(operation?.set), row?.deleted.orEmpty(), code, description,
                item["kind"]?.str().orEmpty(), row?.session?.id ?: start?.id ?: operation?.sessionId)
        } }
    }

    fun retry(id: String, opening: ImportOpening? = null, allowed: () -> Boolean = { true }) = editAndRetry(id, null, opening = opening, allowed = allowed)
    fun replaceAndRetry(id: String, corrected: SavedWorkout, markFinished: Boolean = false,
        expectedReplica: String? = null, expectedAnonymous: Boolean? = null,
        opening: ImportOpening? = null, allowed: () -> Boolean = { true }) =
        editAndRetry(id, Json.parse(diskJson.encodeToString(SavedWorkout.serializer(), corrected)), markFinished = markFinished,
            expectedReplica = expectedReplica, expectedAnonymous = expectedAnonymous, opening = opening, allowed = allowed)
    fun replaceStartAndRetry(id: String, corrected: Session, opening: ImportOpening? = null, allowed: () -> Boolean = { true }) {
        check(corrected.id == id && corrected.isOpen) { "An unfinished workout keeps its identity and remains unfinished." }
        editAndRetry(id, null, Json.parse(diskJson.encodeToString(Session.serializer(), corrected)), opening = opening, allowed = allowed)
    }

    fun replaceOpenAndRetry(id: String, corrected: SavedWorkout, opening: ImportOpening, allowed: () -> Boolean) {
        check(corrected.session.id == id && corrected.session.isOpen)
        editAndRetry(id, null, correctedOpen = corrected, opening = opening, allowed = allowed)
    }

    private fun editAndRetry(id: String, corrected: Json?, correctedStart: Json? = null, correctedOpen: SavedWorkout? = null,
        markFinished: Boolean = false, expectedReplica: String? = null, expectedAnonymous: Boolean? = null,
        opening: ImportOpening? = null, allowed: () -> Boolean = { true }) {
        val admitted = engine.commitWithPrerequisites(scope) { context ->
            if (!writeAuthority()) throw TrainingRefused("account-changed", "The account changed. Open this again.")
            requireOpening(context, opening, allowed)
            if (expectedReplica != null && (context.replica != expectedReplica || context.isAnonymous != expectedAnonymous))
                return@commitWithPrerequisites null to false
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
            if (item["state"] != Json.of("refused") && !(item["state"] == Json.of("pending") && item["code"] == Json.of("waiting-for-firstpull"))) return@commitWithPrerequisites null to true
            val before = item.member("source")
            if (corrected != null && unknownFinishedFields(before)) throw IllegalStateException(reason("source-needs-update"))
            var source = corrected?.let { editedFinished(before, decode(it, SavedWorkout.serializer()), markFinished) } ?: correctedOpen?.let { editedStart(before, it) } ?: correctedStart?.let { before.changed("session" to it) } ?: before
            if (corrected != null && !markFinished) {
                val closure = before["session"]?.obj().orEmpty().filterKeys { it in setOf("closedItself", "closedBy") }
                source = source.changed("session" to Json.Obj((source.member("session").obj() + closure).toList()))
            }
            val kind = item.member("kind").str()
            check(corrected == null || kind == "finished") { "Only a finished workout can be edited here." }
            check(correctedStart == null && correctedOpen == null || kind == "start") { "Only an unfinished workout can be edited here." }
            if (kind in setOf("finished", "start")) check(source.member("session").member("id").str() == id) { "A saved workout keeps its identity." }
            val childWrites = if (correctedOpen == null) emptyList() else all.mapNotNull { (childKey, childJournal) ->
                val previous = childJournal["items"]?.obj().orEmpty()
                val children = previous.mapValues { (_, child) ->
                    if (child["kind"] != Json.of("operation") || child["source"]?.get("sessionId") != Json.of(id) ||
                        child["state"] in setOf(Json.of("resolved"), Json.of("discarded"))) child
                    else {
                        val entry = source.member("entries").obj()[child.member("id").str()]
                        if (entry == null || entry == child["source"]) child
                        else child.changed("source" to entry, "code" to null,
                            "state" to Json.of(if (decode(entry, OwedSet.serializer()).let { it.write == Owed.Delete && !it.attempted }) "discarded" else "pending"))
                    }
                }
                if (children == previous) null
                else if (childKey == key) { items.putAll(children); null }
                else DeviceWrite(childKey, withItems(childJournal, children))
            }
            val gesture = try {
                if (corrected != null || correctedOpen != null) floorEdits(item, signedOutSource(item, source), context, context.now)
                gesture(Item(item.member("seat").str(), kind, id, source), context)
            } catch (refusal: RefusedImport) {
                val changed = item.changed("source" to source, "state" to Json.of(if (refusal.code == "waiting-for-firstpull") "pending" else "refused"), "code" to Json.of(refusal.code),
                    "original" to (item["original"] ?: item.member("source")))
                items[token] = changed
                return@commitWithPrerequisites Gesture(emptyList(), local = childWrites + DeviceWrite(key, withItems(journal, items))) to true
            }
            val gestureId = context.opaqueID()
            gesture.gestureId = gestureId
            items[token] = item.changed("source" to source, "state" to Json.of(if (gesture.command != null) "queued" else if (kind == "operation") "pending" else if (kind in setOf("finished", "start")) "admitted" else "migrated"), "gestureId" to Json.of(gestureId),
                "original" to (item["original"] ?: item.member("source")), "code" to null)
            if (kind == "finished" && gesture.command == null && item["gestureId"] != null)
                items[token] = items.getValue(token).changed("resolvedGestureId" to item.member("gestureId"))
            gesture.local += childWrites + DeviceWrite(key, withItems(journal, items))
            gesture to true
        }.second
        if (!admitted) throw TrainingRefused("account-changed", "The account changed. Open this again.")
        if (opening == null || engine.activeReplica() == opening.replica && allowed()) dismissResolvedNotices()
    }

    fun discardedWorkout(id: String): Boolean = engine.read(scope) { reader ->
        reader.devices(journalPrefix).values.any { journal -> journal["items"]?.obj().orEmpty().values.any { item ->
            item["id"] == Json.of(id) && item["kind"] in setOf(Json.of("finished"), Json.of("start")) && item["state"] == Json.of("discarded")
        } }
    }

    fun discardRefusal(id: String, opening: ImportOpening? = null, allowed: () -> Boolean = { true }) { engine.commit(scope) { context ->
        if (!writeAuthority()) throw TrainingRefused("account-changed", "The account changed. Open this again.")
        requireOpening(context, opening, allowed)
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
            val count = items.values.filter { it["state"] in setOf(Json.of("pending"), Json.of("refused"), Json.of("retained"), Json.of("recovering")) }
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
        // An unfinished workout's source as a finished one reads: its session and the set each owed entry holds.
        private fun authored(start: Json) = Json.objectOf("session" to start.member("session"),
            "sets" to Json.Arr(start["entries"]?.obj().orEmpty().values.map { it.member("set") }))
        private fun journal(reader: ScopeReader, key: String) = reader.device(key) ?: Json.objectOf("version" to Json.of(1), "items" to Json.objectOf())
        // The saved copy as the domain reads it, for the checks this phone runs before asking the account.
        private fun SavedWorkout.signedOut(finishedAtMs: Long? = session.finishedAtMs): SignedOutWorkout {
            val id = Id(session.id, SyncSession)
            val saved = SyncSession(id, Instant(session.startedAtMs), finishedAtMs?.let(::Instant), if (finishedAtMs == null) null else "finish",
                session.routineId?.let { Id(it, SyncRoutine) }, plan = SyncPlan.decode(session.plan?.let(::planFields)))
            return SignedOutWorkout(saved, sets.map { it.synced(id) })
        }
        // A saved set as the domain reads it, under the workout that holds it.
        private fun TrainingSet.synced(session: Id<SyncSession>) = SyncSet(Id(id, SyncSet), session, Id(exerciseId, SyncExercise),
            weightKg, reps, rpe, note, Instant(completedAtMs), setNumber)
        private val ServerCommand.command: Command get() = Command(name, Json.Obj(args.toList()))
        // A refusal this phone predicts, under the journal's code: the bounded label recovery reports everywhere.
        private fun code(refusal: GymRefusal): String = WorkoutRecovery.Reason.of(refusal).label
        // A journal source may carry an earlier shape of a frozen plan's targets; it is read in this build's shape.
        private fun <T> decode(value: Json, serializer: kotlinx.serialization.KSerializer<T>): T =
            diskJson.decodeFromJsonElement(serializer, StoredDocument.migrated(diskJson.parseToJsonElement(value.jcs)))
        // The account's session under a saved workout's id is the start this phone saved: the same start, plan and routine.
        private fun startedAs(known: Record, session: Session): Boolean {
            val expected = sessionFields(session)
            return known.values["startedAt"] == expected["startedAt"] && (known.values["plan"] ?: Json.Null) == expected["plan"] &&
                (known.values["historyRoutineId"] ?: known.values["routineId"] ?: Json.Null) == expected["historyRoutineId"]
        }
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

        private fun effectiveSource(item: Json): Json {
            val source = item.member("source")
            val target = item["targetSessionId"] ?: return source
            if (item["kind"] != Json.of("start")) return source
            val session = source["session"] ?: return source
            val entries = source["entries"]?.obj().orEmpty().mapValues { (_, entry) -> entry.changed("sessionId" to target) }
            return source.changed("session" to session.changed("id" to target), "entries" to Json.Obj(entries.toList()))
        }

        private fun matchesSubmittedSet(item: Json, deltas: List<works.windmill.sync.core.Delta>): Boolean {
            if (item["kind"] != Json.of("operation")) return false
            val entry = decode(item.member("source"), OwedSet.serializer())
            if (entry.write == Owed.Delete) return false
            val set = entry.set.synced(Id(RecordID(item["targetSessionId"] ?: Json.of(entry.sessionId)), SyncSession))
            return deltas.any { SavedSets.createdBy(set, it) }
        }

        val intentResultWrites: IntentResultDeviceWrites = { intent, result, _, gestureId, values ->
            val command = intent.command
            values.filterKeys { it.startsWith(journalPrefix) }.map { (key, journal) ->
                val items = journal["items"]?.obj().orEmpty().mapValues { (_, item) ->
                    val submitted = item["state"] == Json.of("submitted") && item["submissionGesture"] == Json.of(gestureId)
                    val legacy = item["state"] == Json.of("resolved") && item["submissionGesture"] == null && matchesSubmittedSet(item, intent.deltas)
                    val recovering = item["kind"] == Json.of("operation") && item["state"] == Json.of("recovering") &&
                        item["recoveryGestures"]?.arr()?.lastOrNull() == Json.of(gestureId)
                    if (submitted || legacy || recovering) {
                        when (val verdict = result.verdict) {
                            is PushResult.Verdict.Ok -> {
                                val next = if (recovering) item["recoveryPhase"]?.str()?.let { StrandedSet.Step.of(it).next?.name } else null
                                item.changed("state" to Json.of(if (next == null) "resolved" else "pending"), "code" to null,
                                    "submissionGesture" to (if (legacy) Json.of(gestureId) else item["submissionGesture"]),
                                    "recoveryPhase" to next?.let(Json::of))
                            }
                            is PushResult.Verdict.Refused -> {
                                val code = verdict.code.text
                                when {
                                    code in setOf("clock-skew", "base-unknown") -> item
                                    code == "session-finished" -> item.changed("state" to Json.of("pending"), "code" to null,
                                        "submissionGesture" to (if (legacy) Json.of(gestureId) else item["submissionGesture"]),
                                        "fallback" to Json.of(true), "recoveryPhase" to null, "recoverySessionId" to null, "recoverySetId" to null,
                                        "recoveryGestures" to Json.Arr(item["recoveryGestures"]?.arr().orEmpty() + Json.of(gestureId)))
                                    recovering && command?.name == Gym.Commands.correctSession && code in setOf("invalid", "too-large", "bad-instant", "session-overlap") ->
                                        item.changed("state" to Json.of("refused"), "code" to Json.of("recovery-retry"), "fallback" to Json.of(true))
                                    else -> item.changed("state" to Json.of("refused"), "code" to Json.of(when {
                                        recovering && code == "stale" -> "recovery-stale"
                                        recovering && code == "session-open" -> "recovery-session-open"
                                        else -> code
                                    }))
                                }
                            }
                        }
                    } else if (command == null || command.name !in setOf(Gym.Commands.importSession, Gym.Commands.start)) item
                    else {
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
            "account-changed" -> "The account changed. Open this again."
            "saved-workout-changed" -> "This saved workout changed. Open it again."
            "recovery-unavailable" -> "The original workout is still saved on this phone. Recovery could not be completed."
            "session-open" -> "Another workout is open on the account. Inspect this saved workout, then choose Keep to save it as a finished workout at its last set."
            "session-overlap" -> "This workout overlaps another workout. Correct its dates or times, then retry."
            "session-id-taken", "id-taken", "id-spent" -> "A workout with this identity is already on the log. Review that workout before retrying; this original stays on this phone."
            "bad-instant", "clock-skew" -> "The workout has a future or invalid time. Correct its dates or times, then retry."
            "too-many-sets", "too-large" -> "This workout exceeds the import limit. Edit the workout explicitly, then retry."
            "frozen-plan-changed", "routine-missing", "stale" -> "The linked routine differs from this workout’s saved plan. Restore that routine or explicitly remove the link, then retry."
            "source-numbering" -> "This workout’s saved set numbers cannot be imported unchanged. The original stays on this phone."
            "source-auto-closed" -> "This workout closed automatically. Explicitly mark it finished before retrying."
            "source-needs-update" -> "This saved workout includes fields this build cannot preserve. Keep it on this phone and update the app."
            "source-unreadable" -> "This saved training cannot be read by this build. Keep it on this phone and update the app."
            "unknown-exercise" -> "A movement is missing. Restore the movement, then retry."
            "invalid-set" -> "A saved set holds a value the log does not accept. Correct the set, then retry."
            "parent-dead" -> "A linked movement or routine was refused. Restore it, then retry this workout."
            "session-finished" -> "This set is saved on this phone. Retry restores it to the account, in a separate workout when needed."
            "recovery-session-open" -> "Finish the account’s open workout, then retry saving this set as a separate workout."
            "recovery-stale" -> "This workout changed while its saved set was being restored. Retry uses the latest workout."
            "recovery-retry" -> "This set is still saved on this phone. Retry saving it to the account."
            else -> "This workout was refused ($code). Correct the saved workout, then retry."
        }
    }
}
