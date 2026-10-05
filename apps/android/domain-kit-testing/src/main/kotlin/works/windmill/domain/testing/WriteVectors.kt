package works.windmill.domain.testing

import kotlinx.coroutines.runBlocking
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
            if (json.member("op").str() == "create") Prediction.create(type, id, fields(json["f"])) else Prediction.update(type, id, fields(json["f"]))
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
                "remove" -> { if (type !is RemovableType<*>) throw PlanError(0, "$op of ${type.type} is unexpressible"); plan.remove(id) }
                "move" -> { if (type !is OrderedType<*>) throw PlanError(0, "$op of ${type.type} is unexpressible"); plan.move(id, recordID(operation["below"])?.let { Id(it, type) }) }
                "guardRead" -> plan.guardRead(id, names(operation.member("fields")))
                else -> throw ContractError("no plan operation $op")
            }
        }
        return plan
    }
    fun translate(input: Json): Json = try {
        Json.objectOf("gesture" to build(input, moment(input)).gesture(input["scope"]?.str()?.let(::ScopeRef) ?: Probe.scope, probeRegistry()).form)
    } catch (violation: Violation) { Json.objectOf("violation" to violation.json) }
      catch (error: PlanError) { Json.objectOf("error" to Json.of(true)) }
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
        val reader = Reader(source, type.scope, moment(input), registry)
        val repository = reader.repository(type)
        input["view"]?.let { view -> return Json.objectOf("ids" to Json.Arr(repository.all(if (view.str() == "drawn") ViewMode.drawn else ViewMode.stored).map { it.id.json })) }
        input["children"]?.let { child -> return Json.objectOf("ids" to Json.Arr(repository.children(Id(RecordID(child.member("of")), type), child.member("via").str(), if (child["view"]?.str() == "stored") ViewMode.stored else ViewMode.drawn).map { it.id.json })) }
        input["remove"]?.let {
            @Suppress("UNCHECKED_CAST") val removable = type as? RemovableType<ProbeEntity> ?: return Json.objectOf("error" to Json.of(true))
            val action = Remove(removable, Id(RecordID(it.member("id")), type), ProbeRefusals)
            return Json.objectOf("decision" to action.decide(action.load(reader), IDSource(source)).form(type.scope, registry, { Json.Null }, { it.form }))
        }
        @Suppress("UNCHECKED_CAST") val ordered = type as? OrderedType<ProbeEntity> ?: return Json.objectOf("error" to Json.of(true))
        placement(input["placement"])?.let { return Json.objectOf("anchor" to (repository.anchor(it, ordered.orderField)?.json ?: Json.Null)) }
        val move = input.member("move")
        val action = Move(ordered, Id(RecordID(move.member("id")), type), recordID(move["below"])?.let { Id(it, type) }, ProbeRefusals)
        return Json.objectOf("decision" to action.decide(action.load(reader), IDSource(source)).form(type.scope, registry, { Json.Null }, { it.form }))
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
            val draft = (if (form.member("isNew").bool()) Draft.new(base, placement(form["placement"])) else Draft.opening(base))
                .edit { probe.entity(id, fields(form["current"])) }
            SaveDraft.fromDraft(draft, type, ProbeRefusals)
        } else SaveDraft(probe.entity(id, fields(form["f"])), type, ProbeRefusals, placement(form["placement"]))
        val source = VectorReader(VectorRecords(input["drawn"], input["stored"], registry), moment(input).now.ms)
        val drawn = source.drawn(type.type, id)?.takeIf { it.isVisible }?.let { type.decode(Fields(it)) }
        val stored = source.stored(type.type, id)
        val loaded = SaveDraftLoaded(drawn, stored?.takeIf { it.isVisible }?.let { type.decode(Fields(it)) }, stored?.let { type.decode(Fields(it)) }, recordID(input["anchor"]), moment(input), registry.type(type.type)!!)
        return Json.objectOf("decision" to save.decision(loaded, IDSource(source)).form(type.scope, registry, { it.form }, { it.form }))
    }
    fun script(input: Json): Json = runBlocking { withActionContext { script(input, it) } }
    private fun script(input: Json, context: ActionContext): Json {
        val type = draftable(input.member("t").str())
        val probe = type as ProbeType
        val registry = probeRegistry()
        val at = moment(input)
        val replica = VectorReplica(VectorRecords(input["drawn"], input["stored"], registry), at.now.ms, registry)
        val runner = ActionRunner(replica, registry, at.zone, context)
        var draft: Draft<ProbeEntity>? = null
        val steps = mutableListOf<Json>()
        for (operation in input.member("ops").arr()) {
            val step = linkedMapOf<String, Json>()
            val id = recordID(operation["id"])
            try {
                when (operation.member("op").str()) {
                    "new" -> draft = Draft.new(probe.entity(requireNotNull(id)), placement(operation["placement"]))
                    "open" -> draft = runner.open(type, Id(requireNotNull(id), type))
                    "openOrNew" -> draft = runner.open(type, Id(requireNotNull(id), type), probe.entity(recordID(operation["blank"]) ?: id))
                    "edit" -> draft = requireNotNull(draft).edit { probe.entity(it.id.record, it.fields() + fields(operation["f"])) }
                    "save" -> {
                        var saving = requireNotNull(draft)
                        recordID(operation["as"])?.let { other -> saving = saving.edit { probe.entity(other, it.fields()) } }
                        if (operation["fail"]?.bool() == true) replica.failNextCommit()
                        val before = replica.gestures.size
                        val result = runner.save(saving, type, ProbeRefusals) { draft = it }
                        val form = when (result) {
                            is SaveResult.Saved -> Json.objectOf("saved" to (result.receipt?.gestureId?.let(Json::of) ?: Json.Null))
                            is SaveResult.Refused -> Json.objectOf("refused" to result.refusal.form)
                            is SaveResult.Failed -> Json.objectOf("failed" to Json.of(true))
                        }
                        step["result"] = if (operation["gesture"]?.bool() == true) Json.Obj((form.obj() + ("gesture" to (replica.gestures.getOrNull(before)?.form ?: Json.Null))).toList()) else form
                    }
                    "rebase" -> draft = requireNotNull(draft).rebased(probe.entity(id ?: draft!!.id.record, fields(operation["f"])))
                    "records" -> replica.records = VectorRecords(operation["drawn"], operation["stored"], registry)
                    else -> throw ContractError("unknown script operation")
                }
                step["draft"] = draft?.form ?: Json.Null
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
