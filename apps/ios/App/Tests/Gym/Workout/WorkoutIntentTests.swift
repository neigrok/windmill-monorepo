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

  // A movement this phone cannot name is left out of the answer, never given a stand-in.
  @Test func aLoggedSetWhoseMovementHasNoNameIsSaidWithItsNumbersAlone() {
    let offer = WorkoutActivityOffer(ownerID: "owner", sessionID: "session", movementID: "not-on-this-phone", weightKg: 60, reps: 1, setID: "set")
    #expect([WorkoutLogAnswer.loggedSet(offer, movement: nil), .loggedSet(offer, movement: "Workout squat")] == [
      .logged(shown: "Logged 60 kg × 1.", spoken: "Logged 60 kilograms, 1 rep."),
      .logged(shown: "Logged 60 kg × 1 · Workout squat.", spoken: "Logged 60 kilograms, 1 rep, Workout squat."),
    ])
  }

  @Test func logSetShortcutWithNoWorkoutOpenAnswersAndOpensNothing() async throws {
    let recorder = TelemetryRecorder(), app = try app(recorder), room = app.selectedRoom, welcome = app.welcome
    let answer = await handling(app) { await WorkoutActivityIntentHandler.logSet(offer: nil, surface: .shortcut) }, said = answer.dialog(.shortcut)
    #expect(answer == .absent && [said.shown, said.spoken] == ["No workout is open.", "No workout is open."])
    #expect(app.selectedRoom == room && app.welcome == welcome && !app.routinesRequested && app.gym.sets.isEmpty)
    #expect(outsideEvents(recorder) == ["gym_activity_offer_refused outcome=absent surface=shortcut"])
  }

  @Test func logSetShortcutWithNothingOnOfferBringsTheHiddenWorkoutBack() async throws {
    let recorder = TelemetryRecorder(), app = try app(recorder), workout = try fixtures.begin(app.gym)
    #expect(app.gym.hideWorkout() && !workout.isPresented)
    let answer = await handling(app) { await WorkoutActivityIntentHandler.logSet(offer: nil, surface: .shortcut) }, said = answer.dialog(.shortcut)
    #expect(answer == .opened && [said.shown, said.spoken] == ["Nothing logged. Opening Windmill.", "Nothing logged. Opening Windmill."])
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
}
