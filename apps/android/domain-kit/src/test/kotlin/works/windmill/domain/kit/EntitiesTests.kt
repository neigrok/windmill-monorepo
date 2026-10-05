package works.windmill.domain.kit

import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.RefusalCode

class EntitiesTests {
    data class Sample(override val id: Id<Sample>, val title: String, val count: Int = 1) : Writable<Sample> {
        override fun fields(): Map<String, Json> = mapOf("title" to Json.of(title), "count" to Json.of(count))
    }
    private class SampleType(override val checks: List<Check<Sample>>) : WritableType<Sample> {
        override val type = "sample"
        override val scope = ScopeRef.product("probe")
        override fun decode(f: Fields): Sample = Sample(Id(f.id, this), f.string("title"), f.int("count"))
    }
    private val moment = Moment(Instant(100), FixedZone(0))
    private fun <T : Throwable> failure(type: Class<T>, body: () -> Unit): T {
        try { body() } catch (failure: Throwable) {
            if (type.isInstance(failure)) return type.cast(failure)
            throw failure
        }
        throw AssertionError("expected ${type.name}")
    }
    @Test fun onlyNamedFieldsNormaliseButKeyChecksAlwaysRun() {
        var keyChecks = 0
        val type = SampleType(listOf(Check.key { _, _ -> keyChecks++ },
            Check("title") { value, _ -> value.copy(title = value.title.trim()) },
            Check("count") { value, _ -> value.copy(count = 2) }))
        val sample = Sample(Id("a", type), " title ")
        val valid = Valid(sample, type, listOf("title", "title"), moment)
        assertEquals(Sample(sample.id, "title", 1), valid.value)
        assertEquals(listOf("title"), valid.checked)
        assertEquals(1, keyChecks)
        assertEquals(" title ", sample.title)
    }
    @Test fun aFieldCheckCannotMutateAnotherField() {
        val type = SampleType(listOf(Check("title") { value, _ -> value.copy(count = 9) }))
        failure(IllegalStateException::class.java) { Valid(Sample(Id("a", type), "ok"), type, at = moment) }
    }
    @Test fun aNonViolationCheckFailureIsAProgrammingFault() {
        val type = SampleType(listOf(Check("title") { _, _ -> throw IllegalArgumentException("bad check") }))
        val error = failure(IllegalStateException::class.java) { Valid(Sample(Id("a", type), "ok"), type, at = moment) }
        assertTrue(error.cause is IllegalArgumentException)
    }
    @Test fun uncheckedNulGetsTheFieldPathAndCannotEscapeValidation() {
        val type = SampleType(emptyList())
        val error = failure(Violation::class.java) { Valid(Sample(Id("a", type), "bad\u0000"), type, at = moment) }
        assertEquals(Json.objectOf("rule" to Json.of("sample.title"), "path" to Json.of("title"), "reason" to Json.of("nul")), error.json)
        assertEquals(Path("items.0.label"), Json.array(Json.objectOf("label" to Json.of("\u0000"))).firstNul(Path("items")))
        assertEquals(listOf("count"), Valid(Sample(Id("a", type), "bad\u0000"), type, listOf("count"), moment).checked)
    }
    @Test fun decodingIsLenientButMalformedFieldsHaveTheirFullPath() {
        val fields = Fields(Json.objectOf("name" to Json.of("  "), "null" to Json.Null,
            "items" to Json.array(Json.objectOf("n" to Json.of(1.5)))))
        assertEquals("  ", fields.string("name"))
        assertNull(fields.optionalString("null"))
        assertEquals("default", fields.string("missing", "default"))
        assertEquals("", fields.text("missing"))
        val error = failure(DecodeError::class.java) { fields.list("items") { it.int("n") } }
        assertEquals("items.0.n", error.field)
        assertEquals("not an integer", error.reason)
        failure(DecodeError::class.java) { fields.string("null") }
        failure(IllegalStateException::class.java) { fields.id }
    }
    @Test fun millisecondsAreExactAndIdsKeepUtf8Order() {
        val fields = Fields(Json.objectOf("time" to Json.of(1800000000000L), "fraction" to Json.of(0.5), "overflow" to Json.of(9223372036854775808.0)))
        assertEquals(Instant(1800000000000), fields.instant("time"))
        failure(DecodeError::class.java) { fields.instant("fraction") }
        failure(DecodeError::class.java) { fields.instant("overflow") }
        val type = SampleType(emptyList())
        assertTrue(Id("z", type) < Id("é", type))
        assertNotEquals(Id("é", type), Id("e\u0301", type))
        assertEquals(RecordID("2026-10-04"), Id(LocalDay.parse("2026-10-04")!!, type).record)
    }
    @Test fun capacityAndRefusalDetailsRetainCapsLargerThanAnInt() {
        val capacity = Capacity("sample", Int.MAX_VALUE, Int.MAX_VALUE.toLong() + 2)
        assertFalse(capacity.isFull)
        assertNull(capacity.refusal(2, null))
        val refused = capacity.refusal(3, null)!!
        assertEquals("sample" to capacity.cap, refused.cap)
        assertNull(capacity.refusal(0, null))
        assertNull(capacity.refusal(-1, null))
        assertTrue(Capacity("sample", 3, 2).isFull)
        assertNull(Refused(RefusalCode.cap, null, Json.objectOf("type" to Json.of("sample"), "cap" to Json.of(1.5)), Refused.Path.notice).cap)
    }
}
