import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica
import UIKit

// One headless run (design §10 item 4): a scenario of `Scenarios` driven through the engine's public API with no taps,
// each step recorded with what it found. The run ends by writing its report (the steps, the store as it stands, the
// probe's log and the engine's events, pass or fail) to `-report`, then exits 0 or 1; a run e2e.sh ends by killing the app
// writes its report and waits. e2e.sh and a run talk through empty files in `-signals`.
final class ScenarioRun {
  struct Failed: Error, CustomStringConvertible {
    let description: String
  }

  static let scope = ScopeRef.product("probe")

  let name: String
  let probe: Probe
  let began = ContinuousClock.now
  var steps: [JSON] = []
  var waitsToBeKilled = false

  init(name: String, probe: Probe) {
    self.name = name
    self.probe = probe
  }

  func run() async {
    do {
      guard let scenario = Scenarios.named(name) else { throw Failed(description: "no scenario is named \(name)") }
      try await scenario(self)
      finish(failure: nil)
    } catch {
      finish(failure: "\(error)")
    }
  }

  // Writes the report and ends the process, unless the run waits for e2e.sh to kill it.
  func finish(failure: String?) {
    writeReport(failure: failure)
    guard failure != nil || !waitsToBeKilled else { return }
    exit(failure == nil ? 0 : 1)
  }

  // MARK: Steps

  func note(_ step: String, _ detail: JSON = .null, holds: Bool = true) {
    let elapsed = ContinuousClock.now - began
    let ms = elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000
    steps.append(["at": JSON(ms), "step": .string(step), "holds": .bool(holds), "detail": detail])
  }

  // A claim that does not hold ends the run here.
  func check(_ claim: String, _ holds: Bool, _ detail: JSON = .null) throws {
    note(claim, detail, holds: holds)
    guard holds else { throw Failed(description: "\(claim) does not hold: \(detail.jcsText)") }
  }

  // Looks every 100 ms until `condition` holds; after `limit` the claim fails.
  func waitUntil(_ claim: String, within limit: Duration, _ condition: () throws -> Bool) async throws {
    let deadline = ContinuousClock.now + limit
    while try !condition() {
      guard ContinuousClock.now < deadline else { return try check(claim, false, .string("not within \(limit)")) }
      try await Task.sleep(for: .milliseconds(100))
    }
    note(claim)
  }

  // MARK: Talking to e2e.sh

  func signal(_ name: String) {
    guard let signals = probe.settings.signals else { return }
    try? FileManager.default.createDirectory(at: signals, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: signals.appending(path: name).path, contents: nil)
    note("signalled \(name)")
  }

  func awaitSignal(_ name: String, within limit: Duration) async throws {
    guard let signals = probe.settings.signals else { throw Failed(description: "no -signals directory to wait in") }
    try await waitUntil("e2e.sh signalled \(name)", within: limit) {
      FileManager.default.fileExists(atPath: signals.appending(path: name).path)
    }
  }

  // Signals `name`, then waits for the app to leave. The run takes no background time of its own, so while the app is
  // away only the lifecycle's runs, and the app is suspended when it ends.
  func awaitLeaving(after name: String) async {
    let left = NotificationCenter.default.notifications(named: UIApplication.didEnterBackgroundNotification)
    signal(name)
    for await _ in left { break }
    note("the app left")
  }

  // Waits for the app to come back to the foreground, which e2e.sh does by launching it again.
  func awaitReturn() async {
    for await _ in NotificationCenter.default.notifications(named: UIApplication.willEnterForegroundNotification) { break }
    note("the app came back")
  }

  // The report ends the run: e2e.sh kills the app once it has read it.
  func waitToBeKilled() {
    waitsToBeKilled = true
  }

  // MARK: The engine, as a scenario drives it

  func start() async {
    await probe.engine.start()
    note("the engine started")
  }

  // Signs in with the launch credentials; every signed-out decision due is answered `answer`. Answers the decisions.
  @discardableResult
  func signIn(answering answer: LineageAnswer? = nil) async throws -> [SignedOutDecision] {
    let session = try await probe.signIn()
    note("signed in", .array(session.decisions.map(\.logged)))
    guard !session.isComplete else { return [] }
    guard let answer else { throw Failed(description: "a signed-out decision is due and the scenario answers none") }
    try await session.complete(Dictionary(uniqueKeysWithValues: session.decisions.map { ($0.product, answer) }))
    note("answered \(answer.rawValue)")
    return session.decisions
  }

  @discardableResult
  func commitCard(_ title: String, held: Bool = false) throws -> CommitReceipt {
    let outcome = try probe.engine.commit(Self.scope, Gesture(changes: [.create("card", ["title": .string(title)])], hold: held))
    guard case .committed(let receipt) = outcome else { throw Failed(description: "the card \(title) was refused: \(outcome)") }
    note("committed the card \(title)", ["gestureId": .string(receipt.gestureId), "stamp": .string(receipt.stamp.text),
                                       "releaseAt": receipt.releaseAt.map { JSON($0) } ?? .null])
    return receipt
  }

  // A phone signed in with the launch credentials, its engine started and its first pull complete.
  func signInAndSync() async throws {
    try await signIn()
    await start()
    try await waitForFirstPull()
  }

  func waitForFirstPull() async throws {
    try await waitUntil("the first pull of self/probe is complete", within: .seconds(15)) {
      try probe.engine.read(Self.scope) { try $0.firstPullComplete() }
    }
  }

  // Every outbox entry has its answer, and every answered one is confirmed by a pull or frame: the outbox is empty.
  func waitUntilSettled(within limit: Duration = .seconds(20)) async throws {
    try await waitUntil("every entry is sent, answered and confirmed", within: limit) { try probe.active().outbox.isEmpty }
  }

  // The visible cards, by title.
  func cardTitles() throws -> [String] {
    try probe.engine.read(Self.scope) { try $0.drawn("card") }.compactMap { try? $0.values["title"]?.asString() }.sorted()
  }

  // The active replica's outbox, one state per entry.
  func entryStates() throws -> [String] {
    try probe.active().outbox.map(\.state.rawValue)
  }

  func undoOffers() -> [String] {
    probe.engine.undoOffers.offers.map(\.id)
  }

  // The log's entries of `kind`, from entry `from` on.
  func logged(_ kind: String, from: Int = 0) -> [JSON] {
    probe.log.all.dropFirst(from).filter { $0["kind"] == .string(kind) }
  }

  var logCount: Int { probe.log.all.count }

  // MARK: The report

  func writeReport(failure: String?) {
    guard let path = probe.settings.report else { return }
    var report: JSON.Object = [
      "scenario": .string(name), "passed": .bool(failure == nil), "steps": .array(steps), "log": .array(probe.log.all),
      "events": .array(probe.events.events),
    ]
    report["failure"] = failure.map(JSON.string)
    report["store"] = (try? probe.snapshot().json) ?? .null
    try? FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? Data(JSON.object(report).jcsText.utf8).write(to: path, options: .atomic)
  }
}

extension SignedOutDecision {
  var logged: JSON {
    ["product": .string(product), "counts": .object(JSON.Object(uniqueKeysWithValues: counts.map { ($0.key, JSON($0.value)) }))]
  }
}
