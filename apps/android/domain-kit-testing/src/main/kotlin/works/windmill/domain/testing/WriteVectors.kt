package works.windmill.domain.testing

import kotlinx.coroutines.runBlocking
import works.windmill.sync.testing.SteppedEngine
import works.windmill.domain.kit.*
import works.windmill.sync.api.*
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.core.Registry
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.Stamp
import works.windmill.sync.core.Delta
import works.windmill.sync.core.Command
import works.windmill.sync.core.lives

internal fun fields(json: Json?): Map<String, Json> = json?.obj() ?: emptyMap()
internal fun names(json: Json) = json.arr().map { it.str() }
internal fun recordID(json: Json?): RecordID? = json?.orNull()?.let(::RecordID)
internal fun placement(json: Json?): Placement? = when (json) {
    null, Json.Null -> null
    Json.of("top") -> Placement.Top
    Json.of("bottom") -> Placement.Bottom
    else -> Placement.Below(RecordID(json.member("below")))
}
internal fun probeRegistry() = Registry(Contract.json("sync/probe.registry.json"))

internal object WriteVectors {
    fun build(input: Json, at: Moment): Plan {
        val command = input["cmd"]?.let { json ->
            val name = json.member("name").str()
            object : ServerCommand {
                override val name = name
                override val args = fields(json["args"])
                override val specs = if (name == "probe.start") listOf(TextSpec("probe.start.label", works.windmill.sync.core.MeasureUnit.chars, 0, 12, true, true)) else emptyList()
            }
        }
        val predictions = (input["predict"]?.arr() ?: emptyList()).map { json ->
            val type = Probe.entity(json.member("t").str())
            val id = Id(RecordID(json.member("id")), type)
            val scope = json["scope"]?.let(::ScopeRef)
            when (json.member("op").str()) {
                "create" -> Prediction.create(type, id, fields(json["f"]), scope)
                "write" -> Prediction.write(type, id, fields(json["f"]), scope = scope)
                else -> Prediction.update(type, id, fields(json["f"]), scope)
            }
        }
        val plan = command?.let { Plan(it, predictions) } ?: Plan()
        for (operation in input.member("plan").arr()) {
            val op = operation.member("op").str()
            if (op == "device") { plan.device(operation.member("key").str(), operation.member("value").orNull()); continue }
            val type = Probe.entity(operation.member("t").str())
            val record = RecordID(operation.member("id"))
            val id = Id(record, type)
            fun valid(): Valid<ProbeEntity> {
                val value = type.entity(record, fields(operation["f"]))
                val checked = operation["checked"]?.let(::names) ?: operation["fields"]?.let(::names) ?: value.fields().keys.toList()
                return Valid(value, type, checked, at)
            }
            when (op) {
                "create" -> plan.create(valid(), fields = operation["fields"]?.let(::names))
                "insert" -> { if (type !is OrderedType<*>) throw PlanError(0, "$op of ${type.type} is unexpressible"); plan.insert(valid(), recordID(operation["below"])) }
                "update" -> plan.update(valid(), operation["fields"]?.let(::names), operation["base"]?.let { type.entity(record, fields(it)) }, operation["guarded"]?.bool() ?: false)
                "revive" -> plan.revive(valid(), names(operation.member("fields")), operation["base"]?.let { type.entity(record, fields(it)) }, operation["guarded"]?.bool() ?: false)
                "remove" -> { if (type !is RemovableType<*>) throw PlanError(0, "$op of ${type.type} is unexpressible"); plan.remove(id) }
                "move" -> { if (type !is OrderedType<*>) throw PlanError(0, "$op of ${type.type} is unexpressible"); plan.move(id, recordID(operation["below"])?.let { Id(it, type) }) }
                "guardRead" -> plan.guardRead(id, names(operation.member("fields")))
                else -> throw ContractError("no plan operation $op")
            }
        }
        return plan
    }
    fun translate(input: Json): Json = try {
        // `tagField` replaces the tag's label declaration and `linkFields` the link's fields, each proving one rule.
        val replaced = listOfNotNull(input["tagField"]?.let { "tag" to Json.objectOf("label" to it) }, input["linkFields"]?.let { "link" to it }).toMap()
        val registry = if (replaced.isEmpty()) probeRegistry() else probeRegistry().json.let { document ->
            Registry(document.with("types" to Json.Arr(document.member("types").arr().map { type ->
                replaced[type.member("type").str()]?.let { type.with("fields" to it) } ?: type
            })))
        }
        Json.objectOf("gesture" to build(input, moment(input)).gesture(input["scope"]?.str()?.let(::ScopeRef) ?: Probe.scope, registry).form)
    } catch (violation: Violation) { Json.objectOf("violation" to violation.json) }
      catch (error: PlanError) { Json.objectOf("error" to Json.of(true)) }
    // §9.5 an act's decision as ProductCorpus.act gives it to a product's vectors: each scope of `loads` read for the ids it
    // draws, which is the result, and each segment built as in plan/translate.json, an operation with `mint` taking the next id
    // in its segment's scope.
    fun actDecision(input: Json): Json {
        val registry = probeRegistry()
        val act = object : ActAction<Pair<Moment, Json>, Json, ProbeRefusal> {
            override val refusals = ProbeRefusals
            override fun load(read: ActReader) = read.moment to Json.Obj(input.member("loads").arr().map { scope ->
                scope.str() to read.inScope(ScopeRef(scope)) { reader ->
                    Json.Arr(registry.types.filter { registry.lives(it.name, reader.scope) }.flatMap { reader.source.drawn(it.name) }.map { it.id.json })
                }
            })
            override fun decide(loaded: Pair<Moment, Json>, ids: ActIDSource): ActDecision<Json, ProbeRefusal> {
                val (moment, drawn) = loaded
                val segments = input.member("segments").arr()
                if (segments.isEmpty()) return ActDecision.Unchanged(drawn)
                return ActDecision.Write(ActPlan(segments.map { segment ->
                    val scope = ScopeRef(segment.member("scope"))
                    val plan = Json.Arr(segment.member("plan").arr().map { operation ->
                        if (operation["mint"] != Json.of(true)) operation else operation.with("id" to ids.mint(Probe.entity(operation.member("t").str()), scope).record.json)
                    })
                    ScopedPlan(scope, build(segment.with("plan" to plan), moment))
                }), drawn)
            }
        }
        return ProductCorpus(RuleBook(registry, emptyList(), emptyList())).act(act, works.windmill.sync.testing.Vector("domain-kit/run/act-decisions.json", "", input, Json.Null), { it }, { it.form })
    }
    fun pipeline(input: Json): Json = runBlocking { withActionContext { pipeline(input, it) } }
    private fun pipeline(input: Json, context: ActionContext): Json {
        val registry = probeRegistry()
        val moment = moment(input)
        val replica = VectorReplica(VectorRecords(input["drawn"], input["stored"] ?: input["drawn"], registry), moment.now.ms, registry, answer(input))
        val action = object : Action<Moment, Unit, ProbeRefusal> {
            override val scope = input["scope"]?.str()?.let(::ScopeRef) ?: Probe.scope
            override val refusals = ProbeRefusals
            override fun load(read: Reader) = read.moment
            override fun decide(loaded: Moment, ids: IDSource): Decision<Unit, ProbeRefusal> = Decision.Write(build(input, loaded), Unit)
        }
        return try { Json.objectOf("outcome" to ActionRunner(replica, registry, moment.zone, context).run(action).form({ Json.Null }, { it.form })) }
        catch (error: PlanError) { Json.objectOf("error" to Json.of(true)) }
    }
    fun act(input: Json): Json = runBlocking { withActionContext { context ->
        val registry = probeRegistry()
        val moment = moment(input)
        SteppedEngine(registry, startMs = moment.now.ms, account = null).use { engine ->
            val runner = ActionRunner(engine.replica, registry, moment.zone, context)
            input["mint"]?.let { mint ->
                val scope = ScopeRef(mint.member("scope"))
                val type = mint.member("type").str()
                return@use try {
                    val result = engine.replica.commitAct({ source ->
                        if (mint["borrow"]?.bool() == true) source.inScope(scope) { }
                        mint["caughtScope"]?.let { try { source.inScope(ScopeRef(it)) { } } catch (_: CommitFailure) { } }
                        val ids = (0 until mint.member("count").long().toInt()).map { source.mintID(type, scope) }
                        (if (mint["new"]?.bool() == true) ActRequest(listOf(Probe.scope, scope)) else null) to ids
                    }, { ids, index, _ -> if (index == 0) Gesture(listOf(Change.create("board", NewID.Given(RecordID("b_00000001")))))
                        else Gesture(listOf(Change.create(type, NewID.Given(ids[0]), mapOf("label" to Json.of("New"))))) })
                    Json.objectOf("count" to Json.of(result.second.size), "distinct" to Json.of(result.second.toSet().size == result.second.size), "committed" to Json.of(result.first != null))
                } catch (failure: CommitFailure) { if (failure.kind != CommitFailure.Kind.malformed) throw failure; Json.objectOf("error" to Json.of(true)) }
            }
            val action = object : ActAction<Moment, Unit, ProbeRefusal> {
                override val refusals = ProbeRefusals
                override fun load(read: ActReader) = read.moment
                override fun decide(loaded: Moment, ids: ActIDSource): ActDecision<Unit, ProbeRefusal> = ActDecision.Write(
                    ActPlan(input.member("segments").arr().map { ScopedPlan(ScopeRef(it.member("scope")), build(it, loaded)) }), Unit)
            }
            val result = runner.runAct(action)
            var stamps = emptyList<Stamp?>()
            val outcome = when (result) {
                is ActOutcome.Committed -> {
                    stamps = result.receipt.segments.map { it.stamp }
                    if (input["undo"]?.bool() == true) runner.undo(result.receipt.gestureId)
                    Json.objectOf("kind" to Json.of("committed"), "scopes" to Json.Arr(result.receipt.segments.map { it.scope.json }),
                        "counts" to Json.Arr(result.receipt.segments.map { Json.of(it.localIds.size) }), "held" to Json.of(result.receipt.releaseAt != null))
                }
                is ActOutcome.Unchanged -> Json.objectOf("kind" to Json.of("unchanged"))
                is ActOutcome.Refused -> Json.objectOf("kind" to Json.of("refused"), "refusal" to result.refusal.form)
            }
            val records = input.member("inspect").arr().map { item ->
                Json.Arr(engine.replica.read(ScopeRef(item.member("scope"))) { it.drawn(item.member("t").str()) }.filter { it.isVisible }
                    .map { record ->
                        val result = linkedMapOf("id" to record.id.json, "title" to (record.values["title"] ?: Json.Null))
                        if (item["detail"]?.bool() == true) {
                            result["fields"] = Json.Obj(record.values.toList())
                            result["life"] = record.life?.let { Json.of(if (it.isAlive) "alive" else "dead") } ?: Json.Null
                            result["bornSegment"] = Json.of(stamps.indexOf(record.born))
                        }
                        Json.Obj(result.toList())
                    })
            }
            Json.objectOf("outcome" to outcome, "records" to Json.Arr(records))
        }
    } }
    private fun answer(input: Json): CommitOutcome? {
        input["receipt"]?.let { receipt -> return CommitOutcome.Committed(CommitReceipt(receipt.member("gestureId").str(), Stamp.UNSET,
            names(receipt.member("localIds")), emptyList(), receipt["releaseAt"]?.orNull()?.long(), names(receipt.member("retired")))) }
        return input["refused"]?.let { CommitOutcome.Refused(RefusalCode(it.member("code").str()), it["detail"]) }
    }
    fun list(input: Json): Json {
        val type = Probe.entity(input.member("t").str())
        val registry = probeRegistry()
        val records = VectorRecords(input["records"]?.get("drawn"), input["records"]?.get("stored"), registry)
        val source = VectorReader(records, moment(input).now.ms)
        val reader = Reader(source, type.fixtureScope, moment(input), registry)
        val repository = reader.repository(type)
        input["view"]?.let { view -> return Json.objectOf("ids" to Json.Arr(repository.all(if (view.str() == "drawn") ViewMode.drawn else ViewMode.stored).map { it.id.json })) }
        input["children"]?.let { child -> return Json.objectOf("ids" to Json.Arr(repository.children(Id(RecordID(child.member("of")), type), child.member("via").str(), if (child["view"]?.str() == "stored") ViewMode.stored else ViewMode.drawn).map { it.id.json })) }
        input["remove"]?.let {
            @Suppress("UNCHECKED_CAST") val removable = type as? RemovableType<ProbeEntity> ?: return Json.objectOf("error" to Json.of(true))
            val action = Remove(removable, Id(RecordID(it.member("id")), type), ProbeRefusals, type.fixtureScope)
            return Json.objectOf("decision" to action.decide(action.load(reader), IDSource(source)).form(type.fixtureScope, registry, { Json.Null }, { it.form }))
        }
        @Suppress("UNCHECKED_CAST") val ordered = type as? OrderedType<ProbeEntity> ?: return Json.objectOf("error" to Json.of(true))
        placement(input["placement"])?.let { return Json.objectOf("anchor" to (repository.anchor(it, ordered.orderField)?.json ?: Json.Null)) }
        val move = input.member("move")
        val action = Move(ordered, Id(RecordID(move.member("id")), type), recordID(move["below"])?.let { Id(it, type) }, ProbeRefusals, type.fixtureScope)
        return Json.objectOf("decision" to action.decide(action.load(reader), IDSource(source)).form(type.fixtureScope, registry, { Json.Null }, { it.form }))
    }
    fun capacity(input: Json): Json {
        val type = Probe.entity(input.member("t").str())
        val registry = probeRegistry()
        val records = VectorRecords(input["records"]?.get("drawn"), input["records"]?.get("stored"), registry)
        val capacity = Capacity(type, records.stored, registry)
        return Json.objectOf("used" to Json.of(capacity.used), "cap" to Json.of(capacity.cap), "full" to Json.of(capacity.isFull))
    }
    @Suppress("UNCHECKED_CAST")
    private fun draftable(name: String) = Probe.entity(name) as? DraftableType<ProbeEntity> ?: throw ContractError("$name is no probe draftable")
    fun save(input: Json): Json {
        val registry = probeRegistry()
        val form = input["draft"] ?: input.member("creating")
        val type = draftable(form.member("t").str())
        val probe = type as ProbeType
        val id = RecordID(form.member("id"))
        val save = if (input["draft"] != null) {
            val base = probe.entity(id, fields(form["base"]))
            val draft = (if (form.member("isNew").bool()) Draft.new(base, placement(form["placement"]), type.fixtureScope) else Draft.opening(base, type.fixtureScope))
                .edit { probe.entity(id, fields(form["current"])) }
            SaveDraft.fromDraft(draft, type, ProbeRefusals)
        } else SaveDraft(probe.entity(id, fields(form["f"])), type, ProbeRefusals, placement(form["placement"]), type.fixtureScope)
        val source = VectorReader(VectorRecords(input["drawn"], input["stored"], registry), moment(input).now.ms)
        val drawn = source.drawn(type.type, id)?.takeIf { it.isVisible }?.let { type.decode(Fields(it)) }
        val stored = source.stored(type.type, id)
        val loaded = SaveDraftLoaded(drawn, stored?.takeIf { it.isVisible }?.let { type.decode(Fields(it)) }, stored?.let { type.decode(Fields(it)) }, recordID(input["anchor"]), moment(input), registry.type(type.type)!!)
        return Json.objectOf("decision" to save.decision(loaded, IDSource(source)).form(type.fixtureScope, registry, { it.form }, { it.form }))
    }
    fun script(input: Json): Json = runBlocking { withActionContext { script(input, it) } }
    private fun script(input: Json, context: ActionContext): Json {
        val type = draftable(input.member("t").str())
        val probe = type as ProbeType
        val registry = probeRegistry()
        val at = moment(input)
        val replica = VectorReplica(VectorRecords(input["drawn"], input["stored"], registry), at.now.ms, registry)
        val runner = ActionRunner(replica, registry, at.zone, context)
        for ((scope, rows) in input["scopes"]?.obj().orEmpty()) {
            replica.scopes[ScopeRef(scope)] = VectorRecords(rows["drawn"], rows["stored"], registry)
        }
        val remembered = mutableMapOf<String, Draft<ProbeEntity>>()
        var draft: Draft<ProbeEntity>? = null
        val steps = mutableListOf<Json>()
        for (operation in input.member("ops").arr()) {
            val step = linkedMapOf<String, Json>()
            val id = recordID(operation["id"])
            val scope = (operation["scope"] ?: input["scope"])?.str()?.let(::ScopeRef) ?: type.fixtureScope
            try {
                when (operation.member("op").str()) {
                    "new" -> draft = Draft.new(probe.entity(requireNotNull(id)), placement(operation["placement"]), scope)
                    "open" -> draft = runner.open(type, Id(requireNotNull(id), type), scope)
                    "openOrNew" -> draft = runner.open(type, Id(requireNotNull(id), type), probe.entity(recordID(operation["blank"]) ?: id), scope)
                    "edit" -> draft = requireNotNull(draft).edit { probe.entity(it.id.record, it.fields() + fields(operation["f"])) }
                    "save" -> {
                        var saving = requireNotNull(draft)
                        recordID(operation["as"])?.let { other -> saving = saving.edit { probe.entity(other, it.fields()) } }
                        if (operation["fail"]?.bool() == true) replica.failNextCommit()
                        val before = replica.gestures.size
                        val result = runner.save(saving, type, ProbeRefusals, operation["scope"]?.str()?.let(::ScopeRef) ?: saving.scope) { draft = it }
                        val form = when (result) {
                            is SaveResult.Saved -> Json.objectOf("saved" to (result.receipt?.gestureId?.let(Json::of) ?: Json.Null))
                            is SaveResult.Refused -> Json.objectOf("refused" to result.refusal.form)
                            is SaveResult.Failed -> Json.objectOf("failed" to Json.of(true))
                        }
                        var savedForm = form
                        if (input["reportScope"]?.bool() == true) savedForm = Json.Obj((form.obj() + ("scope" to (replica.commitScopes.getOrNull(before)?.let { Json.of(it.text) } ?: Json.Null))).toList())
                        step["result"] = if (operation["gesture"]?.bool() == true) Json.Obj((savedForm.obj() + ("gesture" to (replica.gestures.getOrNull(before)?.form ?: Json.Null))).toList()) else savedForm
                    }
                    "rebase" -> draft = requireNotNull(draft).rebased(probe.entity(id ?: draft!!.id.record, fields(operation["f"])))
                    "load" -> runner.read(scope) { SaveDraft.fromDraft(requireNotNull(draft), type, ProbeRefusals).load(it) }
                    "remember" -> remembered[operation.member("name").str()] = requireNotNull(draft)
                    "recall" -> draft = remembered[operation.member("name").str()]
                    "records" -> replica.records = VectorRecords(operation["drawn"], operation["stored"], registry)
                    else -> throw ContractError("unknown script operation")
                }
                step["draft"] = draft?.let { if (input["reportScope"]?.bool() == true) Json.Obj((it.form.obj() + ("scope" to Json.of(it.scope.text))).toList()) else it.form } ?: Json.Null
                steps.add(Json.Obj(step.toList()))
            } catch (trap: IllegalStateException) {
                steps.add(Json.objectOf("trap" to Json.of(true)))
                break
            }
        }
        return Json.objectOf("steps" to Json.Arr(steps))
    }
    fun subject(input: Json): Json {
        val registry = probeRegistry()
        if (input.member("source").str() == "commit") return Json.objectOf("subject" to (build(input, moment(input)).subjectOfRefusal(RefusalCode(input.member("code").str()), input["detail"], registry)?.form ?: Json.Null))
        val notice = input.member("notice")
        val domain = DomainNotice(Notice(notice.member("id").str(), "probe", ScopeRef(notice.member("scope").str()), RefusalCode(notice.member("code").str()), notice["detail"], content(notice.member("content")), notice["at"]?.long() ?: 0), registry, ProbeRefusals)
        val form = linkedMapOf("subject" to (domain.subject?.form ?: Json.Null), "gestureId" to Json.of(domain.gestureId))
        input["of"]?.let { form["values"] = Json.Obj(domain.values(RecordRef(it.member("t").str(), RecordID(it.member("id")))).toList()) }
        return Json.Obj(form.toList())
    }
    private fun content(json: Json): NoticeContent = NoticeContent(json["d"]?.arr()?.map(::Delta) ?: emptyList(), json["cmd"]?.let(::Command), json["dependents"]?.arr()?.map(::content) ?: emptyList())
}
