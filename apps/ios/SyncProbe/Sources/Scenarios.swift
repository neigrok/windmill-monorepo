import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncReplica

// The scenarios only an end-to-end run can prove (design §10 item 5), each as the steps one launch takes. A scenario that
// spans launches or phones has one entry per launch, `<scenario>/<phase>`, and e2e.sh runs them in order around what
// only the simulator or the server can do: leave the app, kill it, copy its container, revoke a session, sign in another
// account, regenerate the epoch. Each works under accounts of its own, so what the server holds afterwards is the
// scenario's alone.
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
    case "revoked-live/watch": revokedLiveWatch
    case "foreign-credential/swap": foreignCredentialSwap
    case "foreign-credential/relaunch": foreignCredentialRelaunch
    case "foreign-credential/resume": foreignCredentialResume
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
    try await run.signInAndSync(card: "Live")
  }

  // MARK: Fork guard

  // The phone whose container e2e.sh then copies to another, without the fork guard's copy.
  static func forkOrigin(_ run: ScenarioRun) async throws {
    try await run.signInAndSync(card: "Origin")
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

  // Synced, then away from the app: its socket closes and nothing pulls, so once e2e.sh revokes the session, the push of
  // the card committed next is the first call under it. It answers 401, as no one's; the replica pauses and the status
  // says so.
  static func reauthPause(_ run: ScenarioRun) async throws {
    try await run.signInAndSync(card: "Before")
    let left = run.logCount
    try run.probe.engine.leave()
    try await run.waitUntil("the live socket is closed", within: .seconds(5)) { !run.logged("live-close", from: left).isEmpty }
    let revoked = try await awaitRevocation(run)
    try run.commitCard("After")
    try await run.waitUntil("the replica is paused", within: .seconds(10)) { try run.probe.active().meta.authPaused }
    let pushes = run.logged("push", from: revoked)
    try run.check("the push answered 401, as no one's", pushes.count == 1 && pushes[0]["status"] == 401 && pushes[0]["as"] == .null,
                  .array(pushes))
    try await run.waitUntil("the status asks to re-authenticate", within: .seconds(2)) { run.probe.engine.status.authPaused }
    try run.check("the card waits unsent", try run.entryStates().allSatisfy { $0 == "ready" || $0 == "sent" })
    try run.check("nothing was pulled", run.logged("pull", from: revoked).isEmpty, .array(run.logged("pull", from: revoked)))
  }

  // Launched with a new token for the account: the pause is cleared and the card waiting goes.
  static func reauthResume(_ run: ScenarioRun) async throws {
    try await resume(run)
    try run.check("both cards are drawn", try run.cardTitles() == ["After", "Before"])
  }

  // Synced, then e2e.sh revokes the session. The phone pulls under it, on the reconnect the server's close of the
  // session's socket makes or on coming back to the foreground, and the pull answers 401, as no one's: the phone pauses,
  // applies nothing, keeps the account's rows and forgets no scope.
  static func revokedPullPause(_ run: ScenarioRun) async throws {
    try await run.signInAndSync(card: "Before")
    let cursor = try run.cursor()
    let revoked = try await awaitRevocation(run)
    run.probe.engine.foreground()
    try await run.waitUntil("the replica is paused", within: .seconds(10)) { try run.probe.active().meta.authPaused }
    let pulls = run.logged("pull", from: revoked)
    try run.check("the pull under the revoked session answered 401, as no one's",
                  !pulls.isEmpty && pulls.allSatisfy { $0["status"] == 401 && $0["as"] == .null }, .array(pulls))
    try await run.waitUntil("the status asks to re-authenticate", within: .seconds(2)) { run.probe.engine.status.authPaused }
    try run.check("the phone still draws its card", try run.cardTitles() == ["Before"])
    try run.check("and knows no scope gone or not found", try run.probe.active().known.isEmpty)
    try run.check("the cursor stands", try run.cursor() == cursor, try run.cursor())
    try run.check("nothing was pushed", run.logged("push", from: revoked).isEmpty, .array(run.logged("push", from: revoked)))
  }

  // Launched with a new token: the pause is cleared, the product is pulled again from where it stood, and the card stays.
  static func revokedPullResume(_ run: ScenarioRun) async throws {
    try await resume(run)
    try run.check("the card is drawn", try run.cardTitles() == ["Before"])
  }

  // Following self/probe live, then e2e.sh revokes the session. The server closes the socket at once, before any other
  // frame (§6.8), so the phone learns of it without asking: the reconnect's pull is answered 401, as no one's, and the
  // phone pauses. The card another phone of the account commits afterwards never reaches it, and it forgets nothing.
  static func revokedLiveWatch(_ run: ScenarioRun) async throws {
    try await run.signInAndSync()
    try await run.waitUntil("the live socket follows self/probe", within: .seconds(10)) {
      run.logged("live-send").contains { $0["op"] == "sub" && $0["scopes"] == ["self/probe"] }
    }
    let revoked = try await awaitRevocation(run)
    try await run.waitUntil("the replica is paused", within: .seconds(10)) { try run.probe.active().meta.authPaused }
    let after = Array(run.probe.log.all.dropFirst(revoked))
    let ended = after.firstIndex { $0["kind"] == "live-closed" || $0["kind"] == "live-failed" }
    let pulled = after.firstIndex { $0["kind"] == "pull" } ?? after.count
    try run.check("the server ended the socket before the phone asked anything", ended.map { $0 < pulled } == true, .array(after))
    let asked = run.logged("pull", from: revoked) + run.logged("live-open", from: revoked)
    try run.check("every pull and upgrade under the revoked session answered 401",
                  !asked.isEmpty && asked.allSatisfy { $0["status"] == 401 }, .array(asked))
    run.signal("paused")
    try await run.awaitSignal("committed", within: .seconds(60))
    try await Task.sleep(for: .seconds(3))
    let frames = run.logged("live-frame", from: revoked).filter { $0["op"] != "pong" }
    try run.check("no frame came after the revocation", frames.isEmpty, .array(frames))
    try run.check("the other phone's card never reached this one", try run.cardTitles().isEmpty)
    try run.check("and it knows no scope gone or not found", try run.probe.active().known.isEmpty)
  }

  // Tells e2e.sh the phone is synced, and waits for it to revoke the session. Answers where the log stood before.
  static func awaitRevocation(_ run: ScenarioRun) async throws -> Int {
    let synced = run.logCount
    run.signal("synced")
    try await run.awaitSignal("revoked", within: .seconds(30))
    return synced
  }

  static func resume(_ run: ScenarioRun) async throws {
    try run.check("the launch token cleared the pause", try !run.probe.active().meta.authPaused)
    await run.start()
    try await run.waitForFirstPull()
    try await run.waitUntilSettled()
  }

  // MARK: Another account's credential

  // Synced, then the Keychain holds a stranger's token (`-foreignToken`) as the account's. The push of the card committed
  // next names the account and is served as the stranger: 409 account-mismatch, refused before the server reads the
  // replica's binding. The phone handles it as a 401: it pauses, and forgets and changes nothing.
  static func foreignCredentialSwap(_ run: ScenarioRun) async throws {
    guard let foreign = run.probe.settings.foreignToken else { throw ScenarioRun.Failed(description: "no -foreignToken to hold") }
    try await run.signInAndSync(card: "Mine")
    let account = try run.probe.boundAccount() ?? ""
    let cursor = try run.cursor()
    try run.probe.tokens.save(SessionToken(foreign), for: account)
    run.note("the Keychain holds the stranger's token as the account's")
    let swapped = run.logCount
    try run.commitCard("Stray")
    try await run.waitUntil("the replica is paused", within: .seconds(10)) { try run.probe.active().meta.authPaused }
    let pushes = run.logged("push", from: swapped)
    let servedAs = pushes.first?["as"].flatMap { try? $0.asString() }
    try run.check("the push named the account and answered 409 account-mismatch, served as another account",
                  pushes.count == 1 && pushes[0]["status"] == 409 && pushes[0]["error"] == "account-mismatch"
                    && pushes[0]["account"] == .string(account) && servedAs != nil && servedAs != account, .array(pushes))
    run.note("served as", servedAs.map(JSON.string) ?? .null)
    try await keptEverything(run, cursor: cursor)
    try run.check("nothing was pulled", run.logged("pull", from: swapped).isEmpty, .array(run.logged("pull", from: swapped)))
  }

  // Relaunched with the stranger's token for the account: the launch re-authenticates with it, which clears the pause,
  // and engine start's hello is served as the stranger. The phone pauses before it pulls or pushes, and forgets and
  // changes nothing.
  static func foreignCredentialRelaunch(_ run: ScenarioRun) async throws {
    let account = try run.probe.boundAccount() ?? ""
    let held = run.probe.tokens.token(for: account) == run.probe.settings.token.map(SessionToken.init)
    let paused = try run.probe.active().meta.authPaused
    try run.check("the launch holds the stranger's token as the account's, and cleared the pause", held && !paused)
    let cursor = try run.cursor()
    let launched = run.logCount
    await run.start()
    try await run.waitUntil("the replica is paused", within: .seconds(10)) { try run.probe.active().meta.authPaused }
    let hellos = run.logged("hello", from: launched)
    let servedAs = hellos.first?["as"].flatMap { try? $0.asString() }
    try run.check("the hello was served as another account",
                  hellos.count == 1 && hellos[0]["status"] == 200 && servedAs != nil && servedAs != account, .array(hellos))
    run.note("served as", servedAs.map(JSON.string) ?? .null)
    try await keptEverything(run, cursor: cursor)
    let calls = run.logged("pull", from: launched) + run.logged("push", from: launched)
    try run.check("nothing was pulled or pushed", calls.isEmpty, .array(calls))
  }

  // Relaunched with a new token of the account's own: the pause clears, and the stray card goes to the account.
  static func foreignCredentialResume(_ run: ScenarioRun) async throws {
    try await resume(run)
    try run.check("both cards are drawn", try run.cardTitles() == ["Mine", "Stray"])
  }

  // What an answer served as another account leaves as it was: both cards are drawn, no scope is known gone or not found,
  // the stray card waits unsent, and the cursor stands; the status asks to re-authenticate.
  static func keptEverything(_ run: ScenarioRun, cursor: JSON) async throws {
    try await run.waitUntil("the status asks to re-authenticate", within: .seconds(2)) { run.probe.engine.status.authPaused }
    try run.check("both cards are drawn", try run.cardTitles() == ["Mine", "Stray"])
    try run.check("no scope is known gone or not found", try run.probe.active().known.isEmpty)
    let states = try run.entryStates()
    try run.check("the stray card waits unsent", states == ["ready"] || states == ["sent"], .array(states.map(JSON.string)))
    let standing = try run.cursor()
    try run.check("the cursor stands", standing == cursor, standing)
    run.note("the cursor", standing)
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
    try await run.signInAndSync(card: "Before")
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
    try await run.signInAndSync(card: "Before")
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
    try await run.signInAndSync(card: "Seed")
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
