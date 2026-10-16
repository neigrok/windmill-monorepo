import Foundation
import Testing
import DomainKit
import GymDomain
import SyncCore
@testable import Windmill

@Suite(.serialized) @MainActor struct WorkoutIntentTests {
  let fixtures = WorkoutStateTests()
  static let outside: Set<String> = ["gym_activity_set_logged", "gym_activity_offer_refused", "gym_intent_opened"]

  func outsideEvents(_ recorder: TelemetryRecorder) -> [String] {
    recorder.entries.withLock { entries in
      entries.filter { Self.outside.contains($0.name) }.map { entry in
        ([entry.name] + entry.properties.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }).joined(separator: " ")
      }
    }
  }

  func handling<Result>(_ app: AppModel?, presented: Bool = true, _ body: () async throws -> Result) async rethrows -> Result {
    let previous = (WorkoutActivityIntentHandler.model, WorkoutActivityIntentHandler.presented, WorkoutActivityIntentHandler.waiting)
    WorkoutActivityIntentHandler.model = app; WorkoutActivityIntentHandler.presented = presented; WorkoutActivityIntentHandler.waiting = nil
    defer { (WorkoutActivityIntentHandler.model, WorkoutActivityIntentHandler.presented, WorkoutActivityIntentHandler.waiting) = previous }
    return try await body()
  }

  func app(_ recorder: TelemetryRecorder) throws -> AppModel {
    let (harness, _) = try fixtures.fixture(telemetry: recorder), suite = "workout-intents-" + UUID().uuidString
    return try AppModel(runner: harness.runner, preferences: UserDefaults(suiteName: suite)!, telemetry: recorder)
  }

  @Test(arguments: [(100.0, 5, "Logged 100 kg × 5 · Workout squat.", "Logged 100 kilograms, 5 reps, Workout squat."),
                    (82.5, 1, "Logged 82.5 kg × 1 · Workout squat.", "Logged 82.5 kilograms, 1 rep, Workout squat.")])
  func logSetShortcutLogsTheRackOnceAndAnswersWithIt(_ rack: (weightKg: Double, reps: Int, shown: String, spoken: String)) async throws {
    let (weightKg, reps, shown, spoken) = rack
    let recorder = TelemetryRecorder(), app = try app(recorder), room = app.selectedRoom, workout = try fixtures.begin(app.gym)
    workout.weightKg = weightKg; workout.reps = reps
    let offer = try #require(workout.activityOffer())
    let answer = await handling(app) { await WorkoutActivityIntentHandler.logSet(offer: nil, surface: .shortcut) }
    #expect(answer == .logged(shown: shown, spoken: spoken))
    #expect(await handling(app) { await WorkoutActivityIntentHandler.logSet(offer: offer, surface: .activity) } == .logged(
      shown: shown, spoken: spoken))
    #expect(workout.sets.map { "\($0.id.description) \($0.exerciseId.description) \($0.weightKg) × \($0.reps) \($0.kind)" }
      == ["\(offer.setID) workout-squat \(weightKg) × \(reps) working"])
    #expect(outsideEvents(recorder) == ["gym_activity_set_logged surface=shortcut"])
    #expect(app.selectedRoom == room)
  }

  @Test func logSetShortcutWithNoWorkoutOpenAnswersAndOpensNothing() async throws {
    let recorder = TelemetryRecorder(), app = try app(recorder), room = app.selectedRoom, welcome = app.welcome
    #expect(await handling(app) { await WorkoutActivityIntentHandler.logSet(offer: nil, surface: .shortcut) } == .absent)
    #expect(app.selectedRoom == room && app.welcome == welcome && !app.routinesRequested && app.gym.sets.isEmpty)
    #expect(outsideEvents(recorder) == ["gym_activity_offer_refused outcome=absent surface=shortcut"])
  }

  @Test func logSetShortcutWithNothingOnOfferBringsTheHiddenWorkoutBack() async throws {
    let recorder = TelemetryRecorder(), app = try app(recorder), workout = try fixtures.begin(app.gym)
    #expect(app.gym.hideWorkout() && !workout.isPresented)
    #expect(await handling(app) { await WorkoutActivityIntentHandler.logSet(offer: nil, surface: .shortcut) } == .opened)
    #expect(app.selectedRoom == .gym && !app.welcome && !app.gym.workoutHidden && workout.isPresented && workout.sets.isEmpty)
    #expect(outsideEvents(recorder) == ["gym_intent_opened intent=open_workout surface=shortcut"])
  }

  @Test func startWorkoutOpensRoutinesAtItsRootAndLeavesAnOpenSheet() async throws {
    let recorder = TelemetryRecorder(), app = try app(recorder)
    app.sheet = .you
    await handling(app) { WorkoutActivityIntentHandler.open(.routines, surface: .shortcut) }
    #expect(app.selectedRoom == .gym && !app.welcome && app.routinesRequested && app.sheet == .you && app.gym.openSession == nil)
    #expect(outsideEvents(recorder) == ["gym_intent_opened intent=start_workout surface=shortcut"])
  }

  @Test func startWorkoutWhileAWorkoutIsOpenOpensTheLogger() async throws {
    let recorder = TelemetryRecorder(), app = try app(recorder), workout = try fixtures.begin(app.gym)
    #expect(app.gym.hideWorkout())
    await handling(app) { WorkoutActivityIntentHandler.open(.routines, surface: .shortcut) }
    #expect(app.selectedRoom == .gym && !app.routinesRequested && !app.gym.workoutHidden && workout.isPresented)
    #expect(outsideEvents(recorder) == ["gym_intent_opened intent=open_workout surface=shortcut"])
  }

  @Test func aDoorAskedForBeforeTheFirstScreenWaitsForIt() async throws {
    let recorder = TelemetryRecorder(), app = try app(recorder), welcome = app.welcome
    await handling(nil, presented: false) {
      WorkoutActivityIntentHandler.open(.routines, surface: .shortcut)
      #expect(app.welcome == welcome && !app.routinesRequested && outsideEvents(recorder).isEmpty)
      WorkoutActivityIntentHandler.present(app)
      #expect(WorkoutActivityIntentHandler.waiting == nil)
    }
    #expect(app.selectedRoom == .gym && !app.welcome && app.routinesRequested)
    #expect(outsideEvents(recorder) == ["gym_intent_opened intent=start_workout surface=shortcut"])
  }

  func board() -> WorkoutControlBoard {
    WorkoutControlBoard(url: FileManager.default.temporaryDirectory.appending(path: "workout-control-\(UUID().uuidString).json"))
  }

  @Test func theControlFollowsTheWorkoutFromOpenToHiddenToFinished() async throws {
    let recorder = TelemetryRecorder(), app = try app(recorder), board = board()
    let controller = WorkoutActivityController(gym: app.gym, board: board)
    defer { try? FileManager.default.removeItem(at: board.url) }
    await controller.reconcile()
    #expect(board.read() == .startWorkout)
    let workout = try fixtures.begin(app.gym), session = try #require(workout.session)
    workout.weightKg = 100; workout.reps = 5
    await controller.reconcile()
    let offer = try #require(workout.activityOffer()), staleAt = try controller.clocks(session).staleAt
    #expect(board.read() == .logSet(WorkoutControlOffer(offer: offer, value: "100 × 5"), staleAt: staleAt))
    #expect(await handling(app) { await WorkoutActivityIntentHandler.logSet(offer: offer, surface: .control) } == .logged(
      shown: "Logged 100 kg × 5 · Workout squat.", spoken: "Logged 100 kilograms, 5 reps, Workout squat."))
    await controller.reconcile()
    let next = try #require(workout.activityOffer()), nextStaleAt = try controller.clocks(session).staleAt
    #expect(next.setID != offer.setID)
    #expect(board.read() == .logSet(WorkoutControlOffer(offer: next, value: "100 × 5"), staleAt: nextStaleAt))
    #expect(app.gym.hideWorkout())
    await controller.reconcile()
    #expect(board.read() == .openWorkout(staleAt: nextStaleAt))
    #expect(app.gym.restoreWorkout())
    await workout.finish()
    app.refresh(); await controller.reconcile()
    #expect(app.gym.openSession == nil && board.read() == .startWorkout)
    #expect(outsideEvents(recorder) == ["gym_activity_set_logged surface=control"])
    #expect(recorder.entries.withLock { $0.filter { $0.name == "client_error" }.isEmpty })
  }

  @Test func theControlsOpenAndStartTakeStartWorkoutsDoor() async throws {
    let recorder = TelemetryRecorder(), app = try app(recorder)
    await handling(app) { WorkoutActivityIntentHandler.open(.routines, surface: .control) }
    #expect(app.selectedRoom == .gym && app.routinesRequested)
    app.routinesRequested = false
    let workout = try fixtures.begin(app.gym)
    #expect(app.gym.hideWorkout())
    await handling(app) { WorkoutActivityIntentHandler.open(.routines, surface: .control) }
    #expect(!app.routinesRequested && !app.gym.workoutHidden && workout.isPresented)
    #expect(outsideEvents(recorder) == ["gym_intent_opened intent=start_workout surface=control",
                                        "gym_intent_opened intent=open_workout surface=control"])
  }

  @Test func aControlStateTheAppCannotWriteReportsOnceUntilItChanges() async throws {
    let recorder = TelemetryRecorder(), app = try app(recorder)
    let unwritable = WorkoutActivityController(gym: app.gym, board: WorkoutControlBoard(url: URL(filePath: "/nonexistent/workout-control.json")))
    await unwritable.reconcile(); await unwritable.reconcile()
    let missing = WorkoutActivityController(gym: app.gym, board: nil)
    await missing.reconcile(); await missing.reconcile()
    _ = try fixtures.begin(app.gym)
    await unwritable.reconcile()
    #expect(recorder.entries.withLock { $0.filter { $0.name == "client_error" }.map(\.properties) } == [
      ["operation": "gym_control_update", "failure_kind": "storage"], ["operation": "gym_control_update", "failure_kind": "unexpected"],
      ["operation": "gym_control_update", "failure_kind": "storage"]])
  }
}
