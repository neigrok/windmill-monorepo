import DomainKit
import DomainKitTesting
import JournalDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncReplica
import SyncSchema
import SyncStore
import SyncTesting
import Testing

struct JournalDomainTests {
  static let now: Int64 = 1_790_812_800_000
  static let day = LocalDay(Instant(ms: now), offsetSeconds: 0)

  final class Device {
    let store: Store
    let faults: CommitFaults
    let clock = SimClock(wallMs: JournalDomainTests.now)
    let fork = InMemoryForkGuardStore()
    let tokens = InMemoryTokenStore()
    let connectivity = SwitchedConnectivity()
    let identities = Identities(random: SeededRandomSource(seed: 42))
    var engine: SyncEngine!
    var runner: ActionRunner!
    init() throws {
      let faults = CommitFaults(); self.faults = faults
      store = try Store.inMemory(registry: SyncSchema.registry, crashPoints: faults.crashPoints, commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
      try restart()
    }
    func restart() throws {
      engine = try SyncEngine(config: EngineConfig(appVersion: "1", surface: .ios, drivesLoops: false), store: store,
        transport: ScriptedTransport(), tokens: tokens, forkGuard: fork, clock: clock.engineClock,
        random: SeededRandomSource(seed: 17), connectivity: connectivity)
      runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    }
    var id: String { get throws { try store.read { try $0.activeReplica() } } }
    func outbox() throws -> [OutboxEntry] { let id = try id; return try store.read { try $0.replica(id)!.outbox } }
    func bind() throws { tokens.save(SessionToken("session-A"), for: "A"); _ = try store.signIn(account: "A", holdsRecords: ["journal": true, "gym": false], decisions: ["journal": .add], counted: [:], identities: identities) }
    func pending() throws -> [PendingClaim] { try runner.read(Journal.scope) { try $0.devices(prefix: "pendingClaim:").members.map { try PendingClaim(json: $0.value) } } }
    func push(_ server: inout ModelServer) throws -> (PushRequest, JSON) {
      let request = try #require(store.number(at: clock.nowMs()).value)
      let response = server.push(request.json, credential: .account("A"), at: clock.nowMs())
      return (request, response.json)
    }
    func result(_ request: PushRequest, _ response: JSON) throws {
      var instance = Instance(actor: try Stamp.Actor(ClientSteps.actor), deviceNow: clock.nowMs(), appVersion: "1")
      var steps = PushPlanner(registry: SyncSchema.registry).steps(for: .ok(try PushResponse(json: response.member("body"))), to: request)
      while let step = steps.next(sizes: WriterSlices(.fixed(.init()))) {
        _ = try store.apply(step, replica: id, instance: &instance, timing: .steady(send: clock.nowMs(), recv: clock.nowMs()), identities: identities)
      }
    }
    func pull(_ server: inout ModelServer) throws {
      let id = try id
      let request = try #require(store.pullPlan([Journal.scope], replica: id)?.request)
      let response = server.pull(request.json, credential: .account("A"), at: clock.nowMs())
      var steps = PageApplier(registry: SyncSchema.registry).steps(for: .ok(try PullResponse(json: response.body)), to: request, account: "A")
      var instance = Instance(actor: try Stamp.Actor(ClientSteps.actor), deviceNow: clock.nowMs(), appVersion: "1")
      while let step = steps.next(sizes: WriterSlices(.fixed(.init(chunkRows: .max))), settles: .max) {
        let applied = try store.apply(step, replica: id, account: "A", subscribed: .given([Journal.scope]), instance: &instance,
          timing: .steady(send: clock.nowMs(), recv: clock.nowMs()), identities: identities)
        if applied.value?.unsettled == true { while try store.settle(Journal.scope, replica: id, count: .max).value?.left == true {} }
      }
    }
  }

  @Test func steppedDevicesShareTheClaimResultBinding() throws {
    let first = SteppedEngine(registry: SyncSchema.registry, startMs: Self.now, account: "A",
      rules: ComposedServerRules.windmill(registry: SyncSchema.registry), commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let device = first.device()
    let document = PageDocument(body: "retained here", mood: 0)
    let pending = PendingClaim(day: Self.day, claimId: "claim-device-2", document: document, retirements: [:])
    let command = try ClaimPageCommand(day: Self.day, document: document, claimId: pending.claimId)
    _ = try device.replica.commit(Journal.scope, Gesture(changes: [], command: Command(name: ClaimPageCommand.name, args: .object(JSON.Object(uniqueKeysWithValues: command.args.map { ($0.key, $0.value) }))),
      local: [DeviceWrite(key: pending.key, value: pending.json)]))
    device.sync()
    let recorded = try device.replica.read(Journal.scope) { read in
      let value = try #require(try read.device(pending.key))
      return try PendingClaim(json: value)
    }
    #expect(recorded.latest == document)
    #expect(recorded.result?["epoch"] == "ep-1")
    #expect(recorded.result?["seq"] == 1)
    let runner = ActionRunner(replica: device.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
    #expect(Self.value(try runner.run(ReconcileClaim(day: Self.day, claimId: pending.claimId))) == true)
    #expect(try runner.read(Journal.scope) { try $0.device(pending.key) } == nil)
  }

  static func value<T, R>(_ outcome: DomainKit.Outcome<T, R>) -> T? {
    switch outcome { case .committed(let value, _), .unchanged(let value): value; case .refused: nil }
  }

  static func server() -> ModelServer {
    ModelServer(registry: SyncSchema.registry, rules: ComposedServerRules.windmill(registry: SyncSchema.registry), state: ServerState(epoch: "ep-1", accounts: ["A": "Ann"]))
  }

  @Test func verbatimTextNullableZeroAndHistoricRead() throws {
    let text = "  e\u{301}\n"
    try JournalRules.check(PageDocument(body: text, mood: 0))
    #expect(try JournalRules.body.apply(text, at: "body") as String == text)
    #expect(PageDocument(body: " ").isWritten && PageDocument(energy: 0).isWritten && !PageDocument().isWritten)
    let record = Record(type: Page.type, id: RecordID(Self.day.text), life: nil, born: nil, values: ["mood": .null, "energy": 0, "source": "typed"],
      texts: ["body": TextValue(text: String(repeating: "x", count: 131_073), merged: false, pending: false)], serials: [:], rc: nil, ru: nil, isVisible: true, isPending: false, isHeld: false)
    #expect(try Page(Fields(record)).document.body.utf8.count == 131_073)
  }

  @Test(arguments: [PageDocument(body: "\u{0}"), PageDocument(body: String(repeating: "😀", count: 32_769)), PageDocument(mood: 11), PageDocument(energy: -1), PageDocument(source: "other")])
  func invalidSnapshotsAreRefusedWithoutWrites(_ document: PageDocument) throws {
    let d = try Device()
    let result = try d.runner.run(SavePage(day: Self.day, document: document))
    #expect(result.refusal != nil)
    #expect(try d.pending().isEmpty)
  }

  @Test func onlyTodayCanBeEdited() throws {
    let d = try Device()
    #expect(try d.runner.run(SavePage(day: Self.day.adding(days: -1), document: PageDocument(body: "old"))).refusal != nil)
    #expect(try d.pending().isEmpty)
  }

  @Test(arguments: ["anonymous", "bound", "pending"])
  func aFailedSaveKeepsTheEditorDraftAndOnlyACommittedSaveClearsIt(_ mode: String) throws {
    let d = try Device()
    if mode == "pending" { _ = try d.runner.run(SavePage(day: Self.day, document: PageDocument(body: "first"))) }
    if mode != "anonymous" { try d.bind() }
    let document = PageDocument(body: "new words", mood: 0)
    _ = try d.runner.run(PreserveEditorDraft(day: Self.day, document: document))
    let before = try d.runner.read(Journal.scope) { try $0.devices(prefix: "pendingClaim:") }
    let clock = try d.runner.read(Journal.scope) { try $0.device("contentClock") }
    d.faults.failNextCommit()
    #expect(throws: CommitFailure.self) { try d.runner.run(SavePage(day: Self.day, document: document)) }
    #expect(try d.runner.read(Journal.scope) { try $0.devices(prefix: "pendingClaim:") } == before)
    #expect(try d.runner.read(Journal.scope) { try $0.device("contentClock") } == clock)
    _ = try d.runner.run(SavePage(day: Self.day, document: document))
    #expect(try d.runner.read(Journal.scope) { try $0.device(EditorDraft.key) } == nil)
    #expect(try d.runner.read(Journal.scope) { try JournalRoom($0).days.first?.document } == document)
  }

  @Test func anonymousSnapshotsCoalesceWithCumulativeStateAndClockRollback() throws {
    let d = try Device()
    let first = try d.runner.run(SavePage(day: Self.day, document: PageDocument(body: "first")))
    let second = try d.runner.run(SavePage(day: Self.day, document: PageDocument(body: "latest", mood: 0)))
    let pending = try #require(d.pending().first)
    #expect(pending.latest == PageDocument(body: "latest", mood: 0))
    #expect(pending.retirements == ["placeholder": "retired", "privacyLine": "retired", "firstPage": "retired", "scales": "retired"])
    if case .committed(_, let receipt) = second, case .committed(_, let old) = first { #expect(receipt.superseded == [old.gestureId]) }
    else { Issue.record("both snapshots must commit") }
    let outbox = try d.outbox()
    #expect(outbox.count == 1 && outbox[0].intent.command?.name == Journal.Commands.claimPage)
    try d.restart()
    #expect(try d.pending().first?.latest == pending.latest)
    #expect(try d.runner.read(Journal.scope) { try $0.device("contentClock") } == nil)
  }

  @Test(arguments: [false, true])
  func delayedClaimRetainsEditsThroughRestartBothResponseOrdersAndFailedSave(_ pullFirst: Bool) throws {
    let d = try Device()
    var server = Self.server()
    let first = try d.runner.run(SavePage(day: Self.day, document: PageDocument(body: "first")))
    let claimId = try #require(Self.value(first) ?? nil)
    try d.bind()
    let request = try #require(d.store.number(at: Self.now).value)
    _ = try d.runner.run(SavePage(day: Self.day, document: PageDocument(body: "new words", mood: 0)))
    #expect(try d.outbox().count == 1)
    #expect(Self.value(try d.runner.run(ReconcileClaim(day: Self.day, claimId: claimId))) == false)
    try d.restart()
    #expect(try d.pending().first?.latest == PageDocument(body: "new words", mood: 0))
    d.clock.advance(ms: 100_000)
    let response = server.push(request.json, credential: .account("A"), at: d.clock.nowMs()).json
    if pullFirst { try d.pull(&server) }
    try d.result(request, response)
    if !pullFirst { #expect(Self.value(try d.runner.run(ReconcileClaim(day: Self.day, claimId: claimId))) == false); try d.pull(&server) }
    #expect(try d.pending().first?.result?["seq"] != nil)
    try d.restart()
    let before = try d.pending().first?.json
    let claimStamp = try d.runner.read(Journal.scope) { try $0.confirmed(Page.self, ID(Self.day))?.values["documentStamp"] }
    d.faults.failNextCommit()
    #expect(throws: CommitFailure.self) { try d.runner.run(ReconcileClaim(day: Self.day, claimId: claimId)) }
    #expect(try d.pending().first?.json == before)
    #expect(try d.runner.read(Journal.scope) { try $0.device("contentClock") } == nil)
    #expect(Self.value(try d.runner.run(ReconcileClaim(day: Self.day, claimId: claimId))) == true)
    #expect(try d.pending().isEmpty)
    let save = try d.outbox().first!.intent.command!
    #expect(ContentClock.compare(save.args["stamp"]!, try #require(claimStamp)) > 0)
    #expect(save.args["body"] == "new words" && save.args["mood"] == 0)
    #expect(try d.runner.read(Journal.scope) { try JournalRoom($0).days.first?.backup } == .pending)
    let (saveRequest, saveResponse) = try d.push(&server)
    try d.result(saveRequest, saveResponse); try d.pull(&server)
    #expect(try d.runner.read(Journal.scope) { try JournalRoom($0).days.first?.backup } == .backedUp)
    #expect(try d.runner.read(Journal.scope) { try $0.repository(Page.self).all(in: .drawn).first?.document } == PageDocument(body: "new words", mood: 0))
  }

  @Test func reconciliationBodyKeepsAccountPrefixAndConcurrentRewrite() {
    #expect(JournalWriting.reconcileBody("account\n\nfirst", base: "first", latest: "new") == "account\n\nnew")
    #expect(JournalWriting.reconcileBody("account\n\nfirst", base: "first", latest: "") == "account")
    #expect(JournalWriting.reconcileBody("rewritten", base: "first", latest: "new") == "rewritten\n\nnew")
    #expect(JournalWriting.claimBody(" \u{feff}", "e\u{301}") == "e\u{301}")
  }

  @Test(arguments: [false, true])
  func signOutKeepPreservesDelayedClaimEditsBeforeAndAfterTheResult(_ answered: Bool) async throws {
    let d = try Device()
    var server = Self.server()
    let first = try d.runner.run(SavePage(day: Self.day, document: PageDocument(body: "First words.")))
    let claimId = try #require(Self.value(first) ?? nil)
    try d.bind()
    let request = try #require(d.store.number(at: Self.now).value)
    let latest = PageDocument(body: "First words. New signed-in words.", mood: 0)
    _ = try d.runner.run(SavePage(day: Self.day, document: latest))
    _ = try d.runner.run(RetireJournalInvitation("scales"))
    if answered {
      d.clock.advance(ms: 100_000)
      let response = server.push(request.json, credential: .account("A"), at: d.clock.nowMs()).json
      try d.result(request, response); try d.pull(&server)
      #expect(try d.outbox().isEmpty)
    }
    let retained = try #require(d.pending().first?.json)
    d.connectivity.set(online: false)
    let session = try await d.engine.signOut()
    #expect(session.pending == 1 && session.unsent == (answered ? 1 : 2))
    try await session.finish(.keep)
    #expect(try d.pending().isEmpty)
    try d.restart(); try d.bind()
    #expect(try d.pending().first?.json == retained)
    if !answered {
      d.clock.advance(ms: 100_000)
      let (retry, response) = try d.push(&server)
      try d.result(retry, response)
    }
    try d.pull(&server)
    #expect(Self.value(try d.runner.run(ReconcileClaim(day: Self.day, claimId: claimId))) == true)
    #expect(try d.pending().isEmpty)
    #expect(try d.outbox().first?.intent.command?.args["body"] == .string(latest.body))
    let (save, response) = try d.push(&server)
    try d.result(save, response); try d.pull(&server)
    #expect(try d.runner.read(Journal.scope) { try $0.repository(Page.self).all(in: .drawn).first?.document } == latest)
  }

  @Test func signOutDiscardPurgesPendingClaimsAndTheirEdits() async throws {
    let d = try Device()
    _ = try d.runner.run(SavePage(day: Self.day, document: PageDocument(body: "First words.")))
    try d.bind()
    _ = try #require(d.store.number(at: Self.now).value)
    _ = try d.runner.run(SavePage(day: Self.day, document: PageDocument(body: "First words. New signed-in words.")))
    d.connectivity.set(online: false)
    let session = try await d.engine.signOut()
    #expect(session.pending == 1 && session.unsent == 2)
    try await session.finish(.discard)
    try d.restart(); try d.bind()
    #expect(try d.pending().isEmpty)
    #expect(try d.outbox().isEmpty)
    #expect(try d.engine.dormantReplicas().isEmpty)
  }

  @Test func signOutCountsInvitationOnlyPendingWorkAndExcludesTheContentClock() async throws {
    let d = try Device()
    _ = try d.runner.run(SavePage(day: Self.day, document: PageDocument(body: "")))
    try d.bind()
    d.connectivity.set(online: false)
    let untouched = try await d.engine.signOut()
    #expect(untouched.pending == 0 && untouched.unsent == 1)
    await untouched.cancel()
    _ = try d.runner.run(RetireJournalInvitation("scales"))
    #expect(try d.pending().first?.touched == [])
    #expect(try d.pending().first?.retirements == ["scales": "retired"])
    let invitation = try await d.engine.signOut()
    #expect(invitation.pending == 1 && invitation.unsent == 2)
    await invitation.cancel()
    _ = try d.engine.commit(Journal.scope, Gesture(changes: [], local: [DeviceWrite(key: "contentClock", value: ["ms": JSON(Self.now), "counter": 0])]))
    let clock = try await d.engine.signOut()
    #expect(clock.pending == 1 && clock.unsent == 2)
    try await clock.finish(.keep)
    try d.bind()
    #expect(try d.runner.read(Journal.scope) { try $0.device("contentClock") } == ["ms": JSON(Self.now), "counter": 0])
  }

  @Test func defaultsAndMonotoneInvitationDismissal() throws {
    let d = try Device()
    _ = try d.runner.run(RetireJournalInvitation("placeholder"))
    _ = try d.runner.run(SavePage(day: Self.day, document: PageDocument(body: "first")))
    _ = try d.runner.run(RetireJournalInvitation("scales"))
    let room = try d.runner.read(Journal.scope) { try JournalRoom($0) }
    #expect(room.state.placeholder == "retired" && room.state.firstPage == "retired" && room.state.scales == "retired")
    #expect(room.keepDue && !room.scaleInvitationDue)
  }
}
