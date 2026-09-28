import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica

// The scenarios only an end-to-end run can prove (design §10 item 5), each as the steps one launch takes. A scenario that
// spans launches or phones has one entry per launch, `<scenario>/<phase>`, and e2e.sh runs them in order around what
// only the simulator or the server can do: leave the app, kill it, copy its container, revoke a session, regenerate the
// epoch. Each works under an account of its own, so what the server holds afterwards is the scenario's alone.
enum Scenarios {
  static func named(_ name: String) -> ((ScenarioRun) async throws -> Void)? {
    switch name {
    case "leave-flush": leaveFlush
    case "relaunch-release/commit": relaunchCommit
    case "relaunch-release/check": relaunchCheck
    case "live/watch": liveWatch
    case "live/commit": liveCommit
    case "fork-guard/origin": forkOrigin
    case "fork-guard/clone": forkClone
    case "fork-guard/origin-again": forkOriginAgain
    case "reauth/pause": reauthPause
    case "reauth/resume": reauthResume
    case "revoked-pull/pause": revokedPullPause
    case "revoked-pull/resume": revokedPullResume
    case "clock-skew": clockSkew
    case "clock-jump/before": clockJumpBefore
    case "clock-jump/after": clockJumpAfter
    case "epoch-change": epochChange
    case "lineage/seed": lineageSeed
    case "lineage/add": lineageAdd
    case "lineage/discard": lineageDiscard
    case "launch-arguments": launchArguments
    default: nil
    }
  }

  // MARK: Leave flush

  // A held commit, then e2e.sh opens another app and later brings this one back. Leaving releases the hold at once, and
  // the flush pushes the card inside the lifecycle's background time, the only time the app has while away, long before
  // its release time; Undo is not offered after leaving.
  static func leaveFlush(_ run: ScenarioRun) async throws {
    try await run.signInAndSync()
    let receipt = try run.commitCard("Leave", held: true)
    try await run.waitUntil("Undo is offered for the card", within: .seconds(2)) { run.undoOffers() == [receipt.gestureId] }
    let stayed = run.logCount
    await run.awaitLeaving(after: "committed")
    await run.awaitReturn()
    try await run.waitUntil("the leave's background time was handed back", within: .seconds(10)) {
      !run.logged("background-end", from: stayed).isEmpty
    }
    let away = run.probe.log.all.dropFirst(stayed)
    let lease = away.first { $0["kind"] == "background-begin" && $0["name"] == "windmill.sync.leave" }
    let push = away.first { $0["kind"] == "push" && $0["status"] == 200 }
    let ended = away.first { $0["kind"] == "background-end" }
    try run.check("the card was pushed inside the leave's background time", at(lease) <= at(push) && at(push) <= at(ended) && push != nil,
                  .array(Array(away)))
    try run.check("it was answered before its release time", at(push) < receipt.releaseAt ?? 0)
    try run.check("it is answered", try !run.entryStates().contains { $0 != "acked" })
    try await run.waitUntil("Undo is not offered after leaving", within: .seconds(2)) { run.undoOffers().isEmpty }
  }

  // When a log entry happened, on the wall clock.
  static func at(_ entry: JSON?) -> Int64 {
    entry.flatMap { try? $0.member("at").asInteger() } ?? 0
  }

  // MARK: Relaunch release

  // A held commit, then e2e.sh terminates the app while it is held.
  static func relaunchCommit(_ run: ScenarioRun) async throws {
    try await run.signInAndSync()
    try run.commitCard("Relaunch", held: true)
    try run.check("the card is held", try run.entryStates() == ["held"])
    run.waitToBeKilled()
  }

  // Launched with no token: engine start released the hold before the first frame, with no Undo shown, and the start
  // sends it under the token the Keychain kept, the only one left there.
  static func relaunchCheck(_ run: ScenarioRun) async throws {
    let account = try run.probe.boundAccount() ?? ""
    try run.check("the Keychain kept the account's token and no other", run.probe.tokens.accounts() == [account] && run.probe.tokens.token(for: account) != nil,
                  .array(run.probe.tokens.accounts().map(JSON.string)))
    try run.check("engine start released the hold", try run.entryStates() == ["ready"], .array(try run.entryStates().map(JSON.string)))
    try run.check("no Undo is offered", run.undoOffers().isEmpty)
    await run.start()
    try await run.waitUntilSettled()
    try run.check("the card is drawn", try run.cardTitles() == ["Relaunch"])
  }

  // MARK: Live convergence

  // The watching phone: signed in and following self/probe live, it tells e2e.sh, then waits for the card the other
  // phone commits. The card arrives in a change frame carrying its row, and nothing is pulled after the watch began.
  static func liveWatch(_ run: ScenarioRun) async throws {
    try await run.signInAndSync()
    try await run.waitUntil("the live socket follows self/probe", within: .seconds(10)) {
      run.logged("live-send").contains { $0["op"] == "sub" && $0["scopes"] == ["self/probe"] }
    }
    let watched = run.logCount
    run.signal("watching")
    try await run.waitUntil("the other phone's card is drawn", within: .seconds(30)) { try run.cardTitles() == ["Live"] }
    let frames = run.logged("live-frame", from: watched).filter { $0["op"] == "change" }
    try run.check("a change frame carried the card's row", frames.contains { ($0["ids"].flatMap { try? $0.asArray() } ?? []).count == 1 },
                  .array(frames))
    try run.check("nothing was pulled after the watch began", run.logged("pull", from: watched).isEmpty, .array(run.logged("pull", from: watched)))
  }

  // The committing phone, the same account.
  static func liveCommit(_ run: ScenarioRun) async throws {
    try await run.signInAndSync()
    try run.commitCard("Live")
    try await run.waitUntilSettled()
  }

  // MARK: Fork guard

  // The phone whose container e2e.sh then copies to another, without the fork guard's copy.
  static func forkOrigin(_ run: ScenarioRun) async throws {
    try await run.signInAndSync()
    try run.commitCard("Origin")
    try await run.waitUntilSettled()
    run.note("the replica", .string(try run.probe.active().meta.replica))
  }

  // The copy, launched with a token of its own: engine start found no fork-guard copy and re-identified, and the launch
  // token cleared the pause a missing token set. Its pushes are its own replica's, and none is refused as forked.
  static func forkClone(_ run: ScenarioRun) async throws {
    let meta = try run.probe.active().meta
    try run.check("the copy is bound and not paused", meta.state == .bound && !meta.authPaused, meta.json)
    run.note("the replica", .string(meta.replica))
    await run.start()
    try await run.waitForFirstPull()
    try run.commitCard("Clone")
    try await run.waitUntilSettled()
    try run.check("no push was refused as forked", run.logged("push").allSatisfy { $0["status"] == 200 }, .array(run.logged("push")))
    try run.check("both phones' cards are drawn", try run.cardTitles() == ["Clone", "Origin"])
  }

  // The original phone again: it keeps its replica and pushes as it did.
  static func forkOriginAgain(_ run: ScenarioRun) async throws {
    run.note("the replica", .string(try run.probe.active().meta.replica))
    await run.start()
    try await run.waitForFirstPull()
    try run.commitCard("Again")
    try await run.waitUntilSettled()
    try run.check("no push was refused as forked", run.logged("push").allSatisfy { $0["status"] == 200 }, .array(run.logged("push")))
    try run.check("every card is drawn", try run.cardTitles() == ["Again", "Clone", "Origin"])
  }

  // MARK: 401 and re-authentication

  // Synced, then e2e.sh revokes the session: the next push answers 401, the replica pauses and the status says so.
  static func reauthPause(_ run: ScenarioRun) async throws {
    try await syncThenRevoke(run)
    let revoked = run.logCount
    try run.commitCard("After")
    try await run.waitUntil("the replica is paused", within: .seconds(10)) { try run.probe.active().meta.authPaused }
    try run.check("the push answered 401", run.logged("push", from: revoked).map { $0["status"] } == [401], .array(run.logged("push", from: revoked)))
    try await run.waitUntil("the status asks to re-authenticate", within: .seconds(2)) { run.probe.engine.status.authPaused }
    try run.check("the card waits unsent", try run.entryStates().allSatisfy { $0 == "ready" || $0 == "sent" })
  }

  // Launched with a new token for the account: the pause is cleared and the card waiting goes.
  static func reauthResume(_ run: ScenarioRun) async throws {
    try await resume(run)
    try run.check("both cards are drawn", try run.cardTitles() == ["After", "Before"])
  }

  // Synced, then e2e.sh revokes the session while the app is away. Coming back pulls under the revoked token, which the
  // server answers as it answers no one; the phone keeps the account's rows, forgets no scope, and pauses. Found by this
  // run: the phone used to erase the account's rows for good.
  static func revokedPullPause(_ run: ScenarioRun) async throws {
    try await syncThenRevoke(run)
    let revoked = run.logCount
    run.probe.engine.foreground()
    try await run.waitUntil("the replica is paused", within: .seconds(10)) { try run.probe.active().meta.authPaused }
    let pulls = run.logged("pull", from: revoked)
    try run.check("coming back pulled self/probe, answered as no one's",
                  pulls.first?["pages"] == [["scope": "self/probe", "kind": "not-found"]] && run.logged("push", from: revoked).isEmpty, .array(pulls))
    try run.check("the phone still draws its card", try run.cardTitles() == ["Before"])
    try run.check("and knows no scope gone or not found", try run.probe.active().known.isEmpty)
  }

  // Launched with a new token: the pause is cleared, the product is pulled again from where it stood, and the card stays.
  static func revokedPullResume(_ run: ScenarioRun) async throws {
    try await resume(run)
    try run.check("the card is drawn", try run.cardTitles() == ["Before"])
  }

  static func syncThenRevoke(_ run: ScenarioRun) async throws {
    try await run.signInAndSync()
    try run.commitCard("Before")
    try await run.waitUntilSettled()
    run.signal("synced")
    try await run.awaitSignal("revoked", within: .seconds(30))
  }

  static func resume(_ run: ScenarioRun) async throws {
    try run.check("the launch token cleared the pause", try !run.probe.active().meta.authPaused)
    await run.start()
    try await run.waitForFirstPull()
    try await run.waitUntilSettled()
  }

  // MARK: Clocks

  // The device clock jumps 10 minutes ahead while the app runs: the next commit is stamped beyond MAX_SKEW_MS, the
  // server refuses it `clock-skew`, and the engine takes the refusal's sample, restamps and resends; it is accepted, and
  // the person sees no notice.
  static func clockSkew(_ run: ScenarioRun) async throws {
    try await run.signInAndSync()
    run.probe.clock.setSkew(ms: 600_000)
    run.note("the device clock jumped 10 minutes ahead")
    try run.commitCard("Skew")
    try await run.waitUntilSettled(within: .seconds(30))
    let results = run.logged("push").flatMap { ($0["results"].flatMap { try? $0.asArray() }) ?? [] }
    try run.check("the server refused it clock-skew", results.contains { $0["code"] == "clock-skew" }, .array(results))
    try run.check("then accepted it", results.last?["s"] == "ok", .array(results))
    try run.check("no notice", try run.probe.active().notices.isEmpty)
    try run.check("the card is drawn", try run.cardTitles() == ["Skew"])
  }

  // Synced with the clock as it is; e2e.sh then relaunches the app with its clock 10 minutes ahead.
  static func clockJumpBefore(_ run: ScenarioRun) async throws {
    try await run.signInAndSync()
    try run.commitCard("Before")
    try await run.waitUntilSettled()
    run.note("the offset", try run.probe.active().meta.offset.logged)
  }

  // The clock moved 10 minutes ahead while the app was not running: the first sample of this launch sees the jump in its
  // reading and replaces every earlier one, so stamps follow the server again and nothing is refused clock-skew.
  static func clockJumpAfter(_ run: ScenarioRun) async throws {
    run.note("the offset before start", try run.probe.active().meta.offset.logged)
    await run.start()
    let offset = try run.probe.active().meta.offset
    try run.check("no sample from before the jump is kept", offset.samples.allSatisfy { abs($0.offset + 600_000) < 5_000 }, offset.logged)
    try run.check("the offset corrects the clock", abs(offset.ms + 600_000) < 5_000, offset.logged)
    try await run.waitForFirstPull()
    try run.commitCard("After")
    try await run.waitUntilSettled()
    let results = run.logged("push").flatMap { ($0["results"].flatMap { try? $0.asArray() }) ?? [] }
    try run.check("nothing was refused clock-skew", !results.contains { $0["code"] == "clock-skew" }, .array(results))
    try run.check("both cards are drawn", try run.cardTitles() == ["After", "Before"])
  }

  // MARK: Epoch change

  // Synced, then e2e.sh regenerates the server's epoch, as a restore from backup does. The answer to the next push carries
  // the new epoch: its card lands, the replica re-identifies, every cursor boots again, and the next card goes as the new
  // replica.
  static func epochChange(_ run: ScenarioRun) async throws {
    try await run.signInAndSync()
    try run.commitCard("Before")
    try await run.waitUntilSettled()
    let before = try run.probe.active().meta
    run.note("before", ["replica": .string(before.replica), "epoch": before.serverEpoch.map(JSON.string) ?? .null])
    run.signal("synced")
    try await run.awaitSignal("regenerated", within: .seconds(30))
    try run.commitCard("After")
    try await run.waitUntil("the replica holds the new epoch", within: .seconds(15)) {
      try run.probe.active().meta.serverEpoch != before.serverEpoch
    }
    let after = try run.probe.active().meta
    try run.check("the replica re-identified", after.replica != before.replica,
                  ["replica": .string(after.replica), "epoch": after.serverEpoch.map(JSON.string) ?? .null])
    try await run.waitForFirstPull()
    try await run.waitUntilSettled()
    try run.commitCard("Later")
    try await run.waitUntilSettled()
    try run.check("every card is drawn", try run.cardTitles() == ["After", "Before", "Later"])
  }

  // MARK: Sign-in lineage

  // The account's first record, so it holds records when a signed-out phone signs in.
  static func lineageSeed(_ run: ScenarioRun) async throws {
    try await run.signInAndSync()
    try run.commitCard("Seed")
    try await run.waitUntilSettled()
  }

  // A fresh phone, signed out, commits; it signs in to the account, which holds records, so the decision appears; Add
  // joins the card to the account and pushes it.
  static func lineageAdd(_ run: ScenarioRun) async throws {
    try await lineage(run, answering: .add, title: "Added")
    try run.check("the added card joined the account's", try run.cardTitles() == ["Added", "Seed"])
  }

  // The same on another fresh phone, answered Discard: the card is dropped and never reaches the server.
  static func lineageDiscard(_ run: ScenarioRun) async throws {
    try await lineage(run, answering: .discard, title: "Dropped")
    try run.check("only the account's cards are drawn", try run.cardTitles() == ["Added", "Seed"])
  }

  static func lineage(_ run: ScenarioRun, answering answer: LineageAnswer, title: String) async throws {
    try run.check("the phone is signed out", try run.probe.boundAccount() == nil)
    await run.start()
    try run.commitCard(title)
    let decisions = try await run.signIn(answering: answer)
    try run.check("the decision counted the card", decisions == [SignedOutDecision(product: "probe", counts: ["card": 1], counted: decisions.first?.counted ?? [])],
                  .array(decisions.map(\.logged)))
    try await run.waitForFirstPull()
    try await run.waitUntilSettled()
  }

  // MARK: The probe's own launch

  // A session token may begin with "-": e2e.sh launches with one, and the dev sign-in must read it whole. Found by e2e,
  // where one token in 64 was dropped and a re-authentication by launch arguments silently did not happen.
  static func launchArguments(_ run: ScenarioRun) async throws {
    try run.check("a token that begins with a dash is read whole", run.probe.settings.token == "-dashed_token-0",
                  run.probe.settings.token.map(JSON.string) ?? .null)
  }
}

extension ServerOffset {
  var logged: JSON {
    ["ms": JSON(ms), "samples": .array(samples.map(\.json)), "reading": clockReading?.json ?? .null]
  }
}
