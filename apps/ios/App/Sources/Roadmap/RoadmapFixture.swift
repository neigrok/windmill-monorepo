import Foundation
import UIKit
import DomainKit
import Synchronization
import RoadmapDomain
import SyncCore
import SyncEngine
import SyncSchema
import SyncStore

// Simulator boards. An account's roadmaps arriving by sync: roadmap-learn-to-sail (three steps done), roadmap-all-done
// (all eight), roadmap-no-steps (*Night sailing*, with no step), roadmap-several (*Learn to sail* over two more, the
// most recent first), roadmap-workspace (*Learn to sail* with the workspace the boards draw on *Read the wind*),
// roadmap-two-phones (*Learn to sail*, where the account's other phone adds a subtask to the first step whose page is
// opened) and roadmap-first-read (*Learn to sail*, each pull of the signed-in phone answered three seconds late, so the
// room's first read runs long). Of the Guide: roadmap-guide (*Learn to sail* with its guide, 08.1), roadmap-guide-long (a
// guide 15 characters short of the limit, 08.3 and 08.4) and roadmap-guide-above (roadmap-several, with *Learn to sail*'s
// guide and *Become a day skipper*'s, 08.5). Of the account's questions: roadmap-sign-in (*Learn to sail* on an account the
// phone is not signed in to, 10.7) and roadmap-unconfirmed (*Learn to sail*, five of whose steps the phone completes
// after the server stops answering, 10.8). On a phone never signed in: roadmap-many, the nine roadmaps All Roadmaps draws, in no
// order a server gave them; roadmap-handbook, the 5,000 steps the Graph's and the Board's budget is measured at;
// roadmap-full, a roadmap at the steps the registry lets it hold; roadmap-undo-finds-nothing, *Learn to sail*, where
// the engine keeps no Undo of a band's act by the time it is tapped (`undoFindsNothing(in:)`); and roadmap-empty, which
// holds none.
// roadmap-unreadable cannot make its views, and roadmap-unwritable, *Learn to sail* on a phone never signed in, cannot write
// once it is planted (`faults(_:)`). A shared roadmap's covers (`prepareCover`): roadmap-cover, signed in to an
// account of the phone's own, and roadmap-cover-signed-out, each opening the link to another account's public *Learn to
// sail*; roadmap-cover-offline, which opens it and has no connection; roadmap-cover-private and
// roadmap-cover-private-signed-out, the link to a roadmap of that account's that is private; and
// roadmap-cover-no-connection, a link with no connection and no copy on the phone. Nested roadmaps (`prepareNested`):
// roadmap-nested, *Become a day skipper* whose *Learn to sail* opens *Learn to sail* (07.1 to 07.10), with *Spanish B1* and
// *Coastal navigation handbook* beside them and the link to another account's public *Reefing course* copied;
// roadmap-nested-offline, the same with no connection for its requests (07.12a); roadmap-nested-signed-out, the same planted
// on a phone never signed in (07.12b); roadmap-nested-done, the same with every step of *Learn to sail* done (07.4);
// roadmap-nested-unattached, the same whose *Learn to sail* opens no roadmap yet (07.8 to 07.10); roadmap-nested-odd, the
// variation whose Up next steps open a roadmap that loops back, one with no steps and one that cannot be found (07.5a to
// 07.5d); and roadmap-nested-subtree, the variation whose *Night passage* owns a subtree (07.11, 07.11b). The public
// gallery's (`prepareGallery`): roadmap-gallery, the rows 09.12a draws on an account holding *Spanish B1*, and
// roadmap-gallery-unreachable, a gallery that cannot be reached (09.12b). Section 10's
// (`prepareSync`): roadmap-sync-offline, a step made with no connection (10.1); roadmap-sync-landed, one that lands
// following past a step deleted elsewhere (10.2, 10.3); roadmap-sync-came-back, a step an edit brought back (10.4); and
// roadmap-sync-set-aside, two changes to a roadmap deleted elsewhere (10.5a to 10.5c). A launch can also
// name where the Graph's measures go and how it keeps a pinch's frames (`graph(telemetry:)`), where the Board's go
// (`boardFrames()`), how long a band stands (`wait()`), text the app copies itself before Paste Steps reads it
// (`clipboard()`), and the file New Roadmap's A File is handed in place of the system's importer (`chosenFile()`).
enum RoadmapFixture {
  // The engine's views of every record of a type in a scope, visible or not, as the room's model takes them.
  static func records(_ runtime: AppRuntime) -> RoadmapModel.Records {
    #if DEBUG && targetEnvironment(simulator)
    if runtime.settings.board == "roadmap-unreadable" { return { _, _ in throw AppFailure(message: "The board's views cannot be made.") } }
    #endif
    return { scope, type in try runtime.engine.records(scope, type, .drawn, visibleOnly: false) }
  }

  // The store's fault hook. roadmap-unwritable's fails every commit before its transaction commits, as a full disk would,
  // once its roadmap is planted (`storeFull`), and every read stands.
  nonisolated static let storeFull = Atomic(false)
  static func faults(_ settings: AppSettings) -> CrashPoints {
    #if DEBUG && targetEnvironment(simulator)
    guard settings.board == "roadmap-unwritable" else { return .none }
    return CrashPoints { point in
      guard point == .beforeCommit(.commit), storeFull.load(ordering: .relaxed) else { return }
      throw CocoaError(.fileWriteOutOfSpace)
    }
    #else
    return .none
    #endif
  }

  // The Graph the room holds. A simulator launch has it append its measures to the file `-graph-measures` names, one
  // JSON line each, keep a pinch's frames the way `-graph-pinch` names, and do so past the steps in view `-graph-crowd`
  // counts.
  static func graph(telemetry: any Telemetry) -> RoadmapGraph {
    #if DEBUG && targetEnvironment(simulator)
    let arguments = ProcessInfo.processInfo.arguments
    let asked = { (name: String) -> String? in
      arguments.firstIndex(of: name).flatMap { (named: Int) -> String? in named + 1 < arguments.count ? arguments[named + 1] : nil }
    }
    let measured = asked("-graph-measures").map { (path: String) -> (RoadmapGraph.Measure) -> Void in
      let file = URL(fileURLWithPath: path)
      return { measure in
        let line: [String: Any]
        switch measure {
        case .firstFrame(let ms, let layoutMs, let steps): line = ["measure": "firstFrame", "ms": ms, "layoutMs": layoutMs, "steps": steps]
        case .frames(let gapsMs, let workMs, let zoom, let steps):
          line = ["measure": "frames", "gapsMs": gapsMs, "workMs": workMs, "zoom": zoom, "steps": steps]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
        if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
        guard let handle = try? FileHandle(forWritingTo: file) else { return }
        handle.seekToEndOfFile()
        handle.write(data + Data("\n".utf8))
        try? handle.close()
      }
    }
    return RoadmapGraph(telemetry: telemetry, measured: measured, pinch: asked("-graph-pinch").flatMap { GraphPinch(rawValue: $0) } ?? .room,
                        crowd: asked("-graph-crowd").flatMap { Int($0) } ?? GraphPinch.crowd)
    #else
    return RoadmapGraph(telemetry: telemetry)
    #endif
  }

  // What the Board measures of itself. A simulator launch has it append its measures to the file `-board-measures` names,
  // one JSON line each.
  static func boardFrames() -> BoardFrames {
    #if DEBUG && targetEnvironment(simulator)
    let arguments = ProcessInfo.processInfo.arguments
    guard let named = arguments.firstIndex(of: "-board-measures"), named + 1 < arguments.count else { return BoardFrames() }
    let file = URL(fileURLWithPath: arguments[named + 1])
    return BoardFrames(measured: { measure in
      let line: [String: Any]
      switch measure {
      case .firstFrame(let ms, let steps): line = ["measure": "firstFrame", "ms": ms, "steps": steps]
      case .frames(let gapsMs, let workMs, let steps): line = ["measure": "frames", "gapsMs": gapsMs, "workMs": workMs, "steps": steps]
      }
      guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
      if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
      guard let handle = try? FileHandle(forWritingTo: file) else { return }
      handle.seekToEndOfFile()
      handle.write(data + Data("\n".utf8))
      try? handle.close()
    })
    #else
    return BoardFrames()
    #endif
  }

  // How the room waits out a band's time. A simulator launch with `-band-stands` has every band stand that many seconds
  // in place of its six or the hold's nine, so a flow that takes a band's Undo cannot be outlasted by a slow runner.
  static func wait() -> RoadmapModel.Wait {
    #if DEBUG && targetEnvironment(simulator)
    let arguments = ProcessInfo.processInfo.arguments
    if let named = arguments.firstIndex(of: "-band-stands"), named + 1 < arguments.count, let seconds = Int(arguments[named + 1]) {
      return { _ in try await Task.sleep(for: .seconds(seconds)) }
    }
    #endif
    return { try await Task.sleep(for: $0) }
  }

  // The clipboard the room reads and writes. A simulator launch whose environment holds text in `WM_COPIED_STEPS` has the
  // app copy it itself first, so Paste Steps reads it as the app's own and the system asks nothing; another app's text
  // stays the system's to hand over. The environment carries a list's line breaks, which a UI test's launch arguments split.
  static func clipboard() -> Clipboard {
    #if DEBUG && targetEnvironment(simulator)
    if let copied = ProcessInfo.processInfo.environment["WM_COPIED_STEPS"] { Clipboard.system.copy(copied) }
    #endif
    return .system
  }

  // The boards' copied plan (Roadmap · iOS 01.8): *Summer cruise*, twelve steps under three headings, two done, four
  // lines kept as notes.
  static let summerCruise = """
    Summer cruise
    - [x] Pick the week
    - [x] Book the boat
      - Plan the route
        Out by the north channel, back along the coast.
        Two nights at anchor.
        - Check the tides
        - Mark the harbours
    ## Galley
    - Provision for five days
      Water, fuel and food for four.
    ## Crew
    - Brief the crew
      Watches, knots and the man-overboard drill.
    ## Deck
    - Cast off
    """

  // The file a launch names with `-roadmap-file` stands for the one the system's importer would hand New Roadmap: the
  // boards' plan written under that name to the app's temporary folder, the file Export wrote where the launch names
  // the same file with `-roadmap-export`, or, named `Sailing plan.md`, a file that cannot be read (01.8c). None where no
  // launch names one, and in any build but a simulator's debug build.
  static func chosenFile() -> URL? {
    #if DEBUG && targetEnvironment(simulator)
    let arguments = ProcessInfo.processInfo.arguments
    guard let named = arguments.firstIndex(of: "-roadmap-file"), named + 1 < arguments.count else { return nil }
    let file = URL.temporaryDirectory.appending(path: arguments[named + 1])
    if arguments[named + 1] != "Sailing plan.md" && file != exportFile() { try? Data(summerCruise.utf8).write(to: file) }
    return file
    #else
    return nil
    #endif
  }

  // The file a launch names with `-roadmap-export`, in the app's temporary folder, which Export writes in place of the
  // system's exporter. None where no launch names one, and in any build but a simulator's debug build.
  static func exportFile() -> URL? {
    #if DEBUG && targetEnvironment(simulator)
    let arguments = ProcessInfo.processInfo.arguments
    guard let named = arguments.firstIndex(of: "-roadmap-export"), named + 1 < arguments.count else { return nil }
    return URL.temporaryDirectory.appending(path: arguments[named + 1])
    #else
    return nil
    #endif
  }

  // What a cover reads a shared roadmap through: the engine, and the backend's sharing requests with the account's token. On
  // a cover's, a nested roadmap's or the gallery's board the model server serves sync alone, so the board's own requests
  // stand in for the backend's (`BoardSharing`), and roadmap-cover-offline and roadmap-cover-no-connection have no
  // connection, the latter following nothing, so the phone holds no copy.
  static func sources(_ runtime: AppRuntime, telemetry: any Telemetry) -> RoadmapCover.Sources {
    let engine = runtime.engine
    // The session the phone can send as now: the signed-in account's, none while it waits to be renewed.
    let credential = { () -> SessionToken? in
      guard !engine.status.authPaused, let account = try? runtime.account() else { return nil }
      return runtime.tokens.token(for: account)
    }
    #if DEBUG && targetEnvironment(simulator)
    if let board = runtime.settings.board, ["roadmap-cover", "roadmap-nested", "roadmap-gallery"].contains(where: { board.hasPrefix($0) }) {
      let offline = board == "roadmap-cover-offline" || board == "roadmap-cover-no-connection" || board == "roadmap-nested-offline"
      return RoadmapCover.Sources(follow: { board == "roadmap-cover-no-connection" ? .subscribed : try engine.subscribe($0) },
                                  letGo: { try engine.unsubscribe($0) }, online: { !offline && engine.status.online },
                                  signedIn: { engine.status.account != nil }, credential: credential, requests: BoardSharing(),
                                  site: runtime.settings.baseURL)
    }
    #endif
    let requests = SharingRequests(baseURL: runtime.settings.baseURL, credential: credential, online: { engine.status.online }, telemetry: telemetry)
    return RoadmapCover.Sources(follow: { try engine.subscribe($0) }, letGo: { try engine.unsubscribe($0) }, online: { engine.status.online },
                                signedIn: { engine.status.account != nil }, credential: credential, requests: requests, site: runtime.settings.baseURL)
  }

  static func prepare(_ board: String, model: AppModel) async -> Bool {
    #if DEBUG && targetEnvironment(simulator)
    guard board.hasPrefix("roadmap-") else { return false }
    model.openRoom(.roadmap)
    if board.hasPrefix("roadmap-cover") {
      await prepareCover(board, model: model)
      return true
    }
    if board.hasPrefix("roadmap-nested") {
      await prepareNested(board, model: model)
      return true
    }
    if board.hasPrefix("roadmap-gallery") {
      await prepareGallery(board, model: model)
      return true
    }
    if board.hasPrefix("roadmap-sync") {
      await prepareSync(board, model: model)
      return true
    }
    // The steps of *Learn to sail* each board's account completed, the oldest first.
    let completed = ["roadmap-learn-to-sail": ["choose", "parts", "rig"], "roadmap-several": ["choose", "parts", "rig"],
                     "roadmap-workspace": ["choose", "parts", "rig"], "roadmap-two-phones": ["choose", "parts", "rig"],
                     "roadmap-first-read": ["choose", "parts", "rig"], "roadmap-guide": ["choose", "parts", "rig"],
                     "roadmap-guide-long": ["choose", "parts", "rig"], "roadmap-guide-above": ["choose", "parts", "rig"],
                     "roadmap-sign-in": ["choose", "parts", "rig"], "roadmap-unconfirmed": ["choose", "parts", "rig"],
                     "roadmap-coach-history": ["choose", "parts", "rig"],
                     "roadmap-all-done": ["choose", "parts", "rig", "read", "tie", "leave", "tri", "solo"]][board]
    // The guide each board's *Learn to sail* holds.
    let guide = ["roadmap-guide": Guides.sail, "roadmap-guide-above": Guides.sail, "roadmap-guide-long": Guides.long][board]
    let local = ["roadmap-many", "roadmap-handbook", "roadmap-full", "roadmap-undo-finds-nothing", "roadmap-unwritable", "roadmap-signed-out"]
    guard completed != nil || board == "roadmap-no-steps" || local.contains(board) else { return true }
    do {
      // roadmap-many, roadmap-handbook, roadmap-full, roadmap-undo-finds-nothing, roadmap-unwritable and roadmap-signed-out are
      // made on the phone itself, signed out: the first with *Learn to sail* remembered as the roadmap last open, the others
      // holding their one roadmap alone, roadmap-signed-out *Learn to sail* with three steps done (Roadmap · iOS 11.18, 11.19a).
      if local.contains(board) {
        guard let runner = model.runtime?.roadmapRunner else { throw AppFailure(message: "no runtime") }
        if board == "roadmap-handbook" {
          try plantHandbook(runner)
          return true
        }
        if board == "roadmap-full" {
          try plantFull(runner)
          return true
        }
        if board == "roadmap-undo-finds-nothing" {
          try plantLearnToSail(runner)
          Task { @MainActor in await undoFindsNothing(in: model) }
          return true
        }
        if board == "roadmap-signed-out" {
          try plantLearnToSail(runner)
          return true
        }
        if board == "roadmap-unwritable" {
          try plantLearnToSail(runner)
          storeFull.store(true, ordering: .relaxed)
          return true
        }
        let sail = try plantLearnToSail(runner).tree
        model.preferences.set(sail.description, forKey: RoadmapModel.lastOpen)
        for roadmap in others { try plant(roadmap, opening: sail, by: runner) }
        return true
      }
      guard let server = model.runtime?.auth.fake else { throw AppFailure(message: "no model server") }
      let identity = server.identity(email: "roadmap-fixture@example.com")
      let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
      let clock = SteppingBoardClock()
      let remote = try AppRuntime(settings: AppSettings(arguments: ["fixture", "-model-server", "-board", board]),
                                  directory: directory, service: UUID().uuidString, syncTransport: server, wall: clock)
      // The other phone goes once the board is planted; roadmap-two-phones keeps it until it has written.
      let retire = {
        try? remote.tokens.delete(for: identity.account)
        try? FileManager.default.removeItem(at: directory)
      }
      defer { if board != "roadmap-two-phones" { retire() } }
      _ = try await remote.engine.signIn(account: identity.account, token: identity.token)
      // The board's clock stands still, so the other phone makes each sending a second after the one before, and the
      // server receives it so: Done, newest first, and the account's roadmaps, most recent first, have an order.
      var sendings: Int64 = 0
      let sent = { () async throws -> Void in
        server.state.withLock { $0.pushesReceivedLaterMs = sendings * 1_000 }
        clock.step(to: sendings * 1_000)
        sendings += 1
        try remote.engine.leave()
        for _ in 0..<40 where try remote.store.read({ try $0.device().activeReplica.outbox.contains { $0.state != .acked } }) {
          await remote.engine.flushOnLeave()
        }
      }
      var planted: CreateRoadmap.Result?
      if let completed {
        let sail = try plantLearnToSail(remote.roadmapRunner, done: [])
        planted = sail
        try await sent()
        if let guide {
          try write(guide, on: sail.tree, by: remote.roadmapRunner)
          try await sent()
        }
        if board == "roadmap-workspace" {
          try plantWorkspace(of: sail, by: remote.roadmapRunner)
          try await sent()
        }
        for step in completed.dropLast() {
          try complete(step, of: sail, by: remote.roadmapRunner)
          try await sent()
        }
        // roadmap-several's two roadmaps under *Learn to sail* arrive before its last completion, the lower first.
        var beside: [String: ID<RoadmapEntry>] = [:]
        if board == "roadmap-several" || board == "roadmap-guide-above" || board == "roadmap-coach-history" {
          for roadmap in others.prefix(2).reversed() {
            let other = try plant(roadmap, opening: sail.tree, by: remote.roadmapRunner)
            beside[roadmap.title] = other.tree
            if board == "roadmap-guide-above" && roadmap.title == "Become a day skipper" { try write(Guides.skipper, on: other.tree, by: remote.roadmapRunner) }
            try await sent()
          }
        }
        if let last = completed.last {
          try complete(last, of: sail, by: remote.roadmapRunner)
          try await sent()
        }
        if board == "roadmap-coach-history", let spanish = beside["Spanish B1"], let skipper = beside["Become a day skipper"] {
          try converse(about: sail, spanish: spanish, skipper: skipper, clock: clock, by: remote.roadmapRunner)
          try await sent()
        }
      } else {
        guard case .committed = try remote.roadmapRunner.runAct(CreateRoadmap(title: "Night sailing")) else {
          throw AppFailure(message: "Night sailing was not planted.")
        }
        try await sent()
      }
      server.state.withLock { state in
        state.pushesReceivedLaterMs = 0
        if board == "roadmap-first-read" { (state.pullsAnsweredBeforeHold, state.pullDelaySeconds) = (Int.max, 3) }
      }
      guard board != "roadmap-sign-in" else { return true }
      try await model.signIn(identity)
      // roadmap-unconfirmed: once the launched phone has pulled *Learn to sail*, the server stops answering what the phone
      // sends, and the phone completes the last five steps.
      if board == "roadmap-unconfirmed", let sail = planted, let runner = model.runtime?.roadmapRunner {
        Task { @MainActor in
          let steps = { (try? runner.read(sail.tree.tree) { try $0.repository(RoadmapStep.self).all(in: .drawn).count }) ?? 0 }
          for _ in 0..<600 where steps() < 8 { try? await Task.sleep(for: .milliseconds(100)) }
          server.state.withLock { $0.pushesUnansweredAfter = 3_600 }
          for step in ["read", "tie", "leave", "tri", "solo"] {
            do { try complete(step, of: sail, by: runner) } catch { NSLog("Roadmap fixture: %@", String(describing: error)) }
          }
        }
      }
      if board == "roadmap-two-phones", let tree = planted?.tree {
        Task { @MainActor in
          let step = await openedStep(in: model)
          if case .committed? = try? remote.roadmapRunner.runAct(AddSubtask(tree: tree, step: ID(RecordID(step)), item: Subtask.Changes(label: "Ask about the tide table"))) {
            try? remote.engine.leave()
            for _ in 0..<40 where (try? remote.store.read({ try $0.device().activeReplica.outbox.contains { $0.state != .acked } })) == true {
              await remote.engine.flushOnLeave()
            }
          } else {
            NSLog("Roadmap fixture: the other phone's subtask was not written.")
          }
          retire()
        }
      }
    } catch {
      NSLog("Roadmap fixture failed: %@", String(describing: error))
      model.error = "The roadmap fixture could not be prepared."
    }
    return true
    #else
    return false
    #endif
  }

  #if DEBUG && targetEnvironment(simulator)
  // A cover's board: another account plants *Learn to sail*, completes three of its steps, a second apart as the server
  // receives them, and makes it public, or on a private board leaves it private; the phone signs in to an account of its
  // own, unless the board is signed out, whose other phone makes the copy a fork asks for; and the phone opens the
  // roadmap's link.
  static func prepareCover(_ board: String, model: AppModel) async {
    do {
      guard let server = model.runtime?.auth.fake, let sharing = model.roadmap?.links?.sources.requests as? BoardSharing else {
        throw AppFailure(message: "no model server")
      }
      let clock = SteppingBoardClock()
      let phone = { (email: String) async throws -> AppRuntime in
        let identity = server.identity(email: email)
        let remote = try AppRuntime(settings: AppSettings(arguments: ["fixture", "-model-server", "-board", board]),
                                    directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString),
                                    service: UUID().uuidString, syncTransport: server, wall: clock)
        _ = try await remote.engine.signIn(account: identity.account, token: identity.token)
        return remote
      }
      var sendings: Int64 = 0
      let sent = { (remote: AppRuntime) async throws -> Void in
        server.state.withLock { $0.pushesReceivedLaterMs = sendings * 1_000 }
        clock.step(to: sendings * 1_000)
        sendings += 1
        try remote.engine.leave()
        for _ in 0..<40 where try remote.store.read({ try $0.device().activeReplica.outbox.contains { $0.state != .acked } }) {
          await remote.engine.flushOnLeave()
        }
      }
      let owner = try await phone("roadmap-owner@example.com")
      let sail = try plantLearnToSail(owner.roadmapRunner, done: [])
      try await sent(owner)
      for step in ["choose", "parts", "rig"] {
        try complete(step, of: sail, by: owner.roadmapRunner)
        try await sent(owner)
      }
      if !board.contains("private") {
        guard case .committed = try owner.roadmapRunner.runAct(SetVisibility(tree: sail.tree, visibility: "public")) else {
          throw AppFailure(message: "Learn to sail was not made public.")
        }
        try await sent(owner)
      }
      server.state.withLock { $0.pushesReceivedLaterMs = 0 }
      sharing.owner = owner
      sharing.sent = sent
      if !board.hasSuffix("signed-out") && board != "roadmap-cover-no-connection" {
        let reader = server.identity(email: "roadmap-reader@example.com")
        try await model.signIn(reader)
        sharing.reader = try await phone("roadmap-reader@example.com")
      }
      model.open(roadmapLink: URL(string: "https://windmill.works/t/\(sail.tree.description)")!)
    } catch {
      NSLog("Roadmap cover fixture failed: %@", String(describing: error))
      model.error = "The roadmap fixture could not be prepared."
    }
  }

  // A nested roadmap's board: another account plants *Reefing course* and makes it public, and the phone holds the link
  // to it, copied; the person's roadmaps are planted by another phone of their account, a second apart as the server
  // receives them, or on this phone signed out: *Learn to sail* with three steps done, *Become a day skipper* with the
  // board's variation, *Coastal navigation handbook* and *Spanish B1*, so their list stands Learn to sail, Spanish B1,
  // Coastal navigation handbook, Become a day skipper, and the room opens on *Become a day skipper*.
  static func prepareNested(_ board: String, model: AppModel) async {
    do {
      guard let server = model.runtime?.auth.fake, let sharing = model.roadmap?.links?.sources.requests as? BoardSharing,
            let local = model.runtime?.roadmapRunner else { throw AppFailure(message: "no model server") }
      let clock = SteppingBoardClock()
      let phone = { (email: String) async throws -> AppRuntime in
        let identity = server.identity(email: email)
        let remote = try AppRuntime(settings: AppSettings(arguments: ["fixture", "-model-server", "-board", board]),
                                    directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString),
                                    service: UUID().uuidString, syncTransport: server, wall: clock)
        _ = try await remote.engine.signIn(account: identity.account, token: identity.token)
        return remote
      }
      var sendings: Int64 = 0
      let sent = { (remote: AppRuntime) async throws -> Void in
        server.state.withLock { $0.pushesReceivedLaterMs = sendings * 1_000 }
        clock.step(to: sendings * 1_000)
        sendings += 1
        try remote.engine.leave()
        for _ in 0..<40 where try remote.store.read({ try $0.device().activeReplica.outbox.contains { $0.state != .acked } }) {
          await remote.engine.flushOnLeave()
        }
      }
      let owner = try await phone("roadmap-owner@example.com")
      let reefs = ImportedSteps(steps: ["Reef on the mooring", "Shake out a reef", "Reef under way"].enumerated().map {
        ImportedStep(key: String($0.offset), RoadmapStep.Changes(label: $0.element, color: "sky"))
      }, links: [(from: "0", to: "1"), (from: "1", to: "2")])
      guard case .committed(let reefing, _) = try owner.roadmapRunner.runAct(CreateRoadmap(title: "Reefing course", steps: reefs)),
            case .committed = try owner.roadmapRunner.runAct(SetVisibility(tree: reefing.tree, visibility: "public")) else {
        throw AppFailure(message: "Reefing course was not shared.")
      }
      try await sent(owner)
      sharing.owner = owner
      sharing.sent = sent
      UIPasteboard.general.url = URL(string: "https://windmill.works/t/\(reefing.tree)")

      let signedOut = board == "roadmap-nested-signed-out"
      let mine: AppRuntime? = signedOut ? nil : try await phone("roadmap-fixture@example.com")
      let runner = mine?.roadmapRunner ?? local
      let send = { () async throws -> Void in if let mine { try await sent(mine) } }
      let sail = try plantLearnToSail(runner, done: [])
      try await send()
      let skipper = try plantSkipper(opening: sail, as: board, by: runner)
      try await send()
      for roadmap in [others[2], others[0]] {
        try plant(roadmap, opening: sail.tree, by: runner)
        try await send()
      }
      let done = board == "roadmap-nested-done" ? ["choose", "parts", "rig", "read", "tie", "leave", "tri", "solo"] : ["choose", "parts", "rig"]
      for step in done {
        try complete(step, of: sail, by: runner)
        try await send()
      }
      server.state.withLock { $0.pushesReceivedLaterMs = 0 }
      model.preferences.set(skipper.description, forKey: RoadmapModel.lastOpen)
      guard let mine else { return }
      sharing.reader = mine
      try await model.signIn(server.identity(email: "roadmap-fixture@example.com"))
    } catch {
      NSLog("Roadmap nested fixture failed: %@", String(describing: error))
      model.error = "The roadmap fixture could not be prepared."
    }
  }

  // The gallery's boards (09.12a, 09.12b): another account plants *Run a 10k* and *Room makeover* and makes them public;
  // another phone of the person's account plants *Spanish B1*, and the phone signs in to that account. The board's gallery
  // answers the rows 09.12a draws, five to a page, *Spanish B1* the person's own and those two the roadmaps the board
  // holds; roadmap-gallery-unreachable answers none, as with no connection.
  static func prepareGallery(_ board: String, model: AppModel) async {
    do {
      guard let server = model.runtime?.auth.fake, let sharing = model.roadmap?.links?.sources.requests as? BoardSharing else {
        throw AppFailure(message: "no model server")
      }
      let clock = SteppingBoardClock()
      let phone = { (email: String) async throws -> AppRuntime in
        let identity = server.identity(email: email)
        let remote = try AppRuntime(settings: AppSettings(arguments: ["fixture", "-model-server", "-board", board]),
                                    directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString),
                                    service: UUID().uuidString, syncTransport: server, wall: clock)
        _ = try await remote.engine.signIn(account: identity.account, token: identity.token)
        return remote
      }
      var sendings: Int64 = 0
      let sent = { (remote: AppRuntime) async throws -> Void in
        server.state.withLock { $0.pushesReceivedLaterMs = sendings * 1_000 }
        clock.step(to: sendings * 1_000)
        sendings += 1
        try remote.engine.leave()
        for _ in 0..<40 where try remote.store.read({ try $0.device().activeReplica.outbox.contains { $0.state != .acked } }) {
          await remote.engine.flushOnLeave()
        }
      }
      let owner = try await phone("roadmap-owner@example.com")
      var shared: [String: String] = [:]
      for (title, steps) in [("Run a 10k", 14), ("Room makeover", 11)] {
        let planted = ImportedSteps(steps: (1...steps).map { ImportedStep(key: String($0), RoadmapStep.Changes(label: "\(title) · \($0)", color: "terracotta")) },
                                    links: (1..<steps).map { (from: String($0), to: String($0 + 1)) })
        guard case .committed(let made, _) = try owner.roadmapRunner.runAct(CreateRoadmap(title: title, steps: planted)),
              case .committed = try owner.roadmapRunner.runAct(SetVisibility(tree: made.tree, visibility: "public")) else {
          throw AppFailure(message: "\(title) was not shared.")
        }
        shared[title] = made.tree.description
        try await sent(owner)
      }
      let mine = try await phone("roadmap-reader@example.com")
      let spanish = try plant(others[0], opening: ID(RecordID(shared["Run a 10k"] ?? "")), by: mine.roadmapRunner)
      try await sent(mine)
      server.state.withLock { $0.pushesReceivedLaterMs = 0 }
      sharing.owner = owner
      sharing.reader = mine
      sharing.sent = sent
      let fake = { (index: Int) in "t_00000000000a\(String(format: "%04x", index))" }
      sharing.gallery = board == "roadmap-gallery-unreachable" ? nil : [
        GalleryPage.Row(id: shared["Run a 10k"] ?? fake(1), title: "Run a 10k", steps: 14, mine: false),
        GalleryPage.Row(id: fake(2), title: "Rust from zero", steps: 24, mine: false),
        GalleryPage.Row(id: shared["Room makeover"] ?? fake(3), title: "Room makeover", steps: 11, mine: false),
        GalleryPage.Row(id: spanish.tree.description, title: "Spanish B1", steps: 40, mine: true),
        GalleryPage.Row(id: fake(5), title: "Learn watercolor", steps: 15, mine: false),
        GalleryPage.Row(id: fake(6), title: "Personal finance reset", steps: 13, mine: false),
        GalleryPage.Row(id: fake(7), title: "Ship v1", steps: 17, mine: false),
        GalleryPage.Row(id: fake(8), title: "ML foundations", steps: 29, mine: false),
      ]
      try await model.signIn(server.identity(email: "roadmap-reader@example.com"))
    } catch {
      NSLog("Roadmap gallery fixture failed: %@", String(describing: error))
      model.error = "The roadmap fixture could not be prepared."
    }
  }

  // Section 10's boards: another phone of the person's account plants their roadmaps, a second apart as the server
  // receives them, the phone signs in and the room reads them all; then the phone loses its connection
  // (`BoardConnectivity`). roadmap-sync-offline: offline, the room's form makes *Reefing basics* after *Read the wind*
  // and before *Leave the dock* (10.1). roadmap-sync-landed: the same while the other phone deletes *Read the wind*, the
  // receipt let go, and then the connection comes back, so the step lands following *Name the boat parts* (10.2, 10.3).
  // roadmap-sync-came-back: *Learn to sail* holds *Reefing basics*, which the other phone deletes; once that delete has
  // reached the phone, an edit of the step saved there brings it back (10.4). roadmap-sync-set-aside: beside *Learn to
  // sail*, *Spanish B1* and *Coastal navigation handbook*, the account holds *Winter refit*; offline, the phone adds
  // *Anchor at night* to it and writes the note of its *Plan the watch rota*, while the other phone deletes the roadmap,
  // and the connection comes back, so neither can land (10.5a to 10.5c).
  static func prepareSync(_ board: String, model: AppModel) async {
    do {
      guard let server = model.runtime?.auth.fake, let runner = model.runtime?.roadmapRunner, let room = model.roadmap,
            let connection = model.runtime?.connectivity as? BoardConnectivity else { throw AppFailure(message: "no model server") }
      let identity = server.identity(email: "roadmap-fixture@example.com")
      let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
      let clock = SteppingBoardClock()
      let remote = try AppRuntime(settings: AppSettings(arguments: ["fixture", "-model-server", "-board", board]),
                                  directory: directory, service: UUID().uuidString, syncTransport: server, wall: clock)
      // The other phone goes once the board is played out.
      let retire = {
        try? remote.tokens.delete(for: identity.account)
        try? FileManager.default.removeItem(at: directory)
      }
      var playing = false
      defer { if !playing { retire() } }
      _ = try await remote.engine.signIn(account: identity.account, token: identity.token)
      var sendings: Int64 = 0
      let sent = { () async throws -> Void in
        server.state.withLock { $0.pushesReceivedLaterMs = sendings * 1_000 }
        clock.step(to: sendings * 1_000)
        sendings += 1
        try remote.engine.leave()
        for _ in 0..<40 where try remote.store.read({ try $0.device().activeReplica.outbox.contains { $0.state != .acked } }) {
          await remote.engine.flushOnLeave()
        }
      }
      let other = remote.roadmapRunner
      var refit: CreateRoadmap.Result?
      if board == "roadmap-sync-set-aside" {
        let rota = ImportedSteps(steps: [ImportedStep(key: "rota", RoadmapStep.Changes(label: "Plan the watch rota", color: "terracotta"))])
        guard case .committed(let planted, _) = try other.runAct(CreateRoadmap(title: "Winter refit", steps: rota)) else {
          throw AppFailure(message: "Winter refit was not planted.")
        }
        refit = planted
        try await sent()
      }
      let sail = try plantLearnToSail(other, done: [])
      try await sent()
      let step = { (key: String) throws -> ID<RoadmapStep> in
        guard let step = sail.steps.first(where: { $0.key == key })?.id else { throw AppFailure(message: "Learn to sail holds no \(key).") }
        return step
      }
      // *Reefing basics* (05.7): a Learn step after *Read the wind* that *Leave the dock* waits on too.
      var reefing: ID<RoadmapStep>?
      if board == "roadmap-sync-came-back" {
        let made = CreateStep(tree: sail.tree, step: RoadmapStep.Changes(label: "Reefing basics", color: "olive",
                                                                         description: "How to reduce sail area safely in stronger wind."),
                              prerequisites: [try step("read")])
        guard case .committed(let planted, _) = try other.runAct(made),
              case .committed = try other.runAct(ChangePrerequisites(tree: sail.tree, step: try step("leave"), add: [planted])) else {
          throw AppFailure(message: "Reefing basics was not planted.")
        }
        reefing = planted
        try await sent()
      }
      if refit != nil {
        for roadmap in [others[2], others[0]] {
          try plant(roadmap, opening: sail.tree, by: other)
          try await sent()
        }
      }
      for step in ["choose", "parts", "rig"] {
        try complete(step, of: sail, by: other)
        try await sent()
      }
      server.state.withLock { $0.pushesReceivedLaterMs = 0 }
      model.preferences.set(sail.tree.description, forKey: RoadmapModel.lastOpen)
      try await model.signIn(identity)
      // The rest is played once the app shows the room, which reads the phone's copy from then on.
      playing = true
      Task { @MainActor in
        defer { retire() }
        do {
          let listed = refit == nil ? 1 : 4
          let steps = reefing == nil ? 8 : 9
          for _ in 0..<600 where room.roadmaps.count < listed || room.shown?.board.overall.total != steps {
            try await Task.sleep(for: .milliseconds(100))
          }

          switch board {
          case "roadmap-sync-offline", "roadmap-sync-landed":
            connection.set(online: false)
            if board == "roadmap-sync-landed" {
              guard case .committed = try other.runAct(DeleteStep(tree: sail.tree, step: try step("read"))) else {
                throw AppFailure(message: "Read the wind was not deleted.")
              }
              try await sent()
            }
            // *Reefing basics* made in the room's own form, as a person makes it, with its receipt in the band.
            room.newStep(from: .foot)
            guard let draft = room.draft, let open = room.shown, let wind = open.step(try step("read").description),
                  let leave = open.step(try step("leave").description) else { throw AppFailure(message: "The form did not open over Learn to sail.") }
            draft.name = "Reefing basics"
            draft.description = "How to reduce sail area safely in stronger wind."
            draft.kind = "olive"
            draft.toggle(wind, in: .requires)
            draft.toggle(leave, in: .opens)
            draft.save()
            guard board == "roadmap-sync-landed" else { return }
            room.endBand()
            connection.set(online: true)
          case "roadmap-sync-came-back":
            guard let reefing else { return }
            guard case .committed = try other.runAct(DeleteStep(tree: sail.tree, step: reefing)) else { throw AppFailure(message: "Reefing basics was not deleted.") }
            try await sent()
            let held = { try? runner.read(sail.tree.tree) { try $0.repository(RoadmapStep.self).find(reefing, in: .drawn) } }
            for _ in 0..<600 where held() != nil { try await Task.sleep(for: .milliseconds(100)) }
            let edit = ChangeStep(tree: sail.tree, step: reefing, changes: RoadmapStep.Changes(description: "Reef early, before the wind builds."))
            guard case .committed = try runner.runAct(edit) else { throw AppFailure(message: "Reefing basics was not edited.") }
          default:
            guard let refit, let rota = refit.steps.first?.id else { return }
            connection.set(online: false)
            guard case .committed = try other.runAct(DeleteRoadmap(tree: refit.tree)) else { throw AppFailure(message: "Winter refit was not deleted.") }
            try await sent()
            let anchor = CreateStep(tree: refit.tree, step: RoadmapStep.Changes(label: "Anchor at night", color: "sky",
                                                                                description: "Drop the hook in the lee of the island before dark."),
                                    prerequisites: [rota])
            guard case .committed = try runner.runAct(anchor) else { throw AppFailure(message: "Anchor at night was not made.") }
            var note = Draft(new: StepNote(id: ID(rota.record)), in: refit.tree.overlay)
            note.current.text = "Two on, two off, from dusk to dawn."
            guard case .saved = runner.save(&note, SaveStepNote.self) else { throw AppFailure(message: "Plan the watch rota's note was not written.") }
            connection.set(online: true)
          }
        } catch {
          NSLog("Roadmap sync fixture failed: %@", String(describing: error))
        }
      }
    } catch {
      NSLog("Roadmap sync fixture failed: %@", String(describing: error))
      model.error = "The roadmap fixture could not be prepared."
    }
  }

  // The boards' *Become a day skipper* (07.1), whose *Learn to sail* opens the roadmap given: *Day skipper theory* and
  // *Pass the first-aid course* done, *Learn to sail* after the theory, *Log 100 miles* and *Night passage* after it, and
  // *Day skipper exam* after both. roadmap-nested-odd and roadmap-nested-subtree are the variation in which *Log 100 miles*
  // and *Night passage* follow the theory alone and the exam all three: the odd one's *Learn to sail* opens a roadmap
  // whose *Sail solo* opens this one back, *Night passage* opens *Night sailing*, which has no steps, and *Log 100 miles* a
  // roadmap no phone holds; the subtree one's *Night passage* owns a subtree of five steps, one done.
  @discardableResult
  static func plantSkipper(opening sail: CreateRoadmap.Result, as board: String, by runner: ActionRunner) throws -> ID<RoadmapEntry> {
    let varied = board == "roadmap-nested-odd" || board == "roadmap-nested-subtree"
    let steps: [(key: String, label: String, color: String, description: String, follows: [String])] = [
      ("theory", "Day skipper theory", "olive", "Navigation, tides and the rules of the road, in a shore course.", []),
      ("aid", "Pass the first-aid course", "terracotta", "A one-day sea survival and first-aid certificate.", []),
      ("sail", "Learn to sail", "sky", "Sail a small boat on my own, start to finish.", ["theory"]),
      ("log", "Log 100 miles", "terracotta", "Record a hundred miles at sea, as crew or skipper.", varied ? ["theory"] : ["sail"]),
      ("night", "Night passage", "olive", "Sail four hours after dark with a skipper aboard.", varied ? ["theory"] : ["sail", "aid"]),
      ("exam", "Day skipper exam", "gold", "Five days aboard with an examiner, then the certificate.", varied ? ["sail", "log", "night"] : ["log", "night"]),
    ]
    let planted = ImportedSteps(
      steps: steps.map { ImportedStep(key: $0.key, RoadmapStep.Changes(label: $0.label, color: $0.color, description: $0.description)) },
      links: steps.flatMap { step in step.follows.map { (from: $0, to: step.key) } })
    guard case .committed(let skipper, _) = try runner.runAct(CreateRoadmap(title: "Become a day skipper", steps: planted)) else {
      throw AppFailure(message: "Become a day skipper was not planted.")
    }
    let id = { (key: String) -> ID<RoadmapStep> in skipper.steps.first { $0.key == key }!.id }
    var overlay = [AnyActAction<RoadmapRefusal>(MarkStep.complete(tree: skipper.tree, step: id("theory"))),
                   AnyActAction(MarkStep.complete(tree: skipper.tree, step: id("aid")))]
    if board != "roadmap-nested-unattached" { overlay.append(AnyActAction(PointStep.set(tree: skipper.tree, step: id("sail"), opens: sail.tree))) }
    if board == "roadmap-nested-odd" {
      guard case .committed(let night, _) = try runner.runAct(CreateRoadmap(title: "Night sailing")) else {
        throw AppFailure(message: "Night sailing was not planted.")
      }
      guard let solo = sail.steps.first(where: { $0.key == "solo" })?.id else { throw AppFailure(message: "Learn to sail holds no Sail solo.") }
      overlay += [AnyActAction(PointStep.set(tree: skipper.tree, step: id("night"), opens: night.tree)),
                  AnyActAction(PointStep.set(tree: skipper.tree, step: id("log"), opens: ID(RecordID("t_00000000000000ff")))),
                  AnyActAction(PointStep.set(tree: sail.tree, step: solo, opens: skipper.tree))]
    }
    guard case .committed = try runner.runComposed(overlay) else { throw AppFailure(message: "Become a day skipper was not marked.") }
    guard board == "roadmap-nested-subtree" else { return skipper.tree }
    guard case .committed(let made, _) = try runner.runAct(CreateSubtree(tree: skipper.tree, step: id("night"))) else {
      throw AppFailure(message: "Night passage's subtree was not made.")
    }
    let lights: [(key: String, label: String, color: String, description: String, follows: [String])] = [
      ("tides", "Read the tide tables", "sky", "Find the evening's high water and the stream it sets.", []),
      ("fit", "Fit the navigation lights", "terracotta", "Check the bow, stern and masthead lights.", ["tides"]),
      ("patterns", "Learn the light patterns", "olive", "Tell a vessel’s heading from its lights.", ["tides"]),
      ("dusk", "Sail at dusk", "terracotta", "Leave an hour before sunset and return in the dark.", ["fit", "patterns"]),
      ("dark", "Four hours after dark", "gold", "A full night passage with a skipper aboard.", ["dusk"]),
    ]
    let inside = ImportedSteps(
      steps: lights.map { ImportedStep(key: $0.key, RoadmapStep.Changes(label: $0.label, color: $0.color, description: $0.description)) },
      links: lights.flatMap { step in step.follows.map { (from: $0, to: step.key) } })
    guard case .committed(let imported, _) = try runner.runAct(ImportSteps(tree: made.subtree, imported: inside)),
          let tides = imported.first(where: { $0.key == "tides" })?.id,
          case .committed = try runner.runAct(MarkStep.complete(tree: made.subtree, step: tides)) else {
      throw AppFailure(message: "Night passage's subtree was not planted.")
    }
    return skipper.tree
  }

  // The backend's sharing requests on a cover's board, where the model server serves sync alone: the owner's progress read
  // from the owner's own phone, the subtrees its steps own counted as the owner's account reads them, and a fork made by
  // another phone of the reader's account, whose copy reaches this phone by sync as the server's does. A launch with
  // `-fork-held` leaves a fork unanswered, as one under way (09.7).
  final class BoardSharing: RoadmapSharing {
    var owner: AppRuntime?
    var reader: AppRuntime?
    var sent: ((AppRuntime) async throws -> Void)?
    // The gallery's rows the board answers, five to a page; none where the gallery cannot be reached.
    var gallery: [GalleryPage.Row]?

    func gallery(after cursor: String?) async throws(SharingFailure) -> GalleryPage {
      guard let gallery else { throw .offline }
      let start = cursor.flatMap { Int($0) } ?? 0
      let end = min(start + 5, gallery.count)
      return GalleryPage(rows: Array(gallery[start..<end]), next: end < gallery.count ? String(end) : nil)
    }

    func progress(of tree: String) async throws(SharingFailure) -> OwnersProgress {
      guard let owner else { throw .failed }
      do {
        let held = { (roadmap: ID<RoadmapEntry>) throws -> RoadmapTree in
          let records = try owner.engine.read(roadmap.tree) { scope in try RoadmapModel.treeTypes.flatMap { try scope.records($0, in: .drawn) } }
          let overlay = try owner.engine.read(roadmap.overlay) { try $0.records(StepMark.type, in: .drawn) }
          return try RoadmapTree(id: roadmap, listed: nil, tree: records, overlay: overlay)
        }
        let shared = try held(ID(RecordID(tree)))
        let subtrees = try shared.nodes.compactMap(\.branch).map { (subtree: String) throws -> RoadmapTree in try held(ID(RecordID(subtree))) }
        let account = RoadmapAccount([shared] + subtrees)
        return OwnersProgress(marks: shared.marks, subtrees: subtrees.compactMap { (subtree: RoadmapTree) -> RoadmapAccount.Told? in
          account.counts(subtree.id).map { RoadmapAccount.Told(tree: subtree.id, counts: $0) }
        })
      } catch {
        throw .failed
      }
    }

    func fork(_ tree: String, request: String, from mode: RoadmapFork.Mode) async throws(SharingFailure) -> String {
      if ProcessInfo.processInfo.arguments.contains("-fork-held") { try? await Task.sleep(for: .seconds(3_600)) }
      guard let owner, let reader, let sent else { throw .signedOut }
      do {
        let source = try owner.engine.read(ID<RoadmapEntry>(RecordID(tree)).tree) { scope in
          try RoadmapTree(id: ID(RecordID(tree)), listed: nil, tree: RoadmapModel.treeTypes.flatMap { try scope.records($0, in: .drawn) }, overlay: nil)
        }
        let steps = ImportedSteps(
          steps: source.nodes.filter(\.present).map {
            ImportedStep(key: $0.id, RoadmapStep.Changes(label: $0.label, color: $0.color, description: $0.description, links: $0.links))
          },
          links: source.edges.filter(\.present).map { (from: $0.from, to: $0.to) })
        guard case .committed(let copy, _) = try reader.roadmapRunner.runAct(CreateRoadmap(title: source.meta?.title ?? "", steps: steps)) else {
          throw SharingFailure.failed
        }
        try await sent(reader)
        return copy.tree.description
      } catch {
        throw .failed
      }
    }
  }

  // The step whose page the room first has open, once it has one: the stack is read again after each change to it.
  static func openedStep(in model: AppModel) async -> String {
    while true {
      if let step = model.roadmap?.path.compactMap(\.step).first { return step }
      await withCheckedContinuation { (changed: CheckedContinuation<Void, Never>) in
        withObservationTracking { _ = model.roadmap?.path } onChange: { changed.resume() }
      }
    }
  }

  // roadmap-undo-finds-nothing (02.10d, 06.5c): once a band stands with its Undo, the engine keeps no Undo of its act, as
  // when the act's Undo is gone by the time it is tapped, so the Undo truly restores nothing: a held removal is let go into
  // the queue, as leaving the app lets it go, and the act's Undo is released. The band is read again after each change.
  static func undoFindsNothing(in model: AppModel) async {
    guard let room = model.roadmap, let runtime = model.runtime else { return }
    while true {
      if let undo = room.band?.undo {
        if undo.held {
          try? runtime.engine.leave()
          runtime.engine.foreground()
        }
        try? runtime.roadmapRunner.release(undo.gesture)
      }
      await withCheckedContinuation { (changed: CheckedContinuation<Void, Never>) in
        withObservationTracking { _ = room.band } onChange: { changed.resume() }
      }
    }
  }

  // The workspace the boards draw on *Read the wind* (03.2, 03.10, 03.11): two subtasks, the first checked, a note
  // and one link, each the planting account's own.
  static func plantWorkspace(of planted: CreateRoadmap.Result, by runner: ActionRunner) throws {
    guard let wind = planted.steps.first(where: { $0.key == "read" })?.id else { throw AppFailure(message: "Learn to sail holds no Read the wind.") }
    let items: [AnyActAction<RoadmapRefusal>] = [
      AnyActAction(AddSubtask(tree: planted.tree, step: wind, item: Subtask.Changes(label: "Watch the telltales for ten minutes", done: true))),
      AnyActAction(AddSubtask(tree: planted.tree, step: wind, item: Subtask.Changes(label: "Check the harbour flag"))),
      AnyActAction(AddStepLink(tree: planted.tree, step: wind, item: WorkspaceLink.Changes(url: "https://rya.org.uk/telltales", title: "Telltale guide"))),
    ]
    guard case .committed = try runner.runComposed(items) else { throw AppFailure(message: "Read the wind's workspace was not planted.") }
    var note = Draft(new: StepNote(id: ID(wind.record)), in: planted.tree.overlay)
    note.current.text = "Gusts show as dark patches on the water. Look upwind before leaving the dock."
    guard case .saved = runner.save(&note, SaveStepNote.self) else { throw AppFailure(message: "Read the wind's note was not planted.") }
  }

  // The boards' *Learn to sail*, as `packages/api-contract/roadmap/layout/learn-to-sail.json` links it, with the link
  // *Read the wind* shares on its page and the steps it draws done completed in that order.
  @discardableResult
  static func plantLearnToSail(_ runner: ActionRunner, done: [String] = ["choose", "parts", "rig"]) throws -> CreateRoadmap.Result {
    let steps: [(key: String, label: String, color: String, description: String, follows: [String])] = [
      ("choose", "Choose a sailing course", "terracotta", "Pick a beginner course near you.", []),
      ("parts", "Name the boat parts", "sky", "Hull, mast, boom, sheets and tiller.", ["choose"]),
      ("rig", "Rig the boat", "terracotta", "Step the mast and run the sheets.", ["parts"]),
      ("read", "Read the wind", "sky", "Learn to spot shifts in wind direction from the water, the telltales and the flag.", ["parts"]),
      ("tie", "Tie a bowline", "olive", "Tie a secure loop that is easy to undo, then practise it with your eyes closed.", ["parts"]),
      ("leave", "Leave the dock", "terracotta", "Cast off safely and steer clear of the dock.", ["rig", "read"]),
      ("tri", "Sail a triangle", "olive", "Practise reaching, tacking and returning to start.", ["leave"]),
      ("solo", "Sail solo", "gold", "Plan and sail a short route on your own.", ["tri", "tie"]),
    ]
    let shared = ["read": [RoadmapDomain.Step.Link(url: "https://metoffice.gov.uk/weather/guides/coast-and-sea/beaufort-scale", label: "Beaufort wind scale")]]
    let planted = ImportedSteps(
      steps: steps.map {
        ImportedStep(key: $0.key, RoadmapStep.Changes(label: $0.label, color: $0.color, description: $0.description, links: shared[$0.key]))
      },
      links: steps.flatMap { step in step.follows.map { (from: $0, to: step.key) } })
    guard case .committed(let created, _) = try runner.runAct(CreateRoadmap(title: "Learn to sail", steps: planted)) else {
      throw AppFailure(message: "Learn to sail was not planted.")
    }
    for step in done { try complete(step, of: created, by: runner) }
    return created
  }

  // The boards' *Coastal navigation handbook*: the 5,000 steps, their links and colours of the layout's shared fixture
  // (`packages/api-contract/roadmap/layout/handbook.json`), read from the repository this build was made in and
  // planted through the domain, so each step's id is the phone's own. Of the 1,800 steps the fixture holds done, the
  // first 120 are marked: signed out, each mark's commit reads everything the phone has still to send.
  @discardableResult
  static func plantHandbook(_ runner: ActionRunner, from file: String = #filePath) throws -> CreateRoadmap.Result {
    struct Handbook: Decodable {
      struct Roadmap: Decodable {
        struct Step: Decodable {
          let id: String
          let label: String
          let color: String
          let follows: [String]
        }

        let steps: [Step]
        let done: [String]
      }

      let roadmap: Roadmap
    }
    var directory = URL(fileURLWithPath: file).deletingLastPathComponent()
    let fixture = "packages/api-contract/roadmap/layout/handbook.json"
    while directory.path != "/" && !FileManager.default.fileExists(atPath: directory.appending(path: fixture).path) {
      directory = directory.deletingLastPathComponent()
    }
    let handbook = try JSONDecoder().decode(Handbook.self, from: Data(contentsOf: directory.appending(path: fixture))).roadmap
    let planted = ImportedSteps(
      steps: handbook.steps.map { ImportedStep(key: $0.id, RoadmapStep.Changes(label: $0.label, color: $0.color)) },
      links: handbook.steps.flatMap { step in step.follows.map { (from: $0, to: step.id) } })
    guard case .committed(let created, _) = try runner.runAct(CreateRoadmap(title: "Coastal navigation handbook", steps: planted)) else {
      throw AppFailure(message: "The handbook was not planted.")
    }
    let done = Set(handbook.done.prefix(120))
    let marks = created.steps.filter { done.contains($0.key) }.map { AnyActAction<RoadmapRefusal>(MarkStep.complete(tree: created.tree, step: $0.id)) }
    guard case .committed = try runner.runComposed(marks) else { throw AppFailure(message: "The handbook's done steps were not marked.") }
    return created
  }

  // *Every harbour in Europe* at the steps the registry lets a roadmap hold (10.6a): a harbour entered, and its berth,
  // which follows it, for each harbour, so half the steps stand Up next and half Locked.
  @discardableResult
  static func plantFull(_ runner: ActionRunner) throws -> CreateRoadmap.Result {
    guard let cap = SyncSchema.registry.type(RoadmapStep.type)?.cap else { throw AppFailure(message: "The registry caps no roadmap's steps.") }
    let harbours = (0..<cap / 2).flatMap { (harbour: Int) -> [ImportedStep] in
      [ImportedStep(key: "enter-\(harbour)", RoadmapStep.Changes(label: "Enter harbour \(harbour + 1)", color: "sky")),
       ImportedStep(key: "berth-\(harbour)", RoadmapStep.Changes(label: "Berth in harbour \(harbour + 1)", color: "terracotta"))]
    }
    let planted = ImportedSteps(steps: harbours, links: (0..<cap / 2).map { (from: "enter-\($0)", to: "berth-\($0)") })
    guard case .committed(let created, _) = try runner.runAct(CreateRoadmap(title: "Every harbour in Europe", steps: planted)) else {
      throw AppFailure(message: "Every harbour in Europe was not planted.")
    }
    return created
  }

  // The roadmaps under *Learn to sail*, by the names All Roadmaps draws: each one's steps in order, and how many of the
  // first are done. They are far smaller than the boards count them, and roadmap-several takes the first two alone,
  // since a phone's engine takes longer over every roadmap its account holds.
  static let others: [(title: String, steps: [String], done: Int)] = [
    ("Spanish B1", ["Order at a café", "Describe your day", "Talk about last weekend", "Meet the subjunctive", "Tell a story", "Give advice",
                    "Pass the B1 mock exam"], 2),
    ("Become a day skipper", ["Crew a weekend", "Learn to sail", "Skipper a day sail"], 1),
    ("Coastal navigation handbook", ["Read a chart", "Plot a course", "Take a fix", "Plan a passage"], 3), ("Ship v1", ["Cut the scope", "Ship it"], 1),
    ("Run a 10k", ["Run 5k", "Run 10k"], 1), ("Room makeover", ["Pick a palette"], 0), ("Personal finance reset", ["List every account"], 1),
    ("Learn watercolor", ["Mix a wash", "Paint a sky"], 1),
  ]

  // One of those roadmaps, each step following the one before. *Spanish B1* is linked, coloured and described as its
  // Board draws it on 01.11: two steps up next after the second, and three locked behind them. The second step of
  // *Become a day skipper*, *Learn to sail*, opens the roadmap given by its pointer.
  @discardableResult
  static func plant(_ roadmap: (title: String, steps: [String], done: Int), opening sail: ID<RoadmapEntry>, by runner: ActionRunner) throws -> CreateRoadmap.Result {
    var steps = roadmap.steps.enumerated().map { (place: Int, label: String) -> (label: String, color: String, description: String, follows: [Int]) in
      (label, "terracotta", "", place == 0 ? [] : [place - 1])
    }
    if roadmap.title == "Spanish B1" {
      steps[2] = ("Talk about last weekend", "terracotta", "Use both past tenses in a five-minute chat about what you did.", [1])
      steps[3] = ("Meet the subjunctive", "olive", "Learn the ten phrases that always take the subjunctive.", [1])
      steps[4] = ("Tell a story", "terracotta", "Tell a two-minute story about a trip, from start to finish.", [2])
      steps[5] = ("Give advice", "olive", "Suggest, recommend and warn without sounding like a textbook.", [3])
      steps[6] = ("Pass the B1 mock exam", "gold", "Sit a full mock paper under exam conditions.", [4, 5])
    }
    let planted = ImportedSteps(
      steps: steps.enumerated().map { ImportedStep(key: String($0.offset), RoadmapStep.Changes(label: $0.element.label, color: $0.element.color, description: $0.element.description)) },
      links: steps.enumerated().flatMap { step in step.element.follows.map { (from: String($0), to: String(step.offset)) } })
    guard case .committed(let created, _) = try runner.runAct(CreateRoadmap(title: roadmap.title, steps: planted)) else {
      throw AppFailure(message: "\(roadmap.title) was not planted.")
    }
    // Its marks and its pointer are one act, so the account receives them in one sending.
    var overlay = created.steps.prefix(roadmap.done).map { AnyActAction<RoadmapRefusal>(MarkStep.complete(tree: created.tree, step: $0.id)) }
    if roadmap.title == "Become a day skipper" { overlay.append(AnyActAction(PointStep.set(tree: created.tree, step: created.steps[1].id, opens: sail))) }
    guard !overlay.isEmpty else { return created }
    guard case .committed = try runner.runComposed(overlay) else { throw AppFailure(message: "\(roadmap.title) was not marked.") }
    return created
  }

  // The boards' guides: *Learn to sail*'s, as 08.1 draws it, or a long one that ends as 08.3 draws it and stands 15
  // characters short of the domain's 5,000, so the 27 of *, then tie up without help.* take it 12 over (08.4); and *Become
  // a day skipper*'s.
  enum Guides {
    static let sail = "Maya and I take the dinghy out on Sundays. This month I want to rig it, leave the dock and get us home without her taking the tiller.\n\nI mark a step done after I’ve tried it on the water. If the wind picks up, we practise reefing and leave docking for next time. Suggest one new step per sail."
    static let long: String = {
      let end = "Read the wind. Before we move the boat, take a minute to look across the water. I’ve been watching the flag by the slip and forgetting that the water farther out may look different.\n\nRig the boat. I’d like to do a complete setup with Maya nearby and enough time to start over. I keep a small list in the boat bag because I tend to skip a check when somebody is waiting at the ramp.\n\nNext Sunday, practise coming alongside the dock."
      let earlier = String(repeating: "Write down one thing the water taught us after every sail, and one thing to try next time. ", count: 60)
      return String(earlier.prefix(RoadmapSpecs.guide.max - 15 - end.count - 2)) + "\n\n" + end
    }()
    static let skipper = "Day skipper by September. Theory first, then sea time: weekends are for the water, one evening a week is for the books."
  }

  // A roadmap's guide, written as its account writes it.
  static func write(_ guide: String, on tree: ID<RoadmapEntry>, by runner: ActionRunner) throws {
    guard case .committed = try runner.runAct(WriteRoadmap(tree: tree, guide: guide)) else { throw AppFailure(message: "The guide was not written.") }
  }

  // One planted step marked done, by the key it was planted under.
  // roadmap-coach-history's conversations, each asked and answered at its moment by the board's clock, for History (Roadmap
  // · iOS 11.7): two about *Learn to sail*'s *Read the wind*, today and yesterday, one about every roadmap today, and two
  // about *Spanish B1* and *Become a day skipper*, planted beside it, days before.
  static func converse(about sail: CreateRoadmap.Result, spanish: ID<RoadmapEntry>, skipper: ID<RoadmapEntry>, clock: SteppingBoardClock,
                       by runner: ActionRunner) throws {
    let wind = sail.steps.first { $0.key == "read" }?.id.description
    let hour: Int64 = 3_600_000, day = 24 * hour
    let asked: [(question: String, tree: ID<RoadmapEntry>?, step: String?, at: Int64)] = [
      ("Tidy this roadmap", skipper, nil, -5 * day), ("Is five a week too much?", spanish, nil, -3 * day),
      ("How do I start?", sail.tree, wind, -day), ("Which roadmap first?", nil, nil, -3 * hour), ("Add a subtask: check the tide", sail.tree, wind, -hour),
    ]
    for each in asked {
      clock.step(to: each.at)
      guard case .committed(let turn, _) = try runner.runAct(RoadmapDomain.OpenTurn(about: .init(treeId: each.tree?.description, stepId: each.step),
                                                                                    question: each.question)),
            case .committed = try runner.runAct(RoadmapDomain.EndTurn(turn.coach, state: .completed, text: "Start with the first open step.")) else {
        throw AppFailure(message: "A conversation was not planted.")
      }
    }
  }

  static func complete(_ key: String, of planted: CreateRoadmap.Result, by runner: ActionRunner) throws {
    guard let step = planted.steps.first(where: { $0.key == key })?.id,
          case .committed = try runner.runAct(MarkStep.complete(tree: planted.tree, step: step)) else {
      throw AppFailure(message: "Learn to sail's \(key) was not marked done.")
    }
  }

  // The board's clock for the fixture's other phone, stepped forward as the fixture makes each sending, so writes it makes
  // one after another stand in that order by the device's time, as they do by the server's, or back to the day a planted
  // conversation was had.
  nonisolated final class SteppingBoardClock: WallClock {
    private let later = Mutex<Int64>(0)

    func step(to ms: Int64) { later.withLock { $0 = ms } }

    func nowMs() -> Int64 { BoardClock().nowMs() + later.withLock { $0 } }

    func reading() -> ClockReading {
      let board = BoardClock().reading()
      return ClockReading(wall: nowMs(), mono: board.mono, boot: board.boot)
    }
  }
  #endif
}
