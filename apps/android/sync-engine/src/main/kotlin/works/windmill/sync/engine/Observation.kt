package works.windmill.sync.engine

import java.lang.ref.WeakReference
import kotlin.concurrent.withLock
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.FlowCollector
import works.windmill.sync.api.Notice
import works.windmill.sync.api.NoticeContent
import works.windmill.sync.api.UndoOffer
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.api.Record
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RecordKey
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.lives
import works.windmill.sync.core.product
import works.windmill.sync.core.Command
import works.windmill.sync.core.Delta
import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode

@OptIn(ExperimentalForInheritanceCoroutinesApi::class)
private class ViewState<T>(val owner: Any, private val state: StateFlow<T>) : StateFlow<T> by state {
    override suspend fun collect(collector: FlowCollector<T>): Nothing = state.collect(object : FlowCollector<T> {
        // The delegate retains this collector while suspended. Keep its weak-cached native view
        // here too; delegating collect directly retains only the MutableStateFlow.
        @Suppress("unused") private val retainedOwner = owner
        override suspend fun emit(value: T) = collector.emit(value)
    })
}

class RecordsView internal constructor(internal val key: Key) {
    internal data class Key(val scope: ScopeRef, val type: String, val field: String?, val id: RecordID?, val mode: ViewMode)
    sealed interface State {
        data object Loading : State
        data class Loaded(val snapshot: Snapshot) : State
    }
    data class Snapshot(val records: List<Record>, val firstPullComplete: Boolean) {
        fun record(id: RecordID): Record? {
            var low = 0; var high = records.size
            while (low < high) {
                val middle = (low + high) / 2
                if (records[middle].id < id) low = middle + 1 else high = middle
            }
            return records.getOrNull(low)?.takeIf { it.id == id }
        }
    }
    private val mutableState = MutableStateFlow<State>(State.Loading)
    val state: StateFlow<State> = ViewState(this, mutableState)
    val scope get() = key.scope
    val type get() = key.type
    val mode get() = key.mode
    internal var version = -1L
    internal var invalidatedVersion = -1L
    internal var replica: String? = null
    internal var account: String? = null
    internal var whole = true
    internal var touched = mutableSetOf<RecordKey>()
    internal var firstPull = true
    internal var failures = 0
    internal var waitsForRetry = false
    internal fun seat(nextReplica: String, nextAccount: String?) {
        if (replica == nextReplica && account == nextAccount) return
        mutableState.value = State.Loading
        replica = nextReplica; account = nextAccount
        whole = true; touched.clear(); firstPull = true; failures = 0
    }
    internal fun land(snapshot: Snapshot, readVersion: Long) {
        mutableState.value = State.Loaded(snapshot)
        version = readVersion; failures = 0
        whole = false; touched.clear(); firstPull = false
    }
}

class NoticesView internal constructor(val product: String, initial: List<Notice>) {
    private val mutableNotices = MutableStateFlow(initial)
    val notices: StateFlow<List<Notice>> = ViewState(this, mutableNotices)
    internal fun land(next: List<Notice>) { mutableNotices.value = next }
}

class UndoOffers internal constructor(initial: List<UndoOffer>) {
    private val mutableOffers = MutableStateFlow(initial)
    val offers: StateFlow<List<UndoOffer>> = ViewState(this, mutableOffers)
    internal fun land(next: List<UndoOffer>) { mutableOffers.value = next }
}

class SyncStatus internal constructor(initial: Snapshot = Snapshot()) {
    data class Snapshot(val account: String? = null, val authPaused: Boolean = false, val upgradeRequired: Boolean = false,
        val online: Boolean = true, val pendingSignIn: String? = null, val ready: Int = 0, val sent: Int = 0)
    private val mutableState = MutableStateFlow(initial)
    val state: StateFlow<Snapshot> = ViewState(this, mutableState)
    internal fun land(next: Snapshot) { mutableState.value = next }
}

internal class ObservationHub(private val engine: Engine) : AutoCloseable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Any()
    private val records = mutableMapOf<RecordsView.Key, WeakReference<RecordsView>>()
    private val recent = mutableListOf<RecordsView>()
    private val nudges = Channel<Unit>(Channel.CONFLATED)
    private val retries = mutableMapOf<RecordsView.Key, Job>()
    private val notices = mutableMapOf<String, WeakReference<NoticesView>>()
    private var offersView: UndoOffers? = null
    private var statusView: SyncStatus? = null
    private var smallRetry: Job? = null
    private var smallFailures = 0
    private var lastSeen = -1L
    private var closed = false
    init {
        scope.launch {
            engine.changes.collect { change ->
                if (change.version == Long.MIN_VALUE) { close(); return@collect }
                synchronized(mutex) {
                    val gap = lastSeen >= 0 && change.version > lastSeen + 1
                    lastSeen = change.version
                    for (view in live()) {
                        if (change.version <= view.version || change.version < view.invalidatedVersion) continue
                        view.invalidatedVersion = change.version
                        change.replica?.let { replica ->
                            if (view.replica != replica || view.account != change.account) {
                                view.seat(replica, change.account)
                                retries.remove(view.key)?.cancel(); view.waitsForRetry = false
                            }
                        }
                        if (change.full || gap || view.scope in change.scopes) view.whole = true
                        view.touched.addAll(change.records.filter { it.first == view.scope && it.second.type == view.type }.map { it.second })
                        if (view.scope in change.scopes || view.scope in change.firstPullScopes || change.full || gap) view.firstPull = true
                    }
                }
                nudges.trySend(Unit)
            }
        }
        scope.launch {
            for (unused in nudges) {
                val pending = synchronized(mutex) { live().filter { !it.waitsForRetry && (it.whole || it.touched.isNotEmpty() || it.firstPull) } }
                for (view in pending) load(view)
                refreshSmall()
            }
        }
    }
    private fun <T> small(body: () -> T): T? = try {
        engine.lock.withLock { engine.ensureOpen(); engine.store.read(body) }
    } catch (failure: Exception) {
        if (!engine.closed) engine.report(EngineOperation.read, EngineOutcome.failure, "store-failure")
        null
    }
    private fun noticeContent(json: Json): NoticeContent = NoticeContent(json.items("d").map(::Delta), json["cmd"]?.let(::Command), json.items("dependents").map(::noticeContent))
    private fun loadNotices(product: String): List<Notice> = engine.device.current().notices.mapNotNull { notice ->
        val scope = ScopeRef(notice.member("scope"))
        if (notice.flag("dismissed") || engine.registry.product(scope) != product) null else Notice(notice.member("id").str(), product, scope,
            RefusalCode(notice.member("code").str()), notice["detail"], noticeContent(notice.member("content")), notice.member("at").long())
    }
    private fun loadStatus(): SyncStatus.Snapshot {
        val replica = engine.device.current()
        val pending = engine.device.meta["pendingSignIn"]
        return SyncStatus.Snapshot(if (replica.state == "bound") replica.account else null, replica.meta.flag("authPaused"),
            engine.networkUpgradeRequired, engine.networkOnline, pending?.get("account")?.str(),
            replica.outbox.count { it.state == "ready" }, replica.outbox.count { it.state == "sent" })
    }
    fun notices(product: String): NoticesView {
        if (product !in engine.registry.products) throw CommitFailure.malformed("product")
        synchronized(mutex) {
            if (closed) throw CommitFailure(CommitFailure.Kind.notWritable, "closed")
            notices[product]?.get()?.let { return it }
        }
        val initial = small { loadNotices(product) } ?: emptyList()
        return synchronized(mutex) {
            if (closed) throw CommitFailure(CommitFailure.Kind.notWritable, "closed")
            notices[product]?.get() ?: NoticesView(product, initial).also { notices[product] = WeakReference(it); nudges.trySend(Unit) }
        }
    }
    val undoOffers: UndoOffers get() {
        synchronized(mutex) {
            if (closed) throw CommitFailure(CommitFailure.Kind.notWritable, "closed")
            offersView?.let { return it }
        }
        val initial = small { engine.undoOffers() } ?: emptyList()
        return synchronized(mutex) {
            if (closed) throw CommitFailure(CommitFailure.Kind.notWritable, "closed")
            offersView ?: UndoOffers(initial).also { offersView = it; nudges.trySend(Unit) }
        }
    }
    val status: SyncStatus get() {
        synchronized(mutex) {
            if (closed) throw CommitFailure(CommitFailure.Kind.notWritable, "closed")
            statusView?.let { return it }
        }
        val initial = small(::loadStatus) ?: SyncStatus.Snapshot()
        return synchronized(mutex) {
            if (closed) throw CommitFailure(CommitFailure.Kind.notWritable, "closed")
            statusView ?: SyncStatus(initial).also { statusView = it; nudges.trySend(Unit) }
        }
    }
    private fun refreshSmall() {
        val views = synchronized(mutex) {
            notices.entries.removeAll { it.value.get() == null }
            Triple(notices.values.mapNotNull { it.get() }, offersView, statusView)
        }
        var failed = false
        for (view in views.first) {
            val next = small { loadNotices(view.product) }
            if (next == null) failed = true else view.land(next)
        }
        views.second?.let { view ->
            val next = small { engine.undoOffers() }
            if (next == null) failed = true else view.land(next)
        }
        views.third?.let { view ->
            val next = small(::loadStatus)
            if (next == null) failed = true else view.land(next)
        }
        synchronized(mutex) {
            if (!failed) { smallFailures = 0; smallRetry?.cancel(); smallRetry = null }
            else if (smallRetry == null && !closed) {
                val wait = retryMs[minOf(smallFailures++, retryMs.lastIndex)]
                smallRetry = scope.launch {
                    delay(wait)
                    synchronized(mutex) { smallRetry = null }
                    nudges.trySend(Unit)
                }
            }
        }
    }
    fun records(scope: ScopeRef, type: String, field: String?, id: RecordID?, mode: ViewMode): RecordsView {
        if ((field == null) != (id == null) || !engine.registry.lives(type, scope)) throw CommitFailure.malformed("scope-type")
        if (field != null && engine.registry.type(type)?.fields?.get(field)?.ref == null) throw CommitFailure.malformed("reference-field")
        val key = RecordsView.Key(scope, type, field, id, mode)
        val view = synchronized(mutex) {
            if (closed) throw CommitFailure(CommitFailure.Kind.notWritable, "closed")
            val view = records[key]?.get() ?: RecordsView(key).also { records[key] = WeakReference(it) }
            recent.remove(view); recent.add(view)
            if (recent.size > 8) recent.removeAt(0)
            view
        }
        nudges.trySend(Unit)
        return view
    }
    private fun live(): List<RecordsView> {
        records.entries.removeAll { it.value.get() == null }
        return records.values.mapNotNull { it.get() }
    }
    private suspend fun load(view: RecordsView) {
        val whole: Boolean
        val touched: Set<RecordKey>
        val firstPull: Boolean
        val invalidatedVersion: Long
        val replica: String?
        synchronized(mutex) {
            whole = view.whole; touched = view.touched.toSet(); firstPull = view.firstPull
            invalidatedVersion = view.invalidatedVersion; replica = view.replica
            view.whole = false; view.touched.clear(); view.firstPull = false
        }
        try {
            engine.lock.withLock {
                engine.ensureOpen()
                synchronized(mutex) {
                    view.seat(engine.device.current().id, engine.device.current().account)
                    view.invalidatedVersion = maxOf(view.invalidatedVersion, engine.version)
                }
                engine.read(view.scope) { reader ->
                    val shown = (view.state.value as? RecordsView.State.Loaded)?.snapshot
                    val key = view.key
                    // A touched-key set covers only the invalidations captured before taking the writer.
                    val records = if (whole || shown == null || engine.version > invalidatedVersion || engine.device.current().id != replica) when {
                        key.field != null && key.mode == ViewMode.drawn -> reader.drawn(key.type, key.field, key.id!!)
                        key.field != null -> reader.stored(key.type, key.field, key.id!!)
                        key.mode == ViewMode.drawn -> reader.drawn(key.type)
                        else -> reader.stored(key.type)
                    } else {
                        val updated = shown.records.associateBy { RecordKey(it.type, it.id) }.toMutableMap()
                        for (recordKey in touched) {
                            val row = if (key.mode == ViewMode.drawn) reader.drawn(key.type, recordKey.id) else reader.stored(key.type, recordKey.id)
                            if (row == null || !row.isVisible || key.field != null && row.values[key.field] != key.id?.json) updated.remove(recordKey)
                            else updated[recordKey] = row
                        }
                        updated.toSortedMap().values.toList()
                    }
                    synchronized(mutex) { if (!closed) view.land(RecordsView.Snapshot(records, reader.firstPullComplete()), engine.version) }
                }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            if (failure is CommitFailure && failure.kind == CommitFailure.Kind.notWritable && engine.closed) return
            val wait = synchronized(mutex) {
                view.whole = view.whole || whole
                view.touched.addAll(touched); view.firstPull = view.firstPull || firstPull
                view.failures++; view.waitsForRetry = true
                retryMs[minOf(view.failures - 1, retryMs.lastIndex)]
            }
            synchronized(mutex) {
                retries[view.key]?.cancel()
                val key = view.key
                val retrying = WeakReference(view)
                retries[key] = scope.launch {
                    delay(wait)
                    synchronized(mutex) { retrying.get()?.waitsForRetry = false; retries.remove(key) }
                    nudges.trySend(Unit)
                }
            }
        }
    }
    override fun close() {
        synchronized(mutex) {
            if (closed) return
            closed = true; records.clear(); recent.clear(); retries.clear(); notices.clear(); offersView = null; statusView = null
        }
        nudges.close(); scope.cancel()
    }
    companion object { private val retryMs = longArrayOf(100, 200, 400, 800, 1_600, 3_200) }
}
