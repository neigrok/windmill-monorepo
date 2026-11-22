import Foundation
import DomainKit
import RoadmapDomain

// Simulator boards. An account's roadmaps arriving by sync: roadmap-learn-to-sail (three steps done), roadmap-all-done
// (all eight), roadmap-no-steps (*Night sailing*, with no step) and roadmap-several (*Learn to sail* over two more, the
// most recent first). On a phone never signed in: roadmap-many, the nine roadmaps All Roadmaps draws, in no order a
// server gave them, and roadmap-empty, which holds none. roadmap-unreadable cannot make its views.
enum RoadmapFixture {
  // The engine's views of every record of a type in a scope, visible or not, as the room's model takes them.
  static func records(_ runtime: AppRuntime) -> RoadmapModel.Records {
    #if DEBUG && targetEnvironment(simulator)
    if runtime.settings.board == "roadmap-unreadable" { return { _, _ in throw AppFailure(message: "The board's views cannot be made.") } }
    #endif
    return { scope, type in try runtime.engine.records(scope, type, .drawn, visibleOnly: false) }
  }

  static func prepare(_ board: String, model: AppModel) async -> Bool {
    #if DEBUG && targetEnvironment(simulator)
    guard board.hasPrefix("roadmap-") else { return false }
    model.openRoom(.roadmap)
    // The steps of *Learn to sail* each board's account completed, the oldest first.
    let completed = ["roadmap-learn-to-sail": ["choose", "parts", "rig"], "roadmap-several": ["choose", "parts", "rig"],
                     "roadmap-all-done": ["choose", "parts", "rig", "read", "tie", "leave", "tri", "solo"]][board]
    guard completed != nil || ["roadmap-no-steps", "roadmap-many"].contains(board) else { return true }
    do {
      // roadmap-many is made on the phone itself, signed out, with *Learn to sail* remembered as the roadmap last open.
      if board == "roadmap-many" {
        guard let runner = model.runtime?.roadmapRunner else { throw AppFailure(message: "no runtime") }
        let sail = try plantLearnToSail(runner).tree
        model.preferences.set(sail.description, forKey: RoadmapModel.lastOpen)
        for roadmap in others { try plant(roadmap, opening: sail, by: runner) }
        return true
      }
      guard let server = model.runtime?.auth.fake else { throw AppFailure(message: "no model server") }
      let identity = server.identity(email: "roadmap-fixture@example.com")
      let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: directory) }
      let remote = try AppRuntime(settings: AppSettings(arguments: ["fixture", "-model-server", "-board", board]),
                                  directory: directory, service: UUID().uuidString, syncTransport: server)
      defer { try? remote.tokens.delete(for: identity.account) }
      _ = try await remote.engine.signIn(account: identity.account, token: identity.token)
      // The board's clock stands still, so the server receives each sending a second after the one before: Done, newest
      // first, and the account's roadmaps, most recent first, have an order.
      var sendings: Int64 = 0
      let sent = { () async throws -> Void in
        server.state.withLock { $0.pushesReceivedLaterMs = sendings * 1_000 }
        sendings += 1
        try remote.engine.leave()
        for _ in 0..<40 where try remote.store.read({ try $0.device().activeReplica.outbox.contains { $0.state != .acked } }) {
          await remote.engine.flushOnLeave()
        }
      }
      if let completed {
        let sail = try plantLearnToSail(remote.roadmapRunner, done: [])
        try await sent()
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
      server.state.withLock { $0.pushesReceivedLaterMs = 0 }
      try await model.signIn(identity)
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
  #endif
}
