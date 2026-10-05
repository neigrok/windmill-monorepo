package works.windmill.sync.core

data class RefusalCode(val text: String) {
    val json: Json get() = Json.of(text)
    override fun toString(): String = text
    companion object {
        val notFound = RefusalCode("not-found")
        val scopeDead = RefusalCode("scope-dead")
        val forbidden = RefusalCode("forbidden")
        val invalid = RefusalCode("invalid")
        val tooLarge = RefusalCode("too-large")
        val clockSkew = RefusalCode("clock-skew")
        val idTaken = RefusalCode("id-taken")
        val idSpent = RefusalCode("id-spent")
        val unknownRecord = RefusalCode("unknown-record")
        val recordDead = RefusalCode("record-dead")
        val parentDead = RefusalCode("parent-dead")
        val stale = RefusalCode("stale")
        val cap = RefusalCode("cap")
        val baseUnknown = RefusalCode("base-unknown")
        val requestConflict = RefusalCode("request-conflict")
        val requestRunning = RefusalCode("request-running")
        val internalError = RefusalCode("internal")
        val targetMerged = RefusalCode("target-merged")
        val engine: List<RefusalCode> = listOf(notFound, scopeDead, forbidden, invalid, tooLarge, clockSkew, idTaken,
            idSpent, unknownRecord, recordDead, parentDead, stale, cap, baseUnknown, requestConflict, requestRunning, internalError, targetMerged)
    }
}

data class WriteMapEntry(val key: RecordKey, val from: RecordID? = null, val born: Stamp? = null, val fields: Map<String, Stamp> = emptyMap()) {
    constructor(json: Json) : this(RecordKey(json.member("t").str(), RecordID(json.member("id"))), json["from"]?.let(::RecordID),
        json["born"]?.str()?.let(::Stamp), readMap(json["f"]) { Stamp(it.str()) })
    val stamps: List<Stamp> get() = listOfNotNull(born) + fields.values
}

data class PushResult(val n: Long, val verdict: Verdict, val detail: Json? = null) {
    sealed interface Verdict {
        data class Ok(val seq: Long, val write: List<WriteMapEntry>? = null) : Verdict
        data class Refused(val code: RefusalCode) : Verdict
    }
    constructor(json: Json) : this(json.member("n").long(), when (json.member("s").str()) {
        "ok" -> Verdict.Ok(json.member("seq").long(), json["write"]?.arr()?.map(::WriteMapEntry))
        "refused" -> Verdict.Refused(RefusalCode(json.member("code").str()))
        else -> throw JsonError("push-result")
    }, json["detail"])
}
