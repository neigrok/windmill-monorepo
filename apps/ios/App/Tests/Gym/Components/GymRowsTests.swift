import Observation
import SwiftUI
import Testing
import UIKit
import DomainKit
import DomainKitTesting
import GymDomain
import SyncCore
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct GymRowsTests {
  @Test func aSessionsTilesDrawTheFactsItsReadoutKnowsWithLabelsThatAgree() {
    let start = Instant(ms: 1_790_164_800_000)
    let set = { (id: String, kg: Double) in
      TrainingSet(id: ID(RecordID(id)), sessionId: ID("push"), exerciseId: ID("bench-press"), weightKg: kg, reps: 5, completedAt: start)
    }
    var session = Session(id: ID("push"), startedAt: start, finishedAt: Instant(ms: start.ms + 3_780_000))
    #expect(FactTiles(SessionReadout(session: session, sets: [set("1", 80)], catalogue: Catalogue(custom: [], names: []))).facts == [
      .init(value: "1h 03m", label: "Duration"), .init(value: "1", label: "Working set"), .init(value: "400 kg", label: "Volume"),
    ])
    session.finishedAt = nil
    #expect(FactTiles(SessionReadout(session: session, sets: [set("1", 80), set("2", 82.5)], catalogue: Catalogue(custom: [], names: []))).facts == [
      .init(value: "2", label: "Working sets"), .init(value: "812.5 kg", label: "Volume"),
    ])
  }

  // A finished set reads its place and numbers, then what it says against the plan, then its effort and note, as one line.
  @Test func aSetRowReadsAsOneLine() {
    var set = TrainingSet(id: ID("set"), sessionId: ID("push"), exerciseId: ID("bench-press"), weightKg: 100, reps: 5, completedAt: Instant(ms: 0))
    #expect(SetRow(marker: "1", set: set).spoken == "1 · 100 × 5")
    set.weightKg = 90; set.rpe = 8; set.note = "Smooth last set."
    #expect(SetRow(marker: "1", set: set, caption: "+30 over plan").spoken == "1 · 90 × 5, +30 over plan, RPE 8 · Smooth last set.")
    #expect(SetRow(marker: "2", set: set, time: "9:41", reading: .columns).spoken == "2 · 90 × 5, 9:41 · RPE 8 · Smooth last set.")
  }

  @Test func everyDoorThatDiscardsAWorkoutAsksInTheBoardsWords() {
    #expect([0, 1, 5].map(DestructiveQuestion.workoutMessage(sets:)) == [
      "This deletes the workout. You can’t undo this.",
      "This deletes the workout and its 1 set. You can’t undo this.",
      "This deletes the workout and its 5 sets. You can’t undo this.",
    ])
  }

  // The question as the log, a workout's detail and its receipt ask it, hosted in a window: Cancel leaves the workout and
  // records the cancel, and only Discard removes it. Inspect's stranded sets ask the same way as a dialog.
  @Test(arguments: [false, true]) func aDestructiveDoorAsksFirstAndCancelKeepsTheWorkout(dialog: Bool) async throws {
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let telemetry = TelemetryRecorder(), gym = GymModel(runner: harness.runner, telemetry: telemetry)
    let id = gym.runner.mint(Session.self), started = Instant(ms: 1_790_420_000_000)
    let set = ImportedSet(id: gym.runner.mint(TrainingSet.self), exerciseId: ID("bench-press"), weightKg: 60, reps: 5,
                          completedAt: Instant(ms: started.ms + 600_000))
    #expect(gym.run(ImportSession(id: id, startedAt: started, finishedAt: Instant(ms: started.ms + 2_000_000), sets: [set]))?.refusal == nil)
    let asking = Asking()
    let door = Color.clear.destructiveQuestion(gym, screen: "log", title: "Discard this workout?", message: DestructiveQuestion.workoutMessage(sets: 1),
                                               act: "Discard", dialog: dialog, isPresented: Binding(get: { asking.shown }, set: { asking.shown = $0 })) {
      gym.run(DiscardSession(id))
    }
    let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    window.frame = scene.screen.bounds
    window.rootViewController = UIHostingController(rootView: door)
    window.makeKeyAndVisible()
    defer { window.rootViewController?.dismiss(animated: false); window.isHidden = true; window.rootViewController = nil }
    let host = try #require(window.rootViewController)
    window.layoutIfNeeded(); try await Task.sleep(for: .milliseconds(50))
    let events = { telemetry.entries.withLock { $0.filter { $0.properties["screen"] == "log" }.map(\.properties) } }

    asking.shown = true
    var question = try await presented(over: host)
    #expect(question.title == "Discard this workout?" && question.message == "This deletes the workout and its 1 set. You can’t undo this.")
    #expect(question.actions.map(\.title) == ["Discard", "Cancel"] && question.actions.map(\.style) == [.destructive, .cancel])
    try await press("Cancel", in: question, over: host)
    #expect(!asking.shown && gym.sessions.map(\.id) == [id])
    #expect(events() == [["screen": "log", "action": "discard", "state": "shown"], ["screen": "log", "action": "cancel", "outcome": "cancelled"]])

    asking.shown = true
    question = try await presented(over: host)
    try await press("Discard", in: question, over: host)
    #expect(!asking.shown && gym.sessions.isEmpty)
    #expect(events().count == 3 && events().last == ["screen": "log", "action": "discard", "state": "shown"])
  }

  func presented(over host: UIViewController) async throws -> UIAlertController {
    for _ in 0..<200 {
      if let question = host.presentedViewController as? UIAlertController, !question.isBeingPresented { return question }
      try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("No question was asked over \(host)")
    throw CancellationError()
  }

  // Answers the question as a tap does: the button's own handler, then the dismissal that closes it.
  func press(_ title: String, in question: UIAlertController, over host: UIViewController) async throws {
    typealias Handler = @convention(block) (UIAlertAction) -> Void
    let action = try #require(question.actions.first { $0.title == title })
    let handler = try #require(action.value(forKey: "handler") as AnyObject?)
    unsafeBitCast(handler, to: Handler.self)(action)
    if host.presentedViewController === question { question.dismiss(animated: false) }
    for _ in 0..<200 where host.presentedViewController != nil { try await Task.sleep(for: .milliseconds(10)) }
    try await Task.sleep(for: .milliseconds(20))
  }
}

@Observable @MainActor final class Asking {
  var shown = false
}
