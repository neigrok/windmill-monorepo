import Foundation
import Testing
import Synchronization
import DomainKit
import GymDomain
import SyncCore
import SyncStore
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

  // The room a door from outside brings forward is the room the next launch opens, even one already in front.
  @Test(arguments: [WorkoutDoor.routines, .workout]) func theRoomAnOutsideDoorOpensIsTheNextLaunchsRoom(_ door: WorkoutDoor) async throws {
    let recorder = TelemetryRecorder(), app = try app(recorder)
    #expect(app.selectedRoom == .journal && app.preferences.string(forKey: "lastRoom") == nil)
    await handling(app) { WorkoutActivityIntentHandler.open(door, surface: .shortcut) }
    #expect(app.preferences.string(forKey: "lastRoom") == "gym")
    let relaunched = try AppModel(runner: app.runner, preferences: app.preferences, telemetry: recorder)
    #expect(relaunched.selectedRoom == .gym && !relaunched.welcome)
    app.preferences.removeObject(forKey: "lastRoom")
    await handling(app) { WorkoutActivityIntentHandler.open(door, surface: .shortcut) }
    #expect(app.selectedRoom == .gym && app.preferences.string(forKey: "lastRoom") == "gym")
  }

  // A Log set the phone could not save logs nothing, opens the logger and is recorded as failed.
  @Test func anOutsideLogSetThePhoneCannotSaveIsRecordedFailed() async throws {
    let fault = GymStoreFault(), recorder = TelemetryRecorder()
    let app = try LineageFlowTests().fixture(JournalModelTransport(), crashPoints: CrashPoints { point in
      if fault.point.withLock({ $0 == point }) { throw AppFailure(message: "private-fault-marker") }
    }, telemetry: recorder)
    #expect(app.gym.run(CreateExercise(Exercise(id: fixtures.first, name: "Workout squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    let workout = try fixtures.begin(app.gym), offer = try #require(workout.activityOffer())
    recorder.entries.withLock { $0.removeAll() }
    fault.point.withLock { $0 = .beforeCommit(.commit) }
    let shortcut = await handling(app) { await WorkoutActivityIntentHandler.logSet(offer: nil, surface: .shortcut) }
    let activity = await handling(app) { await WorkoutActivityIntentHandler.logSet(offer: offer, surface: .activity) }
    fault.point.withLock { $0 = nil }
    #expect(shortcut == .opened && activity == .opened && workout.sets.isEmpty)
    #expect(outsideEvents(recorder) == ["gym_activity_offer_refused outcome=failed surface=shortcut", "gym_activity_offer_refused outcome=failed surface=activity"])
  }

  // A Log set a rule of the log refuses, other than the rack having moved on, logs nothing and is recorded as refused.
  @Test func anOutsideLogSetARuleRefusesIsRecordedRefused() async throws {
    let recorder = TelemetryRecorder(), app = try app(recorder), gym = app.gym
    let earlier = try gym.runner.moment().now.ms - 7_200_000, kept = gym.runner.mint(TrainingSet.self)
    #expect(gym.run(ImportSession(id: gym.runner.mint(Session.self), startedAt: Instant(ms: earlier), finishedAt: Instant(ms: earlier + 600_000),
      sets: [ImportedSet(id: kept, exerciseId: fixtures.first, weightKg: 60, reps: 5, completedAt: Instant(ms: earlier + 60_000))]))?.refusal == nil)
    let workout = try fixtures.begin(gym), offer = try #require(workout.activityOffer())
    var record = try #require(try workout.activityRecord())
    let taken = WorkoutActivityOffer(ownerID: offer.ownerID, sessionID: offer.sessionID, movementID: offer.movementID,
                                     weightKg: offer.weightKg, reps: offer.reps, setID: kept.description)
    record.offer = taken
    #expect(workout.keepActivity(record) && workout.activityOffer() == taken)
    recorder.entries.withLock { $0.removeAll() }
    #expect(await handling(app) { await WorkoutActivityIntentHandler.logSet(offer: taken, surface: .activity) } == .opened)
    #expect(gym.refusal == .taken(kept.ref, .predicted) && workout.sets.isEmpty)
    #expect(outsideEvents(recorder) == ["gym_activity_offer_refused outcome=refused surface=activity"])
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
