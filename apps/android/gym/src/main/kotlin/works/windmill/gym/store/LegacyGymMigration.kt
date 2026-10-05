package works.windmill.gym.store

import java.io.File
import kotlinx.serialization.Serializable
import works.windmill.domain.kit.*
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.domain.sync.ImportSession
import works.windmill.gym.domain.sync.ImportedSet
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.api.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.PushResult
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.Sha256
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineCrash
import works.windmill.sync.engine.DeviceValueRewrite
import works.windmill.sync.engine.migrateLegacy
import works.windmill.sync.engine.confirmedLegacyRecords
import works.windmill.sync.engine.commitLegacy
import works.windmill.sync.schema.Gym
import works.windmill.gym.domain.sync.Session as SyncSession
import works.windmill.gym.domain.sync.TrainingSet as SyncSet
import works.windmill.gym.domain.sync.Exercise as SyncExercise
import works.windmill.gym.domain.sync.Routine as SyncRoutine

@Serializable
data class LegacyMigrationRefusal(val id: String, val session: Session?, val sets: List<TrainingSet>,
    val deletedSetIds: List<String>, val code: String, val reason: String, val unrecognizedKindSetIds: List<String> = emptyList())

data class LegacyOperation(val token: String, val sessionId: String, val entry: SetQueue.Entry)
data class LegacyDeletedSet(val token: String, val sessionId: String, val setId: String)
data class LegacyEdit(val token: String, val kind: String, val id: String, val source: Json?, val base: Json)

class LegacyGymMigration(private val filesDir: File, private val engine: Engine,
    private val deviceOwner: String? = null, private val telemetry: Telemetry = Telemetry.None) {
    @Serializable
    private data class Archive(val version: Int = 1, val owner: String? = null, val documents: Map<String, String>, val completed: Boolean = false)
    private data class Item(val seat: String, val kind: String, val id: String, val payload: Json, val discarded: Boolean = false, val sourceSeat: String = seat) {
        val token = Sha256.hex(Json.array(Json.of(seat), Json.of(sourceSeat), Json.of(kind), Json.of(id), payload).jcs.toByteArray())
        fun matches(captured: works.windmill.gym.domain.ClaimItem): Boolean {
            if (captured.source.seat != sourceSeat || captured.revision != claimRevision(captured.payload)) return false
            val expected = when (kind) {
                "exercise" -> works.windmill.gym.domain.ClaimKind.Movement
                "routine" -> works.windmill.gym.domain.ClaimKind.Routine
                "finished" -> works.windmill.gym.domain.ClaimKind.Session
                "start", "operation" -> works.windmill.gym.domain.ClaimKind.Queue
                "preferences" -> works.windmill.gym.domain.ClaimKind.Preferences
                "weighin" -> works.windmill.gym.domain.ClaimKind.Bodyweight
                else -> return false
            }
            if (captured.kind != expected) return false
            return try {
                val frozen = Json.parse(captured.payload)
                (captured.id == id && frozen == payload) || (kind == "operation" && frozen["entries"]?.get(id) == payload)
            } catch (_: Exception) { false }
        }
    }

    fun run() {
        try {
            val archiveFile = File(filesDir, archiveName)
            val archive = if (archiveFile.exists()) diskJson.decodeFromString(Archive.serializer(), archiveFile.readText())
            else Archive(owner = deviceOwner, documents = sourceFiles.mapNotNull { name ->
                File(filesDir, name).takeIf(File::exists)?.let { name to it.readText() }
            }.toMap()).also { AtomicDocument.write(archiveFile, diskJson.encodeToString(Archive.serializer(), it)) }
            check(archive.version == 1) { "The saved training uses an unsupported migration format." }
            dismissResolvedNotices(engine)
            if (archive.completed) return
            val items = collect(archive)
            val consent = archive.documents[LocalClaimConsent.fileName]?.let { try { LocalClaimConsent.decode(it) } catch (_: Exception) { null } }
            val attributed = items.map { item ->
                val captured = consent?.batch?.items?.firstOrNull { item.matches(it) }
                when {
                    captured == null -> item
                    consent is works.windmill.gym.domain.ClaimConsent.Approved -> item.copy(seat = Seat.of(consent.owner))
                    consent is works.windmill.gym.domain.ClaimConsent.Discarding -> item.copy(discarded = true)
                    else -> item
                }
            }
            val ordered = attributed.sortedWith(compareBy<Item>({ if (it.kind == "exercise") 0 else if (it.kind == "routine") 1 else 2 },
                { if (it.kind == "finished") it.payload["session"]?.get("startedAt")?.long() ?: 0L else 0L }, { it.token }))
            if (archive.owner != null) engine.migrateLegacy(archive.owner, scope, activate = true) { null to Unit }
            for (item in ordered) migrate(item)
            AtomicDocument.write(archiveFile, diskJson.encodeToString(Archive.serializer(), archive.copy(completed = true)))
            telemetry.event("gym_migration_completed", mapOf("outcome" to if (refusals(engine).isEmpty()) "success" else "refused"))
        } catch (crash: EngineCrash) {
            throw crash
        } catch (failure: Exception) {
            telemetry.failure("gym.migration", failure)
            throw failure
        }
    }

    private fun collect(archive: Archive): List<Item> = buildList {
        for ((file, text) in archive.documents) {
            val document = try { Json.parse(text) } catch (_: Exception) {
                add(Item(Seat.of(archive.owner), "unreadable", file, Json.of(text))); continue
            }
            if (document !is Json.Obj) { add(Item(Seat.of(archive.owner), "unreadable", file, document)); continue }
            try { when (file) {
                LocalLog.fileName -> {
                    val shelves = document["shelves"]?.obj() ?: mapOf((archive.owner?.let(Seat::of) ?: Seat.quarantine) to document)
                    for ((seat, shelf) in shelves) {
                        for (exercise in shelf["exercises"]?.arr().orEmpty()) add(Item(seat, "exercise", exercise.member("id").str(), exercise))
                        for (routine in shelf["routines"]?.arr().orEmpty()) add(Item(seat, "routine", routine.member("id").str(), routine))
                        for (finished in shelf["finished"]?.arr().orEmpty()) add(Item(seat, "finished", finished.member("session").member("id").str(), finished))
                    }
                }
                SetQueue.fileName -> {
                    val queues = document["queues"]?.obj() ?: mapOf((archive.owner?.let(Seat::of) ?: Seat.quarantine) to document)
                    for ((seat, queue) in queues) {
                        queue["session"]?.takeIf { it is Json.Obj }?.let { add(Item(seat, "start", it.member("id").str(), queue)) }
                        for ((id, entry) in queue["entries"]?.obj().orEmpty()) {
                            if (entry["needsPush"]?.bool() == true || entry["attempted"]?.bool() == true)
                                add(Item(seat, "operation", id, entry))
                        }
                    }
                }
                LocalPreferences.fileName -> {
                    val shelves = document["shelves"]?.obj() ?: mapOf(Seat.of(document["owner"]?.orNull()?.str()) to document)
                    for ((seat, shelf) in shelves) if (shelf["document"] is Json.Obj) add(Item(seat,
                        if (seat == Seat.anonymous || shelf["owed"]?.bool() == true) "preferences" else "cachePreferences", "prefs", shelf.member("document")))
                }
                LocalBodyweight.fileName -> for ((seat, shelf) in document["shelves"]?.obj().orEmpty()) {
                    val owed = shelf["owed"]?.arr().orEmpty().map(Json::str)
                    for ((date, entry) in shelf["entries"]?.obj().orEmpty()) add(Item(seat,
                        if (seat == Seat.anonymous || date in owed) "weighin" else "cacheWeighin", date, entry))
                    for (date in shelf["deleted"]?.arr().orEmpty()) add(Item(seat, "deleteWeighin", date.str(), date))
                }
                DeviceCopy.fileName -> add(Item(Seat.of(document["owner"]?.orNull()?.str()), "cache", file, document))
                LocalClaimConsent.fileName -> add(Item(Seat.of(archive.owner), "consent", file, document))
            } } catch (_: Exception) { add(Item(Seat.of(archive.owner), "unreadable", file, document)) }
        }
    }

    private fun migrate(item: Item) {
        val owner = item.seat.takeIf { it.startsWith("u.") && it.length > 2 }?.removePrefix("u.")
        val result = engine.migrateLegacy(owner, scope) { context ->
            val key = key(item.seat)
            val journal = journal(context, key)
            if (item.token in journal["items"]?.obj().orEmpty()) return@migrateLegacy null to Unit
            val saved = Json.objectOf("id" to Json.of(item.id), "kind" to Json.of(item.kind), "seat" to Json.of(item.seat),
                "source" to item.payload, "sourceSeat" to Json.of(item.sourceSeat), "state" to Json.of("retained"))
            val items = journal["items"]?.obj().orEmpty().toMutableMap()
            var gesture = Gesture(emptyList())
            var value = saved
            try {
                if (item.discarded) {
                    items[item.token] = saved.changed("state" to Json.of("discarded"))
                    return@migrateLegacy Gesture(emptyList(), local = listOf(DeviceWrite(key, withItems(journal, items)))) to Unit
                }
                if (item.seat != Seat.anonymous && !(item.seat.startsWith("u.") && item.seat.length > 2))
                    throw RefusedMigration("identity-unresolved")
                gesture = gesture(item, context, engine)
                value = saved.changed("state" to Json.of(if (gesture.command != null) "queued" else if (item.kind == "operation") "pending" else if (item.kind == "finished") "admitted" else "migrated"))
                if (gesture.command != null) {
                    val gestureId = context.opaqueID()
                    gesture.gestureId = gestureId
                    value = value.changed("gestureId" to Json.of(gestureId))
                }
            } catch (failure: RefusedMigration) {
                value = saved.changed("state" to Json.of(if (failure.code == "waiting-for-firstpull") "pending" else "refused"), "code" to Json.of(failure.code))
            } catch (_: Exception) {
                value = saved.changed("state" to Json.of("refused"), "code" to Json.of("source-unreadable"))
            }
            items[item.token] = value
            gesture.local = gesture.local + DeviceWrite(key, withItems(journal, items))
            gesture to Unit
        }
        if (result.first is CommitOutcome.Refused) {
            val code = (result.first as CommitOutcome.Refused).code.text
            engine.migrateLegacy(owner, scope) { context ->
                val key = key(item.seat)
                val journal = journal(context, key)
                val items = journal["items"]?.obj().orEmpty() + (item.token to Json.objectOf("id" to Json.of(item.id),
                    "kind" to Json.of(item.kind), "seat" to Json.of(item.seat), "sourceSeat" to Json.of(item.sourceSeat), "source" to item.payload,
                    "state" to Json.of("refused"), "code" to Json.of(code)))
                Gesture(emptyList(), local = listOf(DeviceWrite(key, withItems(journal, items)))) to Unit
            }
        }
    }


    companion object {
        const val archiveName = "windmill-gym-engine-migration.json"
        const val journalPrefix = "rack:legacyMigration"
        private fun key(seat: String) = journalPrefix + Sha256.hex(seat.toByteArray()).take(16)
        val scope = ScopeRef(Gym.scope)
        private val sourceFiles = listOf(SetQueue.fileName, LocalLog.fileName, DeviceCopy.fileName,
            LocalPreferences.fileName, LocalBodyweight.fileName, LocalClaimConsent.fileName)
        private class RefusedMigration(val code: String) : Exception(code)
        private fun Json.changed(vararg values: Pair<String, Json?>) = Json.Obj(obj().toMutableMap().apply {
            values.forEach { (key, value) -> if (value == null) remove(key) else put(key, value) }
        }.toList())
        private fun withItems(journal: Json, items: Map<String, Json>): Json {
            val count = items.values.filter { it["state"] in setOf(Json.of("pending"), Json.of("refused"), Json.of("retained")) }
                .groupingBy { item -> when (item["kind"]?.str()) {
                    "finished", "start" -> Gym.Types.session
                    "operation" -> Gym.Types.set
                    "routine" -> Gym.Types.routine
                    "exercise" -> Gym.Types.exercise
                    "weighin", "deleteWeighin" -> Gym.Types.weighin
                    "preferences" -> Gym.Types.prefs
                    "cacheEdit" -> item.member("editKind").str()
                    else -> "pending"
                } }.eachCount().toMutableMap()
            val deleted = items.values.sumOf { item ->
                if (item["kind"] != Json.of("finished") || item["state"] == Json.of("discarded")) 0 else item["source"]?.get("deleted")?.arr().orEmpty()
                    .count { it !in item["resolvedDeleted"]?.arr().orEmpty() }
            }
            if (deleted > 0) count[Gym.Types.set] = (count[Gym.Types.set] ?: 0) + deleted
            return journal.changed("items" to Json.Obj(items.toList()), "count" to Json.Obj(count.map { it.key to Json.of(it.value) }))
        }
        private fun journal(reader: ScopeReader, key: String) = reader.device(key) ?: Json.objectOf("version" to Json.of(1), "items" to Json.objectOf())
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

        private fun gesture(item: Item, context: CommitContext, engine: Engine): Gesture = when (item.kind) {
            "finished" -> imported(item.payload, context, engine)
            "exercise" -> {
                val exercise = decode(item.payload, works.windmill.gym.domain.Exercise.serializer())
                val values = mapOf("name" to Json.of(exercise.name), "pattern" to Json.of(exercise.pattern), "equipment" to Json.of(exercise.equipment),
                    "stepKg" to Json.of(exercise.stepKg ?: works.windmill.gym.domain.sync.ExerciseRules.defaultStepKg(exercise.equipment)))
                if (!exercise.custom && works.windmill.gym.domain.sync.SeedExercises.all.any { it.id.record.string == exercise.id })
                    Gesture(listOf(Change.write(Gym.Types.exerciseName, RecordID(exercise.id), mapOf("name" to Json.of(exercise.name)))))
                else Gesture(listOf(Change.create(Gym.Types.exercise, NewID.Given(RecordID(exercise.id)), values)))
            }
            "routine" -> {
                val routine = decode(item.payload, works.windmill.gym.domain.Routine.serializer())
                val entries = routine.entries.sortedBy { it.position }.map { entry -> Json.Obj(buildList {
                    add("exerciseId" to Json.of(entry.exerciseId))
                    if (entry.sets.isNotEmpty()) add("sets" to Json.parse(diskJson.encodeToString(kotlinx.serialization.builtins.ListSerializer(works.windmill.gym.domain.SetTarget.serializer()), entry.sets)))
                }) }
                Gesture(listOf(Change.create(Gym.Types.routine, NewID.Given(RecordID(routine.id)), mapOf("name" to Json.of(routine.name),
                    "position" to Json.of(routine.position), "entries" to Json.Arr(entries)))))
            }
            "start" -> {
                if (item.payload["entries"]?.obj().orEmpty().values.any { unknownKind(it.member("set")) }) throw RefusedMigration("source-kind")
                val session = decode(item.payload.member("session"), Session.serializer())
                val args = mutableMapOf("id" to Json.of(session.id), "startedAt" to Json.of(session.startedAtMs), "joinOpenSession" to Json.of(true))
                session.routineId?.let { args["routineId"] = Json.of(it) }
                val predict = Change.create(Gym.Types.session, NewID.Given(RecordID(session.id)), sessionFields(session))
                Gesture(emptyList(), command = Command(Gym.Commands.start, Json.Obj(args.toList())), predict = listOf(predict), local = buildList {
                    item.payload["order"]?.takeIf { it is Json.Arr }?.let { add(DeviceWrite("movementOrder:${session.id}", it)) }
                    item.payload["chosenMovement"]?.takeIf { it is Json.Str }?.let { add(DeviceWrite("movement:${session.id}", it)) }
                    item.payload["workout"]?.takeIf { it is Json.Obj }?.let { add(DeviceWrite("rack:${session.id}", it)) }
                })
            }
            "preferences" -> Gesture(listOf(Change.write(Gym.Types.prefs, RecordID("prefs"), item.payload.obj())))
            "weighin" -> {
                val row = decode(item.payload, works.windmill.gym.domain.WeighIn.serializer())
                if (row.recordedAt < 0) throw RefusedMigration("weighin-source-correction")
                val day = LocalDay.parse(row.dateLocal) ?: throw RefusedMigration("weighin-source-correction")
                val moment = Moment(Instant(context.now), FixedZone(java.time.ZoneId.systemDefault().rules.getOffset(java.time.Instant.ofEpochMilli(context.now)).totalSeconds))
                val value = works.windmill.gym.domain.sync.WeighIn(day, row.weightKg, Instant(row.recordedAt))
                val checked = try { Valid(value, works.windmill.gym.domain.sync.WeighIn, fields = listOf("kg"), at = moment).value }
                    catch (_: Violation) { throw RefusedMigration("weighin-source-correction") }
                if (checked != value) throw RefusedMigration("weighin-source-correction")
                Gesture(listOf(Change.put(Gym.Types.weighin, RecordID(item.id), true, value.fields())))
            }
            "deleteWeighin" -> Gesture(listOf(Change.put(Gym.Types.weighin, RecordID(item.id), false)))
            "consent" -> {
                LocalClaimConsent.decode(item.payload.jcs)
                Gesture(emptyList())
            }
            "unreadable" -> throw RefusedMigration("source-unreadable")
            "operation" -> {
                if (unknownKind(item.payload.member("set"))) throw RefusedMigration("source-kind")
                Gesture(emptyList())
            }
            else -> Gesture(emptyList())
        }

        private fun imported(source: Json, context: CommitContext, engine: Engine): Gesture {
            if (unknownFinishedFields(source)) throw RefusedMigration("source-needs-update")
            if (source["sets"]?.arr().orEmpty().any { set ->
                    set["kind"]?.str()?.let { it !in setOf("warmup", "working", "drop", "failure") } == true
                }) throw RefusedMigration("source-kind")
            val row = decode(source, LocalLog.FinishedSession.serializer())
            val session = row.session
            val finished = session.finishedAtMs ?: throw RefusedMigration("bad-instant")
            if (source["session"]?.get("closedItself") == Json.of(true) || source["session"]?.get("closedBy") == Json.of("stale"))
                throw RefusedMigration("source-auto-closed")
            if (session.startedAtMs > context.now || finished > context.now) throw RefusedMigration("bad-instant")
            if (row.sets.any { it.id in row.deleted }) throw RefusedMigration("deleted-set-conflict")
            if (confirmedEquivalent(row, context, engine)) return Gesture(emptyList())
            if (context.drawn(Gym.Types.session, RecordID(session.id)) != null) throw RefusedMigration("session-id-taken")
            if (!context.isAnonymous && (!context.firstPullComplete() || context.checkpoint().cleanSeq == null))
                throw RefusedMigration("waiting-for-firstpull")
            if (row.sets.size > 200) throw RefusedMigration("too-many-sets")
            val numbers = mutableMapOf<String, Int>()
            row.sets.forEach { set ->
                val next = (numbers[set.exerciseId] ?: 0) + 1
                if (set.setNumber != null && set.setNumber != next) throw RefusedMigration("source-numbering")
                numbers[set.exerciseId] = next
            }
            val routine = session.routineId?.let { context.drawn(Gym.Types.routine, RecordID(it))?.takeIf { row -> row.isVisible } }
            val currentPlan = routine?.let { Json.objectOf("routine" to it.values.getValue("name"), "entries" to it.values.getValue("entries")) }
            val frozenPlan = sessionFields(session).getValue("plan")
            if ((currentPlan ?: Json.Null) != frozenPlan) throw RefusedMigration("frozen-plan-changed")
            if (session.routineId != null && routine == null) throw RefusedMigration("routine-missing")
            val reader = Reader(context, scope, Moment(Instant(context.now), FixedZone(0)), works.windmill.sync.schema.SyncSchema.registry)
            val action = ImportSession(Id(session.id, SyncSession), Instant(session.startedAtMs), Instant(finished), row.sets.map { set ->
                val value = SyncSet(Id(set.id, SyncSet), Id(session.id, SyncSession), Id(set.exerciseId, SyncExercise), set.weightKg, set.reps,
                    set.kind.wire, set.rpe, set.note, Instant(set.completedAtMs), set.setNumber)
                if (Valid(value, SyncSet, at = reader.moment).value != value) throw RefusedMigration("source-needs-correction")
                ImportedSet(value.id, value.exerciseId, value.weightKg, value.reps, value.completedAt, value.kind, value.rpe, value.note, true)
            }, session.routineId?.let { Id(it, SyncRoutine) })
            val loaded = action.load(reader)
            if (loaded.state.overlap(Instant(session.startedAtMs), Instant(finished), Id(session.id, SyncSession)) != null)
                throw RefusedMigration("session-overlap")
            return when (val decision = action.decision(loaded, IDSource(context))) {
                is Decision.Write -> decision.plan.gesture(scope, works.windmill.sync.schema.SyncSchema.registry).also { gesture ->
                    gesture.atomic = true
                    if (session.routineId != null) {
                        gesture.changes += Change.update(Gym.Types.routine, RecordID(session.routineId))
                        gesture.guards += listOf("name", "entries").map { field -> RegisterRef(Gym.Types.routine, RecordID(session.routineId), field) }
                    }
                    gesture.predict = gesture.predict.map { change -> if (change.type == Gym.Types.session) change.copy(values = sessionFields(session)) else change }
                }
                is Decision.Refuse -> throw RefusedMigration(if (decision.refusal is GymRefusal.Invalid) "source-needs-correction" else "bad-instant")
                is Decision.Unchanged -> Gesture(emptyList())
            }
        }

        private fun confirmedEquivalent(source: LocalLog.FinishedSession, context: CommitContext, engine: Engine): Boolean {
            if (context.isAnonymous || !context.firstPullComplete() || context.checkpoint().cleanSeq == null) return false
            val session = context.confirmed(Gym.Types.session, RecordID(source.session.id))?.takeIf { it.isVisible && it.born != null } ?: return false
            val expected = sessionFields(source.session)
            if (listOf("startedAt", "finishedAt", "closedBy", "plan").any { (session.values[it] ?: Json.Null) != expected.getValue(it) }) return false
            val historicalRoutine = session.values["historyRoutineId"] ?: session.values["routineId"] ?: Json.Null
            if (historicalRoutine != expected.getValue("historyRoutineId")) return false
            val sets = engine.confirmedLegacyRecords(context, scope, Gym.Types.set).filter { it.isVisible && it.values["sessionId"] == Json.of(source.session.id) }
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

        fun operations(engine: Engine): List<LegacyOperation> = engine.read(scope) { reader -> reader.devices(journalPrefix).values.flatMap { journal -> journal["items"]?.obj().orEmpty().mapNotNull { (token, item) ->
            if (item.member("kind").str() != "operation" || item.member("state").str() != "pending") return@mapNotNull null
            val entry = decode(item.member("source"), SetQueue.Entry.serializer())
            LegacyOperation(token, item["targetSessionId"]?.str() ?: entry.sessionId, entry)
        } } }

        fun resolveOperation(engine: Engine, token: String) { engine.commit(scope) { context ->
            val saved = context.devices(journalPrefix).entries.firstOrNull { token in it.value["items"]?.obj().orEmpty() }
                ?: return@commit null to Unit
            val key = saved.key
            val journal = saved.value
            val items = journal["items"]?.obj().orEmpty().toMutableMap()
            val item = items[token] ?: return@commit null to Unit
            items[token] = item.changed("state" to Json.of("resolved"))
            Gesture(emptyList(), local = listOf(DeviceWrite(key, withItems(journal, items)))) to Unit
        } }

        fun refuseOperation(engine: Engine, token: String, code: String) { engine.commit(scope) { context ->
            val saved = context.devices(journalPrefix).entries.firstOrNull { token in it.value["items"]?.obj().orEmpty() }
                ?: return@commit null to Unit
            val items = saved.value["items"]?.obj().orEmpty().toMutableMap()
            val item = items.getValue(token)
            items[token] = item.changed("state" to Json.of("refused"), "code" to Json.of(code))
            Gesture(emptyList(), local = listOf(DeviceWrite(saved.key, withItems(saved.value, items)))) to Unit
        } }

        fun deferEdit(engine: Engine, kind: String, id: String, source: Json?, base: Json) {
            require(kind in setOf(Gym.Types.exercise, Gym.Types.routine))
            engine.commit(scope) { context ->
                val key = key("edit:${context.replica}")
                val journal = journal(context, key)
                val items = journal["items"]?.obj().orEmpty().toMutableMap()
                val token = Sha256.hex(Json.array(Json.of("cacheEdit"), Json.of(kind), Json.of(id)).jcs.toByteArray())
                val previous = items[token]
                items[token] = Json.objectOf("id" to Json.of(id), "kind" to Json.of("cacheEdit"), "editKind" to Json.of(kind),
                    "source" to (source ?: Json.Null), "base" to (previous?.get("base") ?: base), "state" to Json.of("pending"))
                Gesture(emptyList(), local = listOf(DeviceWrite(key, withItems(journal, items)))) to Unit
            }
        }

        fun edits(engine: Engine): List<LegacyEdit> = engine.read(scope) { reader ->
            reader.devices(journalPrefix).values.flatMap { journal -> journal["items"]?.obj().orEmpty().mapNotNull { (token, item) ->
                if (item["kind"] != Json.of("cacheEdit") || item["state"] != Json.of("pending")) null
                else LegacyEdit(token, item.member("editKind").str(), item.member("id").str(), item.member("source").orNull(), item.member("base"))
            } }
        }
        fun resolveEdit(engine: Engine, token: String) = resolveOperation(engine, token)
        fun refuseEdit(engine: Engine, token: String, code: String) = refuseOperation(engine, token, code)

        fun deletedSets(engine: Engine): List<LegacyDeletedSet> = engine.read(scope) { reader ->
            reader.devices(journalPrefix).values.flatMap { journal -> journal["items"]?.obj().orEmpty().flatMap { (token, item) ->
                if (item["kind"] != Json.of("finished") || item["state"] == Json.of("discarded")) emptyList() else item["source"]?.get("deleted")?.arr().orEmpty()
                    .filter { it !in item["resolvedDeleted"]?.arr().orEmpty() }.map { id -> LegacyDeletedSet("$token:${id.str()}", item["targetSessionId"]?.str() ?: item.member("id").str(), id.str()) }
            } }
        }

        fun resolveDeletion(engine: Engine, token: String) { engine.commit(scope) { context ->
            val itemToken = token.substringBefore(':')
            val id = token.substringAfter(':')
            val saved = context.devices(journalPrefix).entries.firstOrNull { itemToken in it.value["items"]?.obj().orEmpty() }
                ?: return@commit null to Unit
            val items = saved.value["items"]?.obj().orEmpty().toMutableMap()
            val item = items.getValue(itemToken)
            items[itemToken] = item.changed("resolvedDeleted" to Json.Arr((item["resolvedDeleted"]?.arr().orEmpty() + Json.of(id)).distinct()))
            Gesture(emptyList(), local = listOf(DeviceWrite(saved.key, withItems(saved.value, items)))) to Unit
        } }

        private fun effectiveSource(item: Json): Json {
            val source = item.member("source")
            val target = item["targetSessionId"] ?: return source
            if (item["kind"] != Json.of("start")) return source
            val session = source["session"] ?: return source
            val entries = source["entries"]?.obj().orEmpty().mapValues { (_, entry) -> entry.changed("sessionId" to target) }
            return source.changed("session" to session.changed("id" to target), "entries" to Json.Obj(entries.toList()))
        }

        fun cached(engine: Engine, kind: String): List<Json> = engine.read(scope) { reader -> reader.devices(journalPrefix).values.flatMap { journal ->
            journal["items"]?.obj().orEmpty().values.filter { it["kind"] == Json.of(kind) && it["state"] != Json.of("discarded") && it["code"] != Json.of("source-kind") && it["cacheConsumed"] != Json.of(true) }.map { item -> effectiveSource(item) } } }

        fun sourceSessionId(engine: Engine, canonicalId: String): String? = engine.read(scope) { reader ->
            reader.devices(journalPrefix).values.flatMap { it["items"]?.obj().orEmpty().values }.firstOrNull { item ->
                item["kind"] == Json.of("start") && item["state"] != Json.of("discarded") && item["targetSessionId"] == Json.of(canonicalId)
            }?.get("source")?.get("session")?.get("id")?.str()
        }

        fun pendingFinished(engine: Engine): List<LocalLog.FinishedSession> = engine.read(scope) { reader ->
            reader.devices(journalPrefix).values.flatMap { it["items"]?.obj().orEmpty().values }.filter { item ->
                item["kind"] == Json.of("finished") && item["state"] == Json.of("pending") && item["code"] == Json.of("waiting-for-firstpull")
            }.map { decode(it.member("source"), LocalLog.FinishedSession.serializer()) }
        }

        fun reconcileConfirmed(engine: Engine) {
            val waiting = engine.read(scope) { reader ->
                if (!reader.firstPullComplete() || reader.checkpoint().cleanSeq == null) emptyList() else
                    reader.devices(journalPrefix).values.flatMap { it["items"]?.obj().orEmpty().values }.filter { item ->
                        item["kind"] == Json.of("finished") && item["state"] == Json.of("pending") && item["code"] == Json.of("waiting-for-firstpull")
                    }.map { it.member("id").str() }
            }
            waiting.forEach { retry(engine, it) }
            dismissResolvedNotices(engine)
        }

        private fun dismissResolvedNotices(engine: Engine) {
            val gestures = engine.read(scope) { reader -> reader.devices(journalPrefix).values.flatMap { it["items"]?.obj().orEmpty().values }
                .filter { it["kind"] == Json.of("finished") && it["state"] == Json.of("admitted") }.mapNotNull { it["resolvedGestureId"]?.str() }.toSet() }
            engine.notices("gym").notices.value.filter { !it.isDismissed && it.id in gestures.map { gesture -> "notice:$gesture/0" } }.forEach { engine.dismissNotice(it.id) }
        }

        fun retireCaches(engine: Engine) { engine.commit(scope) { context ->
            val writes = context.devices(journalPrefix).mapNotNull { (key, journal) ->
                val before = journal["items"]?.obj().orEmpty()
                val items = before.mapValues { (_, item) ->
                    if (item["kind"]?.str() in setOf("cache", "start", "cachePreferences", "cacheWeighin"))
                        item.changed("cacheConsumed" to Json.of(true)) else item
                }
                if (before == items) null else DeviceWrite(key, withItems(journal, items))
            }
            if (writes.isEmpty()) null to Unit else Gesture(emptyList(), local = writes) to Unit
        } }

        fun refusals(engine: Engine): List<LegacyMigrationRefusal> = engine.read(scope) { reader ->
            reader.devices(journalPrefix).values.flatMap { journal -> journal["items"]?.obj().orEmpty().values.filter { it["state"] == Json.of("refused") }.map { item ->
                val source = item.member("source")
                val row = try { decode(source, LocalLog.FinishedSession.serializer()) } catch (_: Exception) { null }
                val start = if (item["kind"] == Json.of("start")) try { decode(source.member("session"), Session.serializer()) } catch (_: Exception) { null } else null
                val startSets = if (start != null) source["entries"]?.obj().orEmpty().values.mapNotNull { entry ->
                    try { decode(entry, SetQueue.Entry.serializer()).set } catch (_: Exception) { null }
                } else null
                val operation = if (item["kind"] == Json.of("operation")) try { decode(source, SetQueue.Entry.serializer()) } catch (_: Exception) { null } else null
                val code = item["code"]?.str() ?: "source-unreadable"
                val savedSets = when (item["kind"]?.str()) {
                    "operation" -> listOf(source.member("set"))
                    "start" -> source["entries"]?.obj().orEmpty().values.map { it.member("set") }
                    else -> source["sets"]?.arr().orEmpty()
                }
                val unknownKinds = savedSets.filter(::unknownKind).map { it.member("id").str() }
                val description = if (item["kind"] == Json.of("cacheEdit")) {
                    val name = if (item["editKind"] == Json.of(Gym.Types.exercise)) "movement" else "routine"
                    "This saved $name change was refused ($code). Open the current $name and edit it again, then retry."
                } else if (item["kind"] == Json.of("finished") && code in setOf("record-dead", "unknown-record")) reason("routine-missing") else reason(code)
                LegacyMigrationRefusal(item.member("id").str(), row?.session ?: start,
                    row?.sets ?: startSets ?: listOfNotNull(operation?.set), row?.deleted.orEmpty(), code, description, unknownKinds)
            } }
        }

        fun retry(engine: Engine, id: String) = editAndRetry(engine, id, null)
        fun replaceAndRetry(engine: Engine, id: String, corrected: LocalLog.FinishedSession,
            markFinished: Boolean = false, correctedKinds: Set<String> = emptySet()) = editAndRetry(engine, id,
            Json.parse(diskJson.encodeToString(LocalLog.FinishedSession.serializer(), corrected)), markFinished = markFinished, correctedKinds = correctedKinds)
        fun replaceStartAndRetry(engine: Engine, id: String, corrected: Session,
            correctedKinds: Map<String, works.windmill.gym.domain.SetKind> = emptyMap()) {
            check(corrected.id == id && corrected.isOpen) { "An unfinished workout keeps its identity and remains unfinished." }
            editAndRetry(engine, id, null, Json.parse(diskJson.encodeToString(Session.serializer(), corrected)), startKinds = correctedKinds)
        }
        fun replaceOperationKindAndRetry(engine: Engine, id: String, kind: works.windmill.gym.domain.SetKind) =
            editAndRetry(engine, id, null, startKinds = mapOf(id to kind))
        private fun editAndRetry(engine: Engine, id: String, corrected: Json?, correctedStart: Json? = null,
            markFinished: Boolean = false, correctedKinds: Set<String> = emptySet(),
            startKinds: Map<String, works.windmill.gym.domain.SetKind> = emptyMap()) {
            engine.commitLegacy(scope) { context ->
            val all = context.devices(journalPrefix)
            val saved = all.entries.firstOrNull { entry -> entry.value["items"]?.obj().orEmpty().values.any { it["id"] == Json.of(id) && (it["state"] == Json.of("refused") || it["code"] == Json.of("waiting-for-firstpull")) } }
                ?: all.entries.firstOrNull { entry -> entry.value["items"]?.obj().orEmpty().values.any { it["id"] == Json.of(id) } }
                ?: throw IllegalStateException("This saved workout is unavailable.")
            val key = saved.key
            val journal = saved.value
            val items = journal["items"]?.obj().orEmpty().toMutableMap()
            val token = (items.entries.firstOrNull { it.value["id"] == Json.of(id) && (it.value["state"] == Json.of("refused") || it.value["code"] == Json.of("waiting-for-firstpull")) }
                ?: items.entries.firstOrNull { it.value["id"] == Json.of(id) })?.key
                ?: throw IllegalStateException("This saved workout is unavailable.")
            val item = items.getValue(token)
            if (item["state"] != Json.of("refused") && item["code"] != Json.of("waiting-for-firstpull")) return@commitLegacy null to Unit
            check(item["code"] != Json.of("identity-unresolved") || !context.isAnonymous) { reason("identity-unresolved") }
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
            val gesture = try { if (kind == "cacheEdit") Gesture(emptyList()) else gesture(Item(item.member("seat").str(), kind, id, source), context, engine) } catch (refusal: RefusedMigration) {
                val changed = item.changed("source" to source, "state" to Json.of(if (refusal.code == "waiting-for-firstpull") "pending" else "refused"), "code" to Json.of(refusal.code),
                    "original" to (item["original"] ?: item.member("source")))
                items[token] = changed
                return@commitLegacy Gesture(emptyList(), local = listOf(DeviceWrite(key, withItems(journal, items)))) to Unit
            }
            val gestureId = context.opaqueID()
            gesture.gestureId = gestureId
            items[token] = item.changed("source" to source, "state" to Json.of(if (gesture.command != null) "queued" else if (kind in setOf("operation", "cacheEdit")) "pending" else if (kind == "finished") "admitted" else "migrated"), "gestureId" to Json.of(gestureId),
                "original" to (item["original"] ?: item.member("source")), "code" to null)
            if (kind == "finished" && gesture.command == null && item["gestureId"] != null)
                items[token] = items.getValue(token).changed("resolvedGestureId" to item.member("gestureId"))
            if (kind == "start" && startKinds.isNotEmpty()) items.replaceAll { _, child ->
                val chosen = child["id"]?.str()?.let(startKinds::get)
                if (child["kind"] == Json.of("operation") && child["source"]?.get("sessionId") == Json.of(id) && chosen != null)
                    child.changed("source" to child.member("source").changed("set" to child.member("source").member("set").changed("kind" to Json.of(chosen.wire))),
                        "state" to Json.of("pending"), "original" to (child["original"] ?: child.member("source"))) else child
            }
            if (kind == "start" && item["code"] == Json.of("identity-unresolved")) items.replaceAll { _, child ->
                if (child["kind"] == Json.of("operation") && child["source"]?.get("sessionId") == Json.of(id) && child["code"] == Json.of("identity-unresolved"))
                    child.changed("state" to Json.of("pending")) else child
            }
            gesture.local += DeviceWrite(key, withItems(journal, items))
            gesture to Unit
            }
            dismissResolvedNotices(engine)
        }

        fun discardRefusal(engine: Engine, id: String) { engine.commit(scope) { context ->
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

        val commandResultWrites: CommandResultDeviceWrites = { command, result, _, values ->
            if (command.name !in setOf(Gym.Commands.importSession, Gym.Commands.start)) emptyList() else values.filterKeys { it.startsWith(journalPrefix) }.map { (key, journal) ->
                val items = journal["items"]?.obj().orEmpty().mapValues { (_, item) ->
                    val kind = if (command.name == Gym.Commands.importSession) "finished" else "start"
                    if (item["kind"] != Json.of(kind) || item["id"] != command.args["id"] || item["state"] != Json.of("queued")) item
                    else when (val verdict = result.verdict) {
                        is PushResult.Verdict.Ok -> item.changed("state" to Json.of("admitted"))
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
                    if ((item["targetSessionId"] ?: original) == from.json) item.changed("targetSessionId" to to.json) else item
                }
                withItems(value, items)
            }
        }
        fun reason(code: String): String = when (code) {
            "session-overlap" -> "This workout overlaps another workout. Correct its dates or times, then retry."
            "session-id-taken" -> "A workout with this identity is already on the log. Review that workout before retrying; this original stays on this phone."
            "bad-instant", "clock-skew" -> "The workout has a future or invalid time. Correct its dates or times, then retry."
            "too-many-sets", "too-large" -> "This workout exceeds the import limit. Edit the workout explicitly, then retry."
            "frozen-plan-changed", "routine-missing", "stale" -> "The linked routine differs from this workout’s saved plan. Restore that routine or explicitly remove the link, then retry."
            "identity-unresolved" -> "This saved training has no verified owner. Choose an account before retrying."
            "source-numbering" -> "This workout’s saved set numbers cannot be imported unchanged. Explicitly re-number its sets, then retry."
            "source-auto-closed" -> "This workout closed automatically. Explicitly mark it finished before retrying."
            "source-kind" -> "A saved set kind is not recognized. Explicitly choose its kind, then retry."
            "source-needs-update" -> "This saved workout includes fields this build cannot preserve. Keep it on this phone and update the app."
            "weighin-source-correction" -> "This saved weigh-in needs correction. Edit this date’s weight, then retry."
            "source-unreadable" -> "This saved training cannot be read by this build. Keep it on this phone and update the app."
            "unknown-exercise" -> "A movement is missing. Restore the movement, then retry."
            "parent-dead" -> "A linked movement or routine was refused. Restore it, then retry this workout."
            else -> "This workout was refused ($code). Correct the saved workout, then retry."
        }
    }
}
