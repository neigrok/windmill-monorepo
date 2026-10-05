package works.windmill.domain.kit

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.api.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.Life
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.Registry
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.Stamp

class ActionDraftTests {
    private val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readText()))
    private val scope = ScopeRef.product("probe")
    private val moment = Moment(Instant(5000), FixedZone(0))
    private val id = Id("2027-01-10", Day)

    private data class Rejection(val violation: Violation? = null, val refused: Refused? = null)
    private object Rejections : Refusals<Rejection> {
        override fun of(violation: Violation) = Rejection(violation = violation)
        override fun of(refused: Refused) = Rejection(refused = refused)
        override fun isGeneric(refusal: Rejection) = false
    }

    private data class Day(override val id: Id<Day>, val score: Int? = null) : Writable<Day> {
        override fun fields(): Map<String, Json> = mapOf("score" to (score?.let(Json::of) ?: Json.Null))
        companion object : DraftableType<Day>, RemovableType<Day> {
            override val type = "day"
            override val scope = ScopeRef.product("probe")
            override val savesGuarded = true
            override val heldRemoval = true
            override fun decode(f: Fields) = Day(Id(f.id, this), f.optionalInt("score"))
            override val checks = listOf(Check<Day>("score") { value, _ ->
                value.copy(score = NumberSpec("day.score", 0.0, 10.0, integer = true).applyOptional(value.score, Path("score")))
            })
        }
    }

    private data class MutableCard(override val id: Id<MutableCard>, val values: MutableMap<String, Json>) : Writable<MutableCard> {
        override fun fields(): Map<String, Json> = values
        companion object : WritableType<MutableCard> {
            override val type = "card"
            override val scope = ScopeRef.product("probe")
            override val checks: List<Check<MutableCard>> = emptyList()
            override fun decode(f: Fields) = MutableCard(Id(f.id, this), mutableMapOf("title" to Json.of(f.string("title")), "body" to Json.of(f.string("body"))))
        }
    }

    private class Context(val drawnRows: List<Record> = emptyList(), val storedRows: List<Record> = drawnRows) : CommitContext {
        override val now = 5000L
        override val replica = "r_aaaaaaaaaaaa"
        override val actor = "actor"
        override val isAnonymous = false
        override fun drawn(type: String, id: RecordID) = drawnRows.firstOrNull { it.type == type && it.id == id }
        override fun stored(type: String, id: RecordID) = storedRows.firstOrNull { it.type == type && it.id == id }
        override fun drawn(type: String) = drawnRows.filter { it.type == type }
        override fun stored(type: String) = storedRows.filter { it.type == type }
        override fun drawn(type: String, field: String, id: RecordID) = drawn(type).filter { it.values[field] == id.json }
        override fun stored(type: String, field: String, id: RecordID) = stored(type).filter { it.values[field] == id.json }
        override fun device(key: String): Json? = null
        override fun devices(prefix: String): Map<String, Json> = emptyMap()
        override fun firstPullComplete() = true
        override fun confirmed(type: String, id: RecordID) = stored(type, id)
        override fun checkpoint() = ScopeCheckpoint()
        override fun commands(): List<QueuedCommand> = emptyList()
        override fun opaqueID() = "opaque"
        override fun mintID(type: String) = RecordID("cardA001")
    }

    private class Port(val context: Context = Context()) : Replica {
        var failure: Exception? = null
        var dismissed: String? = null
        var dismissalFailure: Exception? = null
        var gesture: Gesture? = null
        var bodyCalls = 0
        var response: CommitOutcome = CommitOutcome.Committed(CommitReceipt("gesture", Stamp("5000:0:r_aaaaaaaaaaaa"),
            listOf("gesture/0"), emptyList(), null, emptyList()))
        override fun <T> commit(scope: ScopeRef, body: (CommitContext) -> Pair<Gesture?, T>): Pair<CommitOutcome?, T> {
            bodyCalls++
            val (written, result) = body(context)
            failure?.let { throw it }
            gesture = written
            return (if (written == null) null else response) to result
        }
        override fun <T> read(scope: ScopeRef, body: (ScopeReader) -> T): T = body(context)
        override fun undo(gestureId: String) = true
        override fun mintID(type: String) = context.mintID(type)
        override fun physNow() = context.now
        override fun dismissNotice(id: String) {
            dismissalFailure?.let { throw it }
            dismissed = id
        }
    }

    private class ContextElement : AbstractCoroutineContextElement(Key), ActionContext {
        override var insideRun = false
        companion object Key : CoroutineContext.Key<ContextElement>
    }
    private fun runner(port: Port = Port(), context: ActionContext = ContextElement()) = ActionRunner(port, registry, FixedZone(0), context)
    private fun record(score: Int, visible: Boolean = true): Record = Record("day", id.record,
        Life(if (visible) "alive" else "dead", Stamp("1000:0:r_aaaaaaaaaaaa")), null, Day(id, score).fields(),
        emptyMap(), emptyMap(), null, null, visible, false, !visible)

    private fun action(load: (Reader) -> Unit = {}, decide: () -> Decision<String, Rejection>) = object : Action<Unit, String, Rejection> {
        override val scope = this@ActionDraftTests.scope
        override val refusals = Rejections
        override fun load(read: Reader) = load(read)
        override fun decide(loaded: Unit, ids: IDSource) = decide()
    }

    private fun writing(): Decision<String, Rejection> = Decision.Write(Plan().apply { device("test", Json.of(true)) }, "result")

    @Test fun violationIsTheOnlyConvertedLoadOrDecideFailure() {
        val violation = Violation("test", Path("score"), Violation.Reason.Blank)
        val port = Port()
        assertEquals(Outcome.Refused(Rejection(violation = violation)), runner(port).run(action { throw violation }))
        assertNull(port.gesture)
        val failure = Exception("store read failed")
        assertSame(failure, assertThrows(Exception::class.java) { runner().run(action(load = { throw failure }) { writing() }) })
        assertSame(violation, assertThrows(Violation::class.java) { runner().run(action(load = { throw violation }) { writing() }) })
    }

    @Test fun commitFailuresArePropagatedForWriteAndNoWriteAndOwnershipIsReleased() {
        val context = ContextElement()
        for (kind in listOf(CommitFailure.Kind.notWritable, CommitFailure.Kind.storeFailure)) {
            for (decision in listOf<Decision<String, Rejection>>(writing(), Decision.Unchanged("result"), Decision.Refuse(Rejection()))) {
                val port = Port().apply { failure = CommitFailure(kind, "failure") }
                assertSame(port.failure, assertThrows(CommitFailure::class.java) { runner(port, context).run(action { decision }) })
                assertFalse(context.insideRun)
                assertNull(port.gesture)
                port.failure = null
                assertEquals(Outcome.Unchanged("result"), runner(port, context).run(action { Decision.Unchanged("result") }))
            }
        }
    }

    @Test fun malformedCommitTrapsAndDoesNotBecomeASaveFailure() {
        val context = ContextElement()
        val port = Port().apply { failure = CommitFailure.malformed("bad change") }
        assertThrows(ProgrammingFault::class.java) { runner(port, context).run(action { writing() }) }
        assertFalse(context.insideRun)
        var writeBack = 0
        assertThrows(ProgrammingFault::class.java) {
            runner(port, context).save(Draft.new(Day(id)).edit { it.copy(score = 4) }, Day, Rejections) { writeBack++ }
        }
        assertFalse(context.insideRun)
        assertEquals(0, writeBack)
    }

    @Test fun nestingAcrossRunnersTrapsBeforeEnteringTheInnerPortAndRecovers() {
        val context = ContextElement()
        val innerPort = Port()
        val inner = runner(innerPort, context)
        val outer = runner(context = context)
        assertThrows(IllegalStateException::class.java) {
            outer.run(action(load = { inner.run(action { Decision.Unchanged("inner") }) }) { writing() })
        }
        assertEquals(0, innerPort.bodyCalls)
        assertEquals(Outcome.Unchanged("inner"), inner.run(action { Decision.Unchanged("inner") }))
    }

    @Test fun nestedChildRunAfterSuspensionAndDispatcherHopUsesTheInheritedElement() = runBlocking(ContextElement()) {
        val context = requireNotNull(coroutineContext[ContextElement])
        val innerPort = Port()
        val outer = runner(context = context)
        assertThrows(IllegalStateException::class.java) {
            outer.run(action(load = {
                runBlocking(coroutineContext + Dispatchers.Default) {
                    async {
                        yield()
                        val inherited = requireNotNull(coroutineContext[ContextElement])
                        assertSame(context, inherited)
                        runner(innerPort, inherited).run(action { Decision.Unchanged("inner") })
                    }.await()
                }
            }) { writing() })
        }
        assertEquals(0, innerPort.bodyCalls)
        assertFalse(context.insideRun)
        yield()
        withContext(Dispatchers.Default) {
            val inherited = requireNotNull(coroutineContext[ContextElement])
            assertEquals(Outcome.Unchanged("recovered"), runner(innerPort, inherited).run(action { Decision.Unchanged("recovered") }))
        }
        assertFalse(context.insideRun)
    }

    @Test fun independentCoroutineElementsCanRunConcurrentlyAndReleaseAfterFailure() = runBlocking {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val firstContext = ContextElement()
        val secondContext = ContextElement()
        val first = async(Dispatchers.Default + firstContext) {
            val context = requireNotNull(coroutineContext[ContextElement])
            runner(context = context).run(action(load = {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
            }) { Decision.Unchanged("first") })
        }
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertTrue(firstContext.insideRun)
            withContext(Dispatchers.Default + secondContext) {
                yield()
                val context = requireNotNull(coroutineContext[ContextElement])
                val failure = Exception("load failed")
                assertSame(failure, assertThrows(Exception::class.java) {
                    runner(context = context).run(action(load = { throw failure }) { writing() })
                })
                assertFalse(context.insideRun)
                assertEquals(Outcome.Unchanged("second"), runner(context = context).run(action { Decision.Unchanged("second") }))
            }
        } finally { release.countDown() }
        assertEquals(Outcome.Unchanged("first"), first.await())
        assertFalse(firstContext.insideRun)
        assertFalse(secondContext.insideRun)
    }

    @Test fun stalledLoadOnOneThreadDoesNotRejectAnIndependentRunAndBothTerminate() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val first = Thread {
            try { runner().run(action(load = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }) { Decision.Unchanged("first") }) }
            catch (error: Throwable) { failure.set(error) }
        }
        first.start()
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertEquals(Outcome.Unchanged("second"), runner().run(action { Decision.Unchanged("second") }))
        } finally { release.countDown(); first.join(5000) }
        assertFalse(first.isAlive)
        assertNull(failure.get())
    }

    @Test fun refusalNoticeIsDismissedBeforeReturningAndDismissalFailurePropagates() {
        val context = ContextElement()
        val port = Port().apply { response = CommitOutcome.Refused(RefusalCode.tooLarge, null, "notice:gesture/0") }
        val outcome = runner(port, context).run(action { writing() })
        assertEquals(Outcome.Refused(Rejection(refused = Refused(RefusalCode.tooLarge, null, path = Refused.Path.predicted))), outcome)
        assertEquals("notice:gesture/0", port.dismissed)
        val failure = Exception("dismissal failed")
        port.dismissalFailure = failure
        assertSame(failure, assertThrows(Exception::class.java) { runner(port, context).run(action { writing() }) })
        assertFalse(context.insideRun)
        port.dismissalFailure = null
        assertEquals(outcome, runner(port, context).run(action { writing() }))
    }

    @Test fun emptyRetiredSupersededAndDeviceOnlyReceiptsMapExactly() {
        val empty = CommitReceipt("gesture", Stamp("5000:0:r_aaaaaaaaaaaa"), emptyList(), emptyList(), null, emptyList())
        val port = Port().apply { response = CommitOutcome.Committed(empty) }
        assertEquals(Outcome.Unchanged("result"), runner(port).run(action { Decision.Write(Plan(), "result") }))
        for (receipt in listOf(empty.copy(retired = listOf("old")), empty.copy(superseded = listOf("old")))) {
            port.response = CommitOutcome.Committed(receipt)
            assertEquals(Outcome.Committed("result", receipt), runner(port).run(action { Decision.Write(Plan(), "result") }))
        }
        port.response = CommitOutcome.Committed(empty)
        assertEquals(Outcome.Committed("result", empty), runner(port).run(action { writing() }))
    }

    @Test fun goneIsPredictedBeforeTranslationForUpdatesAndRemoval() {
        val value = Day(id, 4)
        for (plan in listOf(Plan().apply { update(Valid(value, Day, at = moment)) }, Plan().apply { remove(id) })) {
            val port = Port()
            assertEquals(Outcome.Refused(Rejection(refused = Refused(RefusalCode.unknownRecord, id.ref, path = Refused.Path.predicted))),
                runner(port).run(action { Decision.Write(plan, "result") }))
            assertNull(port.gesture)
        }
    }

    @Test fun saveWritesBackExactlyOnceForSavedRefusedAndFailed() {
        val blank = Draft.new(Day(id)).edit { it.copy(score = 4) }
        for (kind in listOf<CommitFailure.Kind?>(null, CommitFailure.Kind.notWritable, CommitFailure.Kind.storeFailure)) {
            val port = Port().apply { failure = kind?.let { CommitFailure(it, "failure") } }
            var writes = 0
            var saved: Draft<Day>? = null
            val result = runner(port).save(blank, Day, Rejections) { writes++; saved = it }
            assertEquals(1, writes)
            if (kind == null) {
                assertTrue(result is SaveResult.Saved)
                assertEquals(4, saved!!.base.score)
                assertFalse(saved!!.isNew)
                assertFalse(saved!!.isDirty)
            } else {
                assertEquals(SaveResult.Failed(port.failure!!), result)
                assertSame(blank, saved)
            }
        }
        val invalid = blank.edit { it.copy(score = 11) }
        var writes = 0
        assertTrue(runner().save(invalid, Day, Rejections) { writes++; assertSame(invalid, it) } is SaveResult.Refused)
        assertEquals(1, writes)
    }

    @Test fun aDraftCannotBeSavedFromAnotherThreadAndAnEditCannotReplaceItsId() {
        val draft = Draft.new(Day(id)).edit { it.copy(score = 4) }
        val failure = AtomicReference<Throwable?>()
        var writes = 0
        val worker = Thread {
            try { runner().save(draft, Day, Rejections) { writes++ } }
            catch (error: Throwable) { failure.set(error) }
        }
        worker.start(); worker.join(5000)
        assertFalse(worker.isAlive)
        assertTrue(failure.get() is IllegalStateException)
        assertEquals(0, writes)
        assertThrows(IllegalStateException::class.java) { draft.edit { it.copy(id = Id("2027-01-11", Day)) } }
    }

    @Test fun guardedRebaseKeepsMineAndRefreshesBaseThenSaves() {
        val draft = Draft.opening(Day(id, 2)).edit { it.copy(score = 4) }
        val stalePort = Port(Context(listOf(record(3))))
        var retained: Draft<Day>? = null
        assertEquals(SaveResult.Refused(Rejection(refused = Refused(RefusalCode.stale, id.ref, path = Refused.Path.predicted))),
            runner(stalePort).save(draft, Day, Rejections) { retained = it })
        assertSame(draft, retained)
        val rebased = draft.rebased(Day(id, 3))
        assertEquals(3, rebased.base.score)
        assertEquals(4, rebased.current.score)
        assertEquals(listOf("score"), rebased.touched)
        assertTrue(runner(stalePort).save(rebased, Day, Rejections) { assertFalse(it.isDirty) } is SaveResult.Saved)
        assertThrows(IllegalStateException::class.java) { draft.rebased(Day(Id("2027-01-11", Day), 3)) }
    }

    @Test fun openingWithBlankRejectsAnotherIdAndMissingKeyedDraftIsNew() {
        assertThrows(IllegalStateException::class.java) { runner().open(Day, id, Day(Id("2027-01-11", Day))) }
        val opened = runner().open(Day, id, Day(id))
        assertTrue(opened.isNew)
        assertNull(runner().open(Day, id))
    }

    @Test fun aCheckCannotRedirectTheValidatedWriteToAnotherId() {
        for (field in listOf<String?>("score", null)) {
            val swapping = object : WritableType<Day> {
                override val type = Day.type
                override val scope = Day.scope
                override fun decode(f: Fields) = Day.decode(f)
                override val checks = listOf(Check<Day>(field) { value, _ -> value.copy(id = Id("2027-01-11", Day)) })
            }
            assertThrows(IllegalStateException::class.java) { Valid(Day(id, 2), swapping, at = moment) }
        }
    }

    @Test fun aCheckCannotHideAnUnrelatedFieldMutationThroughAMapAlias() {
        val mutating = object : WritableType<MutableCard> {
            override val type = MutableCard.type
            override val scope = MutableCard.scope
            override fun decode(f: Fields) = MutableCard.decode(f)
            override val checks = listOf(Check<MutableCard>("title") { value, _ ->
                value.values["body"] = Json.of("changed")
                value
            })
        }
        val value = MutableCard(Id("cardA001", MutableCard), mutableMapOf("title" to Json.of("Alpha"), "body" to Json.of("before")))
        assertThrows(IllegalStateException::class.java) { Valid(value, mutating, fields = listOf("title"), at = moment) }
    }

    @Test fun aPlanWritesTheValidatedSnapshotEvenWhenTheInputMapChanges() {
        val value = MutableCard(Id("cardA001", MutableCard), mutableMapOf("title" to Json.of("Alpha"), "body" to Json.of("before")))
        val valid = Valid(value, MutableCard, at = moment)
        value.values["title"] = Json.of("after validation")
        val plan = Plan().apply { create(valid) }
        value.values["body"] = Json.of("after append")
        val change = plan.gesture(scope, registry).changes.single()
        assertEquals(mapOf("title" to Json.of("Alpha"), "body" to Json.of("before")), change.values)
    }
}
