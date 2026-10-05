package works.windmill.sync.modelserver

import works.windmill.sync.core.*

class JournalServerRules : ServerRules {
    override fun replays(command: CheckedCommand, context: RuleContext) = command.name == "journal.claimPage" && context.entry("journalClaims", command.string("claimId")) != null
    override fun run(command: CheckedCommand, context: RuleContext): CommandOutcome {
        val args = command.args; val day = command.string("day"); val body = command.string("body")
        if (!isCalendarDay(day)) throw Refusal("invalid")
        if (body.encodeToByteArray().size > 131_072) throw Refusal("too-large")
        if (context.deltas.any { it.key.type == "page" }) throw Refusal("invalid")
        val key = RecordKey("page", RecordID(day)); val current = context.idState(key).row; var document = args
        when (command.name) {
            "journal.savePage" -> {
                val stamp = args["stamp"] ?: throw Refusal("invalid"); if (!ContentClock.valid(stamp)) throw Refusal("invalid")
                current?.lattice?.fields?.get("documentStamp")?.value?.let { if (ContentClock.compare(stamp, it) <= 0) return CommandOutcome(product = context.product) }
            }
            "journal.claimPage" -> {
                val id = command.string("claimId"); context.ensure("journalClaims"); val digest = ScopeDigest.row(Json.Obj(args.toList())).hex
                context.entry("journalClaims", id)?.let { if (it["digest"] != Json.of(digest)) throw Refusal("claim-conflict"); return CommandOutcome(product = context.product) }
                val joined = claimBody(current?.texts?.get("body")?.text ?: "", body)
                if (joined.encodeToByteArray().size > 131_072) throw Refusal("too-large")
                context.ensure("journalContentClocks")
                val stamp = try { ContentClock.next(context.entry("journalContentClocks", "server"), current?.lattice?.fields?.get("documentStamp")?.value, context.serverNow, "srv") } catch (_: IllegalArgumentException) { throw Refusal("invalid") }
                context.store("journalContentClocks", "server", ContentClock.pair(stamp))
                document = args + mapOf("stamp" to stamp, "body" to Json.of(joined)) + listOf("mood", "energy").filter { args[it] === Json.Null }.associateWith { current?.lattice?.fields?.get(it)?.value ?: Json.Null }
                context.store("journalClaims", id, Json.objectOf("digest" to Json.of(digest), "day" to Json.of(day), "documentStamp" to stamp))
            }
            else -> throw Refusal("invalid")
        }
        context.ensure("journalPages"); context.store("journalPages", day, Json.objectOf("updatedAt" to Json.of(context.serverNow)))
        val fields = listOf("mood", "energy", "source").associateWith { document.getValue(it) } + ("documentStamp" to document.getValue("stamp"))
        val archive = Json.objectOf("archivedAt" to Json.of(context.serverNow)).with("documentStamp" to current?.lattice?.fields?.get("documentStamp")?.value)
        val delta = PlannedDelta.update(key, null, fields).copy(replacements = mapOf("body" to TextReplacement(document.getValue("body").str(), true, archive)))
        return CommandOutcome(listOf(delta), listOf(WriteClaim(key, fields = fields.keys.sorted())), product = context.product)
    }
    override fun check(changes: List<RecordChange>, context: RuleContext): List<PlannedDelta> {
        if (context.deltas.any { it.key.type == "page" }) throw Refusal("invalid")
        return emptyList()
    }
    override fun pruneRevisions(revisions: List<Json>, archived: List<Json>, now: Long, scope: ScopeKey, context: ServerState): List<Json> {
        val days = archived.filter { it.recordKey.type == "page" && it.member("field").str() == "body" }.map { it.recordKey.id }.toSet()
        val kept = prune(revisions, days, now)
        val projection = context.product["journalRevisionProjection"]?.get(scope.text)
        if (projection != null) {
            val revs = kept.map { it.member("rev").long().toString() }.toSet()
            context.product = context.product.with("journalRevisionProjection" to context.product.member("journalRevisionProjection").with(scope.text to Json.Obj(projection.obj().filterKeys { it in revs }.toList())))
        }
        return kept
    }
    companion object {
        fun isCalendarDay(day: String): Boolean {
            if (!day.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}"))) return false
            val year = day.take(4).toInt(); val month = day.substring(5, 7).toInt(); val date = day.takeLast(2).toInt()
            if (year == 0 || month !in 1..12) return false
            val leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
            return date in 1..listOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[month - 1]
        }
        fun claimBody(account: String, here: String): String {
            val a = TextMerge.trimmed(TextMerge.trimmed(account, true), false); val h = TextMerge.trimmed(TextMerge.trimmed(here, true), false)
            return when { a.isEmpty() -> here; h.isEmpty() -> account; here.contains(a) -> here; else -> TextMerge.trimmed(account, false) + "\n\n" + TextMerge.trimmed(here, true) }
        }
        fun prune(revisions: List<Json>, days: Set<RecordID>, now: Long): List<Json> {
            val newest = revisions.sortedWith(compareByDescending<Json> { it["archivedAt"]?.long() ?: 0 }.thenByDescending { it.member("rev").long() })
            val daily = mutableMapOf<RecordID, Int>(); var bytes = 0L
            val candidates = newest.filter { row -> if (row.recordKey.id !in days) true else { val count = (daily[row.recordKey.id] ?: 0) + 1; daily[row.recordKey.id] = count; count <= 10 } }
            return candidates.filterIndexed { index, row -> bytes += row.member("text").str().encodeToByteArray().size; index < 500 && bytes <= 8_388_608 && (row["archivedAt"]?.long() ?: 0) >= now - 90 * 86_400_000L }
        }
    }
}
