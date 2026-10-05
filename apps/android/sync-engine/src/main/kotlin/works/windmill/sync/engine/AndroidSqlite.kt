package works.windmill.sync.engine

import android.content.ContentValues
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import android.os.Build
import java.io.File
import works.windmill.sync.core.*

internal class AndroidSqliteStore(private val db: SQLiteDatabase, private val registry: Registry) : EngineStore {
    init {
        db.setForeignKeyConstraintsEnabled(true)
        if (Build.VERSION.SDK_INT >= 30) db.execPerConnectionSQL("PRAGMA synchronous=FULL", null)
        else {
            if (Build.VERSION.SDK_INT < 28) {
                db.disableWriteAheadLogging()
                db.rawQuery("PRAGMA journal_mode=DELETE", null).use { if (!it.moveToFirst() || it.getString(0) != "delete") throw StoreFailure() }
            }
            db.execSQL("PRAGMA synchronous=FULL")
        }
        db.rawQuery("PRAGMA busy_timeout=5000", null).use { it.moveToFirst() }
        if (db.version !in 0..1) throw StoreFailure()
        if (db.version == 0) transaction {
            if (scalar("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'android_metadata' LIMIT 1") != null) throw StoreFailure()
            for (sql in schema) db.execSQL(sql)
            db.version = 1
        }
        val version = scalar("SELECT ref_index_version FROM device WHERE id=1")?.toLong()
        if (version != null && version != registry.version) transaction {
            db.execSQL("DELETE FROM set_ref")
            db.rawQuery("SELECT row_set,payload FROM set_row", null).use { rows ->
                while (rows.moveToNext()) {
                    val row = Row(Json.parse(rows.getString(1)))
                    index(rows.getLong(0), row)
                    db.update("set_row", values("visible" to isVisible(registry.type(row.key.type), row.lattice,
                        row.texts.mapValues { TextValueState(it.value.text, it.value.merged, false) })), "row_set=? AND type=? AND id=?",
                        arrayOf(rows.getLong(0).toString(), row.key.type, row.key.id.text))
                }
            }
            db.execSQL("UPDATE device SET ref_index_version=? WHERE id=1", arrayOf(registry.version))
        }
    }
    private fun scalar(sql: String, args: Array<String> = emptyArray()): String? = db.rawQuery(sql, args).use { cursor ->
        if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
    }
    private fun decode(sql: String, args: Array<String> = emptyArray()): List<Json> = guarded {
        db.rawQuery(sql, args).use { cursor -> buildList { while (cursor.moveToNext()) add(Json.parse(cursor.getString(0))) } }
    }
    private inline fun <T> guarded(body: () -> T): T = try { body() }
        catch (failure: SQLiteException) { throw StoreFailure(failure) }
        catch (failure: IllegalArgumentException) { throw StoreFailure(failure) }
    private fun handle(replica: String): Long = scalar("SELECT handle FROM replica WHERE id=?", arrayOf(replica))?.toLong() ?: throw StoreFailure()
    private fun values(vararg fields: Pair<String, Any?>): ContentValues = ContentValues().apply {
        for ((key, value) in fields) when (value) {
            null -> putNull(key)
            is String -> put(key, value)
            is Long -> put(key, value)
            is Int -> put(key, value)
            is Boolean -> put(key, if (value) 1 else 0)
            is ByteArray -> put(key, value)
            else -> error("sqlite-value")
        }
    }
    private fun insert(table: String, value: ContentValues) { if (db.insertOrThrow(table, null, value) == -1L) throw StoreFailure() }
    override fun metadata(): Json = guarded {
        val device = decode("SELECT payload FROM device WHERE id=1").singleOrNull() ?: throw StoreFailure()
        val active = scalar("SELECT r.id FROM device d JOIN replica r ON d.active_replica=r.handle WHERE d.id=1")
        val replicas = buildList {
            db.rawQuery("SELECT handle,payload FROM replica ORDER BY id", null).use { cursor ->
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(0).toString()
                    val meta = Json.parse(cursor.getString(1))
                    val parts = mutableListOf("meta" to meta)
                    val outbox = decode("SELECT payload FROM outbox WHERE replica=? ORDER BY commit_order", arrayOf(id))
                    val notices = decode("SELECT payload FROM notice WHERE replica=? ORDER BY rowid", arrayOf(id))
                    if (outbox.isNotEmpty()) parts.add("outbox" to Json.Arr(outbox))
                    if (notices.isNotEmpty()) parts.add("notices" to Json.Arr(notices))
                    for ((name, table) in listOf("cursors" to "cursor", "known" to "known_scope")) {
                        val entries = buildList {
                            db.rawQuery("SELECT scope,payload FROM $table WHERE replica=? ORDER BY scope", arrayOf(id)).use { rows ->
                                while (rows.moveToNext()) add(rows.getString(0) to Json.parse(rows.getString(1)))
                            }
                        }
                        if (entries.isNotEmpty()) parts.add(name to Json.Obj(entries))
                    }
                    val spent = buildMap<String, MutableList<Json>> {
                        db.rawQuery("SELECT scope,payload FROM spent WHERE replica=? ORDER BY scope,type,id", arrayOf(id)).use { rows ->
                            while (rows.moveToNext()) getOrPut(rows.getString(0)) { mutableListOf() }.add(Json.parse(rows.getString(1)))
                        }
                    }
                    if (spent.isNotEmpty()) parts.add("spentIds" to Json.Obj(spent.map { it.key to Json.Arr(it.value) }))
                    val local = buildMap<String, MutableList<Pair<String, Json>>> {
                        db.rawQuery("SELECT product,key,value FROM device_row WHERE replica=? ORDER BY product,key", arrayOf(id)).use { rows ->
                            while (rows.moveToNext()) getOrPut(rows.getString(0)) { mutableListOf() }.add(rows.getString(1) to Json.parse(rows.getString(2)))
                        }
                    }
                    if (local.isNotEmpty()) parts.add("device" to Json.Obj(local.map { it.key to Json.Obj(it.value) }))
                    val staging = buildList {
                        db.rawQuery("SELECT scope,payload FROM row_set WHERE replica=? AND role='staging' ORDER BY scope", arrayOf(id)).use { sets ->
                            while (sets.moveToNext()) {
                                val payload = if (sets.isNull(1)) Json.objectOf() else Json.parse(sets.getString(1))
                                add(sets.getString(0) to payload)
                            }
                        }
                    }
                    if (staging.isNotEmpty()) parts.add("staging" to Json.Obj(staging))
                    add(Json.Obj(parts))
                }
            }
        }
        Json.Obj(buildList {
            if (device.obj().isNotEmpty()) add("meta" to device)
            add("active" to (active?.let(Json::of) ?: Json.Null)); add("replicas" to Json.Arr(replicas))
        })
    }
    private fun sync(table: String, replica: Long, wanted: Map<String, Json>, key: String, put: (String, Json) -> ContentValues): Set<String> {
        val stored = buildMap {
            db.rawQuery("SELECT $key,payload FROM $table WHERE replica=?", arrayOf(replica.toString())).use { rows ->
                while (rows.moveToNext()) put(rows.getString(0), rows.getString(1))
            }
        }
        for ((id, _) in stored) if (id !in wanted) db.delete(table, "replica=? AND $key=?", arrayOf(replica.toString(), id))
        val changed = wanted.keys.filter { stored[it] != wanted[it]!!.jcs }.toSet()
        for ((id, payload) in wanted) if (id in changed) {
            val columns = put(id, payload)
            if (stored[id] == null) insert(table, columns) else db.update(table, columns, "replica=? AND $key=?", arrayOf(replica.toString(), id))
        }
        return changed
    }
    override fun metadata(value: Json) = guarded {
        val replicas = value.items("replicas")
        val ids = replicas.map { it.member("meta").member("replica").str() }.toSet()
        val old = buildMap {
            db.rawQuery("SELECT id,handle FROM replica", null).use { rows -> while (rows.moveToNext()) put(rows.getString(0), rows.getLong(1)) }
        }
        for ((id, number) in old) if (id !in ids) {
            purgeReplica(id)
            db.delete("replica", "handle=?", arrayOf(number.toString()))
        }
        for (replica in replicas) {
            val meta = replica.member("meta")
            val id = meta.member("replica").str()
            val columns = values("id" to id, "state" to meta.member("state").str(), "account" to meta["account"]?.str(), "payload" to meta.jcs)
            val number = old[id] ?: scalar("SELECT handle FROM replica WHERE id=?", arrayOf(id))?.toLong()
            if (number == null) insert("replica", columns) else db.update("replica", columns, "handle=?", arrayOf(number.toString()))
            val selected = handle(id)
            val changedEntries = sync("outbox", selected, replica.items("outbox").associateBy { it.member("localId").str() }, "local_id") { localId, entry ->
                db.delete("outbox_touch", "local_id=?", arrayOf(localId))
                values("local_id" to localId, "replica" to selected, "gesture_id" to entry.member("gestureId").str(), "lineage" to entry.member("lineage").str(),
                    "scope" to entry.member("scope").str(), "state" to entry.member("state").str(), "commit_order" to entry.member("commitOrder").long(),
                    "release_at" to entry.member("releaseAt").long(), "n" to entry["n"]?.long(), "result_seq" to entry["resultSeq"]?.long(), "payload" to entry.jcs)
            }
            for (entry in replica.items("outbox")) {
                val localId = entry.member("localId").str()
                if (localId !in changedEntries) continue
                val keys = Entry(entry).deltas.map { it.key }.distinct()
                for (key in keys) db.insertWithOnConflict("outbox_touch", null, values("local_id" to localId, "scope" to entry.member("scope").str(), "type" to key.type, "id" to key.id.text), SQLiteDatabase.CONFLICT_IGNORE)
            }
            sync("notice", selected, replica.items("notices").associateBy { it.member("id").str() }, "id") { noticeId, notice ->
                values("id" to noticeId, "replica" to selected, "scope" to notice.member("scope").str(), "code" to notice.member("code").str(),
                    "at" to notice.member("at").long(), "dismissed" to notice.flag("dismissed"), "payload" to notice.jcs)
            }
            sync("cursor", selected, replica.fields("cursors"), "scope") { scope, payload -> values("replica" to selected, "scope" to scope, "payload" to payload.jcs) }
            sync("known_scope", selected, replica.fields("known"), "scope") { scope, payload -> values("replica" to selected, "scope" to scope, "kind" to payload.str(), "payload" to payload.jcs) }
            val spent = replica.fields("spentIds").flatMap { (scope, rows) -> rows.arr().map { row ->
                Json.array(Json.of(scope), row.recordKey.json).jcs to row
            } }.toMap()
            sync("spent", selected, spent, "key") { key, row ->
                values("replica" to selected, "key" to key, "scope" to Json.parse(key).arr().first().str(), "type" to row.recordKey.type,
                    "id" to row.recordKey.id.text, "payload" to row.jcs)
            }
            // Device rows have arbitrary JSON values, not an entry envelope.
            val desired = replica.fields("device").flatMap { (product, rows) -> rows.obj().map { (key, payload) -> Triple(product, key, payload) } }
            val oldLocal = buildMap<Pair<String, String>, String> {
                db.rawQuery("SELECT product,key,value FROM device_row WHERE replica=?", arrayOf(selected.toString())).use { rows ->
                    while (rows.moveToNext()) put(rows.getString(0) to rows.getString(1), rows.getString(2))
                }
            }
            val desiredKeys = desired.map { it.first to it.second }.toSet()
            for ((key, _) in oldLocal) if (key !in desiredKeys) db.delete("device_row", "replica=? AND product=? AND key=?", arrayOf(selected.toString(), key.first, key.second))
            for ((product, key, payload) in desired) if (oldLocal[product to key] != payload.jcs) {
                val columnsLocal = values("replica" to selected, "product" to product, "key" to key, "value" to payload.jcs)
                if ((product to key) !in oldLocal) insert("device_row", columnsLocal)
                else db.update("device_row", columnsLocal, "replica=? AND product=? AND key=?", arrayOf(selected.toString(), product, key))
            }
            val staged = replica.fields("staging")
            val oldStaged = buildSet {
                db.rawQuery("SELECT scope FROM row_set WHERE replica=? AND role='staging'", arrayOf(selected.toString())).use { rows -> while (rows.moveToNext()) add(rows.getString(0)) }
            }
            for (scope in oldStaged) if (scope !in staged) dropStaging(id, ScopeRef(scope))
            for ((scopeText, stage) in staged) {
                val scope = ScopeRef(scopeText)
                val set = rowSet(id, scope, true, true)!!
                db.update("row_set", values("payload" to stage.with("rows" to null).jcs), "id=?", arrayOf(set.toString()))
                if (stage["rows"] == null) continue
                val current = setRows(set).associateBy { it.key }
                val wanted = stage.items("rows").map(::Row).associateBy { it.key }
                for (key in current.keys) if (key !in wanted) removeIn(set, key)
                for ((key, row) in wanted) if (current[key] != row) putIn(set, row)
            }
        }
        val active = value.member("active").orNull()?.str()?.let(::handle) ?: throw StoreFailure()
        val columns = values("id" to 1, "active_replica" to active, "payload" to (value["meta"] ?: Json.objectOf()).jcs, "ref_index_version" to registry.version)
        // The replace is a single statement, so aborts cannot publish a partially changed active replica.
        if (db.insertWithOnConflict("device", null, columns, SQLiteDatabase.CONFLICT_REPLACE) == -1L) throw StoreFailure()
    }
    private fun rowSet(replica: String, scope: ScopeRef, staging: Boolean = false, create: Boolean = false): Long? {
        val selected = handle(replica)
        val role = if (staging) "staging" else "confirmed"
        val found = scalar("SELECT id FROM row_set WHERE replica=? AND scope=? AND role=?", arrayOf(selected.toString(), scope.text, role))?.toLong()
        if (found != null || !create) return found
        return db.insertOrThrow("row_set", null, values("replica" to selected, "scope" to scope.text, "role" to role))
    }
    private fun setRows(set: Long, type: String? = null): List<Row> = if (type == null)
        decode("SELECT payload FROM set_row WHERE row_set=?", arrayOf(set.toString())).map(::Row).sortedBy { it.key }
        else decode("SELECT payload FROM set_row WHERE row_set=? AND type=?", arrayOf(set.toString(), type)).map(::Row).sortedBy { it.key }
    override fun row(replica: String, scope: ScopeRef, key: RecordKey): Row? = guarded {
        rowSet(replica, scope)?.let { set -> decode("SELECT payload FROM set_row WHERE row_set=? AND type=? AND id=?", arrayOf(set.toString(), key.type, key.id.text)).firstOrNull()?.let(::Row) }
    }
    override fun rows(replica: String, scope: ScopeRef, type: String?) = guarded { rowSet(replica, scope)?.let { setRows(it, type) } ?: emptyList() }
    override fun matching(replica: String, scope: ScopeRef, type: String, field: String, value: RecordID): List<Row> = guarded {
        rowSet(replica, scope)?.let { set -> decode(
            "SELECT r.payload FROM set_ref i JOIN set_row r ON r.row_set=i.row_set AND r.type=i.type AND r.id=i.id WHERE i.row_set=? AND i.type=? AND i.field=? AND i.target=?",
            arrayOf(set.toString(), type, field, value.text)).map(::Row).sortedBy { it.key } } ?: emptyList()
    }
    override fun scopes(replica: String): Set<ScopeRef> = guarded {
        db.rawQuery("SELECT DISTINCT s.scope FROM row_set s JOIN set_row r ON r.row_set=s.id WHERE s.replica=? AND s.role='confirmed'", arrayOf(handle(replica).toString())).use { cursor ->
            buildSet { while (cursor.moveToNext()) add(ScopeRef(cursor.getString(0))) }
        }
    }
    override fun hasRows(replica: String, scope: ScopeRef): Boolean = guarded {
        rowSet(replica, scope)?.let { scalar("SELECT 1 FROM set_row WHERE row_set=? LIMIT 1", arrayOf(it.toString())) != null } ?: false
    }
    private fun index(set: Long, row: Row) {
        for ((name, field) in registry.type(row.key.type)?.fields.orEmpty()) {
            if (field.ref == null) continue
            val value = row.lattice.fields[name]?.value as? Json.Str ?: continue
            insert("set_ref", values("row_set" to set, "type" to row.key.type, "field" to name, "target" to value.jcs, "id" to row.key.id.text))
        }
    }
    private fun putIn(set: Long, row: Row) {
        removeIn(set, row.key)
        val visible = isVisible(registry.type(row.key.type), row.lattice, row.texts.mapValues { TextValueState(it.value.text, it.value.merged, false) })
        insert("set_row", values("row_set" to set, "type" to row.key.type, "id" to row.key.id.text, "seq" to row.seq, "visible" to visible,
            "payload" to row.json.jcs, "hash" to ScopeDigest.row(row.json).bytes))
        index(set, row)
    }
    private fun removeIn(set: Long, key: RecordKey) {
        val args = arrayOf(set.toString(), key.type, key.id.text)
        db.delete("set_ref", "row_set=? AND type=? AND id=?", args)
        db.delete("set_row", "row_set=? AND type=? AND id=?", args)
    }
    override fun put(replica: String, scope: ScopeRef, row: Row) = guarded { putIn(rowSet(replica, scope, create = true)!!, row) }
    override fun remove(replica: String, scope: ScopeRef, key: RecordKey) = guarded { rowSet(replica, scope)?.let { removeIn(it, key) }; Unit }
    override fun reidentify(oldId: String, newId: String) = guarded {
        val number = handle(oldId)
        val meta = decode("SELECT payload FROM replica WHERE handle=?", arrayOf(number.toString())).single().with("replica" to Json.of(newId))
        if (db.update("replica", values("id" to newId, "payload" to meta.jcs), "handle=?", arrayOf(number.toString())) != 1) throw StoreFailure()
    }
    override fun forgetScope(replica: String, scope: ScopeRef) = guarded {
        db.execSQL("UPDATE row_set SET role=NULL WHERE replica=? AND scope=? AND role IS NOT NULL", arrayOf<Any>(handle(replica), scope.text))
    }
    override fun purgeReplica(replica: String) = guarded {
        db.execSQL("UPDATE row_set SET role=NULL WHERE replica=? AND role IS NOT NULL", arrayOf(handle(replica)))
    }
    override fun beginStaging(replica: String, scope: ScopeRef) = guarded { dropStaging(replica, scope); rowSet(replica, scope, true, true); Unit }
    override fun putStaging(replica: String, scope: ScopeRef, row: Row) = guarded { putIn(rowSet(replica, scope, true) ?: throw StoreFailure(), row) }
    override fun removeStaging(replica: String, scope: ScopeRef, key: RecordKey) = guarded { removeIn(rowSet(replica, scope, true) ?: throw StoreFailure(), key) }
    override fun stagingRows(replica: String, scope: ScopeRef): List<Row> = guarded { rowSet(replica, scope, true)?.let(::setRows) ?: emptyList() }
    override fun stagingRow(replica: String, scope: ScopeRef, key: RecordKey): Row? = guarded {
        rowSet(replica, scope, true)?.let { decode("SELECT payload FROM set_row WHERE row_set=? AND type=? AND id=?", arrayOf(it.toString(), key.type, key.id.text)).firstOrNull()?.let(::Row) }
    }
    override fun swapStaging(replica: String, scope: ScopeRef) = guarded {
        val selected = handle(replica)
        val next = rowSet(replica, scope, true) ?: throw StoreFailure()
        db.execSQL("UPDATE row_set SET role=NULL WHERE replica=? AND scope=? AND role='confirmed'", arrayOf<Any>(selected, scope.text))
        db.execSQL("UPDATE row_set SET role='confirmed',payload=NULL WHERE id=?", arrayOf(next))
    }
    override fun dropStaging(replica: String, scope: ScopeRef) = guarded {
        db.execSQL("UPDATE row_set SET role=NULL WHERE replica=? AND scope=? AND role='staging'", arrayOf<Any>(handle(replica), scope.text))
    }
    override fun releasedRows(): Int = guarded { scalar("SELECT COUNT(*) FROM set_row r JOIN row_set s ON s.id=r.row_set WHERE s.role IS NULL")!!.toInt() }
    override fun sweepReleased(limit: Int): Boolean = guarded {
        require(limit > 0)
        var left = limit
        var setsLeft = limit
        while (left > 0 && setsLeft-- > 0) {
            val set = scalar("SELECT id FROM row_set WHERE role IS NULL ORDER BY id LIMIT 1")?.toLong() ?: return@guarded false
            val keys = buildList {
                db.rawQuery("SELECT type,id FROM set_row WHERE row_set=? ORDER BY type,id LIMIT ?", arrayOf(set.toString(), left.toString())).use { rows ->
                    while (rows.moveToNext()) add(RecordKey(rows.getString(0), RecordID.fromText(rows.getString(1))))
                }
            }
            for (key in keys) removeIn(set, key)
            left -= keys.size
            if (scalar("SELECT 1 FROM set_row WHERE row_set=? LIMIT 1", arrayOf(set.toString())) == null) db.delete("row_set", "id=?", arrayOf(set.toString()))
        }
        scalar("SELECT 1 FROM row_set WHERE role IS NULL LIMIT 1") != null
    }
    override fun <T> transaction(body: () -> T): T = guarded {
        if (db.inTransaction()) throw StoreFailure()
        db.beginTransaction()
        try { body().also { db.setTransactionSuccessful() } } finally { db.endTransaction() }
    }
    override fun <T> read(body: () -> T): T = if (db.inTransaction()) guarded(body) else transaction(body)
    override fun close() = db.close()
    companion object {
        private val schema = listOf(
            "CREATE TABLE replica(handle INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('anon','bound','dormant')),account TEXT,payload TEXT NOT NULL,CHECK((state='anon')=(account IS NULL)))",
            "CREATE UNIQUE INDEX replica_one_anon ON replica(state) WHERE state='anon'",
            "CREATE UNIQUE INDEX replica_one_bound ON replica(state) WHERE state='bound'",
            "CREATE UNIQUE INDEX replica_per_account ON replica(account) WHERE account IS NOT NULL",
            "CREATE TABLE device(id INTEGER PRIMARY KEY CHECK(id=1),active_replica INTEGER NOT NULL REFERENCES replica DEFERRABLE INITIALLY DEFERRED,payload TEXT NOT NULL,ref_index_version INTEGER NOT NULL)",
            "CREATE TABLE row_set(id INTEGER PRIMARY KEY AUTOINCREMENT,replica INTEGER REFERENCES replica ON DELETE SET NULL,scope TEXT NOT NULL,role TEXT CHECK(role IN ('confirmed','staging')),payload TEXT)",
            "CREATE UNIQUE INDEX row_set_role ON row_set(replica,scope,role) WHERE role IS NOT NULL",
            "CREATE INDEX row_set_released ON row_set(id) WHERE role IS NULL",
            "CREATE TABLE set_row(row_set INTEGER NOT NULL REFERENCES row_set,type TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,visible INTEGER NOT NULL,payload TEXT NOT NULL,hash BLOB NOT NULL,PRIMARY KEY(row_set,type,id)) WITHOUT ROWID",
            "CREATE TABLE set_ref(row_set INTEGER NOT NULL REFERENCES row_set,type TEXT NOT NULL,field TEXT NOT NULL,target TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(row_set,type,field,target,id)) WITHOUT ROWID",
            "CREATE INDEX set_ref_record ON set_ref(row_set,type,id)",
            "CREATE TABLE spent(replica INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,key TEXT NOT NULL,scope TEXT NOT NULL,type TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(replica,key)) WITHOUT ROWID",
            "CREATE TABLE cursor(replica INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,scope TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(replica,scope)) WITHOUT ROWID",
            "CREATE TABLE known_scope(replica INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,scope TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('gone','not-found')),payload TEXT NOT NULL,PRIMARY KEY(replica,scope)) WITHOUT ROWID",
            "CREATE TABLE outbox(local_id TEXT PRIMARY KEY,replica INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,gesture_id TEXT NOT NULL,lineage TEXT NOT NULL,scope TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('held','ready','sent','acked')),commit_order INTEGER NOT NULL,release_at INTEGER NOT NULL,n INTEGER,result_seq INTEGER,payload TEXT NOT NULL,UNIQUE(replica,commit_order),CHECK((n IS NULL)=(state IN ('held','ready'))),CHECK((state='acked')=(result_seq IS NOT NULL)))",
            "CREATE UNIQUE INDEX outbox_n ON outbox(replica,n) WHERE state='sent'",
            "CREATE INDEX outbox_scope ON outbox(replica,scope,commit_order)",
            "CREATE INDEX outbox_state ON outbox(replica,state,commit_order)",
            "CREATE INDEX outbox_gesture ON outbox(gesture_id)",
            "CREATE TABLE outbox_touch(local_id TEXT NOT NULL REFERENCES outbox ON DELETE CASCADE,scope TEXT NOT NULL,type TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(scope,type,id,local_id)) WITHOUT ROWID",
            "CREATE INDEX outbox_touch_entry ON outbox_touch(local_id)",
            "CREATE TABLE notice(id TEXT PRIMARY KEY,replica INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,scope TEXT NOT NULL,code TEXT NOT NULL,at INTEGER NOT NULL,dismissed INTEGER NOT NULL CHECK(dismissed IN (0,1)),payload TEXT NOT NULL)",
            "CREATE TABLE device_row(replica INTEGER NOT NULL REFERENCES replica ON DELETE CASCADE,product TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(replica,product,key)) WITHOUT ROWID"
        )
    }
}

object AndroidSqlite {
    fun open(file: File, registry: Registry, initial: Json, clock: EngineClock, identities: IdentitySource, actor: String,
        telemetry: EngineTelemetry = NoEngineTelemetry,
        rewriteDeviceValue: DeviceValueRewrite = { _, _, value, _, _, _ -> value },
        commandResultWrites: works.windmill.sync.api.CommandResultDeviceWrites = { _, _, _, _ -> emptyList() },
        pendingDeviceWork: works.windmill.sync.api.PendingDeviceWork = { _, _ -> emptyList() }): Engine {
        val db = try {
            val handler = DatabaseErrorHandler { }
            if (Build.VERSION.SDK_INT >= 28) SQLiteDatabase.openDatabase(file, SQLiteDatabase.OpenParams.Builder()
                .addOpenFlags(SQLiteDatabase.CREATE_IF_NECESSARY).setErrorHandler(handler).setJournalMode("WAL").setSynchronousMode("FULL").build())
            else if (Build.VERSION.SDK_INT == 27) SQLiteDatabase.openDatabase(file, SQLiteDatabase.OpenParams.Builder()
                .addOpenFlags(SQLiteDatabase.CREATE_IF_NECESSARY).setErrorHandler(handler).setIdleConnectionTimeout(Long.MAX_VALUE).build())
            else SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.CREATE_IF_NECESSARY, handler)
        } catch (_: Exception) {
            BoundaryTelemetry.offer(telemetry, EngineOperation.storage, "store-failure")
            throw works.windmill.sync.api.CommitFailure(works.windmill.sync.api.CommitFailure.Kind.storeFailure, "open")
        }
        try {
            if (Build.VERSION.SDK_INT >= 28) db.enableWriteAheadLogging()
            val store = AndroidSqliteStore(db, registry)
            db.rawQuery("SELECT 1 FROM device WHERE id=1", null).use { cursor ->
                if (!cursor.moveToFirst()) store.transaction {
                    store.metadata(initial.with("replicas" to Json.Arr(initial.items("replicas").map { it.with("confirmed" to null) })))
                    for (replica in initial.items("replicas")) for ((scope, rows) in replica.fields("confirmed")) {
                        for (row in rows.arr()) store.put(replica.member("meta").member("replica").str(), ScopeRef(scope), Row(row))
                    }
                }
            }
            return Engine(registry, store, clock, identities, actor, telemetry = telemetry, rewriteDeviceValue = rewriteDeviceValue, commandResultWrites = commandResultWrites, pendingDeviceWork = pendingDeviceWork)
        } catch (failure: Throwable) {
            db.close()
            if (failure is StoreFailure || failure is SQLiteException || failure is IllegalArgumentException) {
                BoundaryTelemetry.offer(telemetry, EngineOperation.storage, "store-failure")
                throw works.windmill.sync.api.CommitFailure(works.windmill.sync.api.CommitFailure.Kind.storeFailure, "open")
            }
            throw failure
        }
    }
}
