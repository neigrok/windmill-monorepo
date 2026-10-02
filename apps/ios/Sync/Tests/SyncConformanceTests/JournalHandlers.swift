import SyncAPI
import SyncCore
import SyncModelServer
import SyncReplica
import SyncTesting

// These transcripts drive the production planners and model server, preserving every intermediate durable snapshot.
enum JournalHandlers {
  static let registry = ServerHandlers.journal
  static let scope = ScopeRef.product("journal")

  static func client(_ input: JSON) throws -> JSON {
    var answer = try ClientSteps.run(input, registry: registry) { PlannedDevice($0, registry: registry, limits: $1) }.asObject()
    answer["events"] = answer["events"] ?? []
    answer["telemetry"] = answer["telemetry"] ?? []
    let steps = try input.member("steps").asArray(), returns = try answer.member("returns").asArray()
    if let index = steps.indices.last, steps[index]["op"] == "push", !returns[index].isNull {
      var server = ModelServer(registry: registry, rules: JournalServerRules(), state: try ServerState(json: input.member("server")))
      let reply = server.push(returns[index], credential: .account("A"), at: try input.member("serverNow").asInteger())
      answer["server"] = server.state.json
      answer["response"] = reply.json
    }
    return .object(answer)
  }

  static let resultWrites: CommandResultDeviceWrites = { command, result, epoch, rows in
    guard command.name == "journal.claimPage", let id = try? command.args.member("claimId").asString(),
          var pending = try? rows["pendingClaim:\(id)"]?.asObject() else { return [] }
    switch result.verdict {
    case .ok(let seq, _): pending["claimResult"] = ["seq": JSON(seq), "epoch": .string(epoch)]
    case .refused(let code) where code != .clockSkew && code != .baseUnknown: pending["refusal"] = code.json
    case .refused: break
    }
    return [DeviceWrite(key: "pendingClaim:\(id)", value: .object(pending))]
  }

  static let pendingWork: PendingDeviceWork = { product, rows in
    guard product == "journal" else { return [] }
    return rows.members.compactMap { key, value in
      guard key.hasPrefix("pendingClaim:"), let pending = try? value.asObject() else { return nil }
      let touched = (try? pending["touched"]?.asArray().count) ?? 0
      let retirements = (try? pending["retirements"]?.asObject().members.count) ?? 0
      return touched > 0 || retirements > 0 ? key : nil
    }
  }

  static func prediction(_ args: JSON.Object, full: Bool = true) -> [Change] {
    [.write("page", RecordID(try! args.member("day").asString()),
      full ? Dictionary(uniqueKeysWithValues: ["mood", "energy", "source"].map { ($0, args[$0]!) }) : [:],
      texts: ["body": TextEdit(text: try! args.member("body").asString())])]
  }

  static func claimEdit(_ input: JSON) throws -> JSON {
    let now = try input.member("now").asInteger(), day = try input.member("day").asString()
    let claim = try input.member("claim").asObject(), edit = try input.member("edit").asObject()
    let claimId = try claim.member("claimId").asString(), pendingKey = "pendingClaim:\(claimId)"
    let claimAt = try input.member("claimAt").asInteger(), editAt = try input.member("editAt").asInteger(), saveAt = try input.member("saveAt").asInteger()
    let eager = input["strategy"] == "eager"
    let skewMs = try input["skewMs"]?.asInteger() ?? 0
    let identities = try QueuedIdentities(["ids": ["rp_00000000000000000000000000000002"], "actors": [.string(ClientSteps.actor)]])
    var instance = Instance(actor: try Stamp.Actor(ClientSteps.actor), deviceNow: now, appVersion: "1")
    var device = PlannedDevice(LoadedDevice(meta: DeviceMeta(), active: try input.member("replica").asString(), replicas: [.fresh(ReplicaMeta(replica: try input.member("replica").asString(), state: .anon))]), registry: registry, limits: Limits(), commandResultWrites: resultWrites, pendingDeviceWork: pendingWork)
    var server = ModelServer(registry: registry, rules: JournalServerRules(), state: try ServerState(json: input.member("server")))
    var trace: [JSON] = []
    func snapshot(_ op: String, _ value: JSON = .null) throws { trace.append(["op": .string(op), "value": value, "device": try device.dump()]) }
    func commit(_ gesture: Gesture, at: Int64) throws -> JSON {
      instance.deviceNow = now + at + skewMs
      return ClientSteps.json(try device.commit(gesture, in: scope, instance: instance, identities: identities)!)
    }
    func restart() throws {
      device = PlannedDevice(try LoadedDevice(json: device.dump(), registry: registry), registry: registry, limits: Limits(), commandResultWrites: resultWrites, pendingDeviceWork: pendingWork)
    }
    func pushResult(_ response: JSON, request: PushRequest, at: Int64) throws {
      instance.deviceNow = now + at + skewMs
      var steps = PushPlanner(registry: registry).steps(for: .ok(try PushResponse(json: response.member("body"))), to: request)
      while let step = steps.next(sizes: WriterSlices(.fixed(.init(chunkRows: .max)))) { try device.apply(step, instance: &instance, timing: .steady(send: now + at + skewMs, recv: now + at + skewMs), identities: identities) }
    }
    func pull(at: Int64) throws {
      instance.deviceNow = now + at + skewMs
      let request = try device.pullRequest([scope])!
      let response = server.pull(request.json, credential: .account("A"), at: now + at)
      let planner = PageApplier(registry: registry)
      var steps = planner.steps(for: .ok(try PullResponse(json: response.body)), to: request, account: "A")
      var outcomes: [JSON] = []
      while let step = steps.next(sizes: WriterSlices(.fixed(.init(chunkRows: .max))), settles: .max) {
        let result = try device.apply(step, subscribed: [scope], instance: &instance, timing: .steady(send: now + at + skewMs, recv: now + at + skewMs), identities: identities)
        if let outcome = result.outcome, case .page(let page, _, _) = step { outcomes.append(["scope": page.scope.json, "outcome": .string(outcome.rawValue)]) }
        if result.unsettled { while try device.settle(scope, count: .max) {} }
      }
      try snapshot("pull", .array(outcomes))
    }
    func leaveAndReturn(_ choice: SignOutChoice, at: Int64) throws {
      try snapshot("signOutQuestion", ClientSteps.json(device.signOut(choice: nil, counted: nil, identities: identities)))
      try snapshot("signOut", ClientSteps.json(device.signOut(choice: choice, counted: nil, identities: identities)))
      try restart(); try snapshot("signedOutRestart")
      if choice == .keep {
        try snapshot("signIn", ClientSteps.json(device.signIn(account: "A", holdsRecords: ["journal": input["occupied"] == true],
          decisions: [:], counted: [:], identities: identities)))
      }
    }
    func reconcile(at: Int64, fail: Bool = false) throws -> JSON {
      let replica = try device.activeReplica()
      guard var pending = try replica.deviceRows["journal"]?[pendingKey]?.asObject(), pending["refusal"]?.isNull != false,
            let result = pending["claimResult"], !result.isNull else { return .null }
      let resultEpoch = try result.member("epoch").asString()
      if let epoch = replica.meta.serverEpoch, epoch != resultEpoch {
        let outstanding = replica.outbox.contains { $0.intent.command?.args["claimId"] == .string(claimId) }
        pending["claimResult"] = .null
        return try commit(Gesture(changes: [], command: outstanding ? nil : Command(name: "journal.claimPage", args: .object(claim)), local: [DeviceWrite(key: pendingKey, value: .object(pending))]), at: at)
      }
      guard replica.meta.serverEpoch == resultEpoch, let cursor = replica.cursor(scope), let seq = cursor.cleanSeq,
            seq >= (try result.member("seq").asInteger()), replica.staging[scope] == nil,
            let row = replica.rows(scope).row(RecordKey("page", RecordID(day))) else { return .null }
      let retirements = try pending.member("retirements").asObject()
      let changes: [Change] = retirements.isEmpty ? [] : [.write("journalState", "journalState", Dictionary(uniqueKeysWithValues: retirements.members))]
      let touched = try pending.member("touched").asArray().map { try $0.asString() }
      if touched.isEmpty { return try commit(Gesture(changes: changes, local: [DeviceWrite(key: pendingKey, value: nil)]), at: at) }
      let latest = try pending.member("latest").asObject(), base = try pending.member("base").asObject()
      var document = JSON.Object()
      let joined = row.texts["body"]!.text
      let old = try base.member("body").asString(), new = try latest.member("body").asString()
      var body = joined
      if touched.contains("body") {
        let suffix = "\n\n" + trimStart(old)
        if joined.utf8.elementsEqual(old.utf8) { body = new }
        else if !trim(old).isEmpty && joined.utf8.suffix(suffix.utf8.count).elementsEqual(suffix.utf8) {
          body = JournalServerRules.claimBody(String(decoding: joined.utf8.dropLast(suffix.utf8.count), as: UTF8.self), new)
        } else { body = JournalServerRules.claimBody(joined, new) }
      }
      document["day"] = .string(day); document["body"] = .string(body)
      for field in ["mood", "energy", "source"] { document[field] = touched.contains(field) ? latest[field]! : row.lattice.fields[field]!.value }
      let stamp = try ContentClock.next(pair: replica.deviceRows["journal"]?["contentClock"], observed: row.lattice.fields["documentStamp"]!.value, now: replica.meta.physNow(deviceNow: now + at + skewMs), actor: instance.actor.text)
      document["stamp"] = stamp
      let gesture = Gesture(changes: changes, command: Command(name: "journal.savePage", args: .object(document)), predict: prediction(document), local: [DeviceWrite(key: pendingKey, value: nil), DeviceWrite(key: "contentClock", value: ContentClock.pair(stamp))])
      if fail {
        var loaded = replica
        instance.deviceNow = now + at + skewMs
        let limits = Limits(pushMaxBytes: 1)
        let outcome = try CommitPlanner(registry: registry, limits: limits).commit(gesture, in: scope, to: &loaded, as: instance, identities: identities, gestureIdTaken: false)
        // The failed local commit retains the original durable device, including the pending draft.
        device = PlannedDevice(try LoadedDevice(json: replacingActive(loaded, in: device.dump()), registry: registry), registry: registry, limits: Limits(), commandResultWrites: resultWrites, pendingDeviceWork: pendingWork)
        return ClientSteps.json(outcome)
      }
      return try commit(gesture, at: at)
    }
    let base = JSON.Object(uniqueKeysWithValues: ["body", "mood", "energy", "source"].map { ($0, claim[$0]!) })
    let pending: JSON = ["day": .string(day), "claimId": .string(claimId), "base": .object(base), "latest": .object(base), "touched": [], "retirements": [:], "claimResult": .null, "refusal": .null]
    let claimChanges: [Change] = skewMs == 0 ? [] : [.write("journalState", "journalState", ["firstPage": "retired"])]
    var initialPending = try pending.asObject()
    if skewMs != 0 { initialPending["retirements"] = ["firstPage": "retired"] }
    try snapshot("claimCommit", commit(Gesture(changes: claimChanges, command: Command(name: "journal.claimPage", args: .object(claim)), predict: prediction(claim, full: !eager), local: eager ? [] : [DeviceWrite(key: pendingKey, value: .object(initialPending))]), at: 0))
    _ = try device.signIn(account: "A", holdsRecords: ["journal": try input.member("occupied").asBool()], decisions: input["occupied"] == true ? ["journal": .add] : [:], counted: [:], identities: identities)
    var request = try device.push(limit: nil, at: now + 2 + skewMs)!
    try snapshot("claimSent", request.json)
    if eager {
      var args = claim; args["claimId"] = nil
      for (name, value) in edit.members { args[name] = value }
      let stamp = try ContentClock.next(now: now + editAt, actor: instance.actor.text); args["stamp"] = stamp
      try snapshot("editCommit", commit(Gesture(changes: [], command: Command(name: "journal.savePage", args: .object(args)), predict: prediction(args, full: false), local: [DeviceWrite(key: "contentClock", value: ContentClock.pair(stamp))]), at: editAt))
    } else {
      var pending = initialPending, latest = base
      for (name, value) in edit.members { latest[name] = value }
      pending["latest"] = .object(latest); pending["touched"] = .array(["body", "mood", "energy", "source"].filter { edit[$0] != nil }.map(JSON.string))
      let retirements = try (input["retirements"] ?? [:]).asObject()
      var retained = try pending.member("retirements").asObject()
      for (key, value) in retirements.members { retained[key] = value }
      pending["retirements"] = .object(retained)
      try snapshot("editCommit", commit(Gesture(changes: [], local: [DeviceWrite(key: pendingKey, value: .object(pending))]), at: editAt))
      try snapshot("beforeConfirmation", reconcile(at: editAt))
    }
    if input["restart"] == true { try restart(); try snapshot("restart") }
    if let choice = input["signOut"].flatMap({ try? $0.asString() }).flatMap(SignOutChoice.init(rawValue:)) {
      try leaveAndReturn(choice, at: editAt + 1)
      if choice == .discard { return ["trace": .array(trace), "device": try device.dump(), "server": server.state.json,
        "claimResponse": .null, "saveRequest": .null, "saveResponse": .null, "pending": .null] }
      request = try device.push(limit: nil, at: now + editAt + 2 + skewMs)!
      try snapshot("claimRetriedAfterSignIn", request.json)
    }
    var response = server.push(request.json, credential: .account("A"), at: now + claimAt).json
    if skewMs != 0 {
      try pushResult(response, request: request, at: claimAt); try snapshot("skewResult", response); try restart()
      request = try device.push(limit: nil, at: now + claimAt + 1 + skewMs)!
      try snapshot("skewRetry", request.json)
      response = server.push(request.json, credential: .account("A"), at: now + claimAt + 1).json
    }
    if input["pullFirst"] == true { try pull(at: claimAt + 1); try snapshot("pullBeforeResult", reconcile(at: claimAt + 1)); try restart() }
    try pushResult(response, request: request, at: claimAt + 2)
    try snapshot("claimResult", response)
    if input["pullFirst"] != true {
      if !eager { try snapshot("resultBeforePull", reconcile(at: claimAt + 2)) }
      try pull(at: claimAt + 2)
    }
    if input["restart"] == true { try restart() }
    if input["signOutAfterResult"] == true {
      try leaveAndReturn(.keep, at: saveAt - 2)
      try pull(at: saveAt - 1)
    }
    if input["epochChange"] == true {
      var state = server.state; state.epoch = "ep-2"; server.restore(state)
      try device.changeEpoch(to: "ep-2", instance: &instance, identities: identities)
      try snapshot("epochReplayCommit", reconcile(at: saveAt)); try restart()
      let replay = try device.push(limit: nil, at: now + saveAt + skewMs)!
      let response = server.push(replay.json, credential: .account("A"), at: now + saveAt).json
      try pushResult(response, request: replay, at: saveAt); try snapshot("epochReplayResult", response); try pull(at: saveAt)
    }
    if !eager {
      if input["failCommit"] == true { try snapshot("failedReconciliation", reconcile(at: saveAt, fail: true)); try restart() }
      try snapshot("reconcile", reconcile(at: saveAt))
    }
    let saveRequest = try device.push(limit: nil, at: now + saveAt + skewMs)
    var saveResponse: JSON = .null
    if let saveRequest {
      saveResponse = server.push(saveRequest.json, credential: .account("A"), at: now + saveAt).json
      try pushResult(saveResponse, request: saveRequest, at: saveAt); try snapshot("saveResult", saveResponse); try pull(at: saveAt + 1)
    }
    return ["trace": .array(trace), "device": try device.dump(), "server": server.state.json, "claimResponse": response,
      "saveRequest": saveRequest?.json ?? .null, "saveResponse": saveResponse, "pending": try device.activeReplica().deviceRows["journal"]?[pendingKey] ?? .null]
  }

  static func replacingActive(_ replica: LoadedReplica, in json: JSON) throws -> JSON {
    var device = try json.asObject()
    device["replicas"] = .array(try device.member("replicas").asArray().map { $0["meta"]?["replica"] == .string(replica.id) ? replica.json : $0 })
    return .object(device)
  }

  static func trimStart(_ text: String) -> String { String(String.UnicodeScalarView(text.unicodeScalars.drop(while: TextMerge.isWhitespace))) }
  static func trim(_ text: String) -> String { var scalars = Array(trimStart(text).unicodeScalars); while let last = scalars.last, TextMerge.isWhitespace(last) { scalars.removeLast() }; return String(String.UnicodeScalarView(scalars)) }
}
