import Foundation
import DomainKit
import Synchronization
import RoadmapDomain
import SyncCore
import SyncEngine
import SyncSchema

// Simulator boards. An account's roadmaps arriving by sync: roadmap-learn-to-sail (three steps done), roadmap-all-done
// (all eight), roadmap-no-steps (*Night sailing*, with no step), roadmap-several (*Learn to sail* over two more, the
// most recent first), roadmap-workspace (*Learn to sail* with the workspace the boards draw on *Read the wind*),
// roadmap-two-phones (*Learn to sail*, where the account's other phone adds a subtask to the first step whose page is
// opened) and roadmap-first-read (*Learn to sail*, each pull of the signed-in phone answered three seconds late, so the
// room's first read runs long). On a phone never signed in: roadmap-many, the nine roadmaps All Roadmaps draws, in no
// order a server gave them; roadmap-handbook, the 5,000 steps the Graph's and the Board's budget is measured at;
// roadmap-full, a roadmap at the steps the registry lets it hold; roadmap-undo-finds-nothing, *Learn to sail*, where
// the engine keeps no Undo of a band's act by the time it is tapped (`undoFindsNothing(in:)`); and roadmap-empty, which
// holds none.
// roadmap-unreadable cannot make its views. A launch can also name where the Graph's measures go and how it keeps a
// pinch's frames (`graph(telemetry:)`), where the Board's go (`boardFrames()`), and how long a band stands (`wait()`).
enum RoadmapFixture {
  // The engine's views of every record of a type in a scope, visible or not, as the room's model takes them.
  static func records(_ runtime: AppRuntime) -> RoadmapModel.Records {
    #if DEBUG && targetEnvironment(simulator)
    if runtime.settings.board == "roadmap-unreadable" { return { _, _ in throw AppFailure(message: "The board's views cannot be made.") } }
    #endif
    return { scope, type in try runtime.engine.records(scope, type, .drawn, visibleOnly: false) }
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

  static func prepare(_ board: String, model: AppModel) async -> Bool {
    #if DEBUG && targetEnvironment(simulator)
    guard board.hasPrefix("roadmap-") else { return false }
    model.openRoom(.roadmap)
    // The steps of *Learn to sail* each board's account completed, the oldest first.
    let completed = ["roadmap-learn-to-sail": ["choose", "parts", "rig"], "roadmap-several": ["choose", "parts", "rig"],
                     "roadmap-workspace": ["choose", "parts", "rig"], "roadmap-two-phones": ["choose", "parts", "rig"],
                     "roadmap-first-read": ["choose", "parts", "rig"],
                     "roadmap-all-done": ["choose", "parts", "rig", "read", "tie", "leave", "tri", "solo"]][board]
    let local = ["roadmap-many", "roadmap-handbook", "roadmap-full", "roadmap-undo-finds-nothing"]
    guard completed != nil || board == "roadmap-no-steps" || local.contains(board) else { return true }
    do {
      // roadmap-many, roadmap-handbook, roadmap-full and roadmap-undo-finds-nothing are made on the phone itself, signed
      // out: the first with *Learn to sail* remembered as the roadmap last open, the others holding their one roadmap alone.
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
        if board == "roadmap-workspace" {
          try plantWorkspace(of: sail, by: remote.roadmapRunner)
          try await sent()
        }
        for step in completed.dropLast() {
          try complete(step, of: sail, by: remote.roadmapRunner)
          try await sent()
        }
        // roadmap-several's two roadmaps under *Learn to sail* arrive before its last completion, the lower first.
        if board == "roadmap-several" {
          for roadmap in others.prefix(2).reversed() {
            try plant(roadmap, opening: sail.tree, by: remote.roadmapRunner)
            try await sent()
          }
        }
        if let last = completed.last {
          try complete(last, of: sail, by: remote.roadmapRunner)
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
      try await model.signIn(identity)
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
  static func plant(_ roadmap: (title: String, steps: [String], done: Int), opening sail: ID<RoadmapEntry>, by runner: ActionRunner) throws {
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
    guard !overlay.isEmpty else { return }
    guard case .committed = try runner.runComposed(overlay) else { throw AppFailure(message: "\(roadmap.title) was not marked.") }
  }

  // One planted step marked done, by the key it was planted under.
  static func complete(_ key: String, of planted: CreateRoadmap.Result, by runner: ActionRunner) throws {
    guard let step = planted.steps.first(where: { $0.key == key })?.id,
          case .committed = try runner.runAct(MarkStep.complete(tree: planted.tree, step: step)) else {
      throw AppFailure(message: "Learn to sail's \(key) was not marked done.")
    }
  }

  // The board's clock for the fixture's other phone, stepped forward as the fixture makes each sending, so writes it makes
  // one after another stand in that order by the device's time, as they do by the server's.
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
