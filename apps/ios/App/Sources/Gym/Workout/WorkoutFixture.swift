import Foundation
import DomainKit
import GymDomain
import SyncCore
import SwiftUI
#if DEBUG && targetEnvironment(simulator)
import ActivityKit
import UIKit
#endif

enum WorkoutFixture {
  static func prepare(_ board: String, model: AppModel) async -> Bool {
    #if DEBUG && targetEnvironment(simulator)
    guard board.hasPrefix("workout-") else { return false }
    model.openRoom(.gym)
    let gym = model.gym
    // Only 03.15's receipt is the phone's first; every other board's comes after it.
    if !board.hasSuffix("-first") { model.preferences.set("earlier", forKey: GymModel.keepReceipt) }
    if board == "workout-notice", let runtime = gym.runtime, let server = runtime.auth.fake {
      do {
        let identity = server.identity(email: "workout-notice-fixture@example.com")
        _ = try await runtime.engine.signIn(account: identity.account, token: identity.token)
        gym.refresh()
      } catch { gym.error = "Workout notice fixture could not sign in."; return true }
    }
    if gym.openSession != nil { gym.workout.restore(); return true }
    if board.hasPrefix("workout-inflight") { return await prepareInFlight(board, model: model) }
    // The rack's boards (03.x) stand at Upper A's dumbbell press, its squat and pull-up sets already logged.
    let upper = board.contains("upper"), planned = upper || board.contains("planned")
    let other = board == "workout-upper-other"
    if other {
      guard gym.run(UpdateExercise(ID("pull-up"), name: "Pull-up", equipment: "other"))?.refusal == nil else { return true }
    }
    // The plan's rests are the boards' (03.20): three minutes for the squat, two for the press and the pull-up, none after.
    let targets = { (id: String, count: Int, reps: Int, kg: Double) in
      RoutineEntry(exerciseId: ID(RecordID(id)), sets: Array(repeating: SetTarget(reps: reps, weightKg: kg), count: count),
                   restSeconds: ["back-squat": 180, "dumbbell-bench-press": 120, "pull-up": 120][id])
    }
    var routineId: ID<Routine>?
    if planned {
      var draft = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: upper ? "Upper A" : "Lower A", entries: upper ? [
        targets("back-squat", 4, 5, 100), targets("dumbbell-bench-press", 4, 8, 16), targets("pull-up", 4, 8, other ? -5 : 10), targets("overhead-press", 3, 8, 40),
      ] : [targets("back-squat", 4, 5, 100), targets("romanian-deadlift", 3, 6, 82.5)]))
      guard case .saved = gym.save(&draft) else { return true }
      routineId = draft.current.id
    }
    // The board's workout began 32:10 ago and its sets were logged in turn, the last 1:37 ago, so the clocks read as at the rack;
    // a rested board (03.21) stands 37 seconds later, its rest at 2:14, past the press's two minutes.
    let now = (try? gym.runner.moment().now) ?? Instant(ms: BoardClock().nowMs())
    let rested: Int64 = board.contains("rested") ? 37_000 : 0
    let id = gym.runner.mint(Session.self)
    guard gym.run(StartSession(id: id, routineId: routineId, startedAt: Instant(ms: now.ms - 1_930_000 - rested)))?.refusal == nil,
          gym.restoreWorkout() else { return true }
    if !planned { gym.workout.add(ID("back-squat")); gym.workout.add(ID("romanian-deadlift")) }
    if !board.contains("empty") {
      let logged: [(movement: String, kg: Double, reps: Int, agoMs: Int64)] = upper ? [
        ("back-squat", 100, 5, 1_800_000), ("back-squat", 100, 5, 1_650_000), ("pull-up", 10, 8, 1_000_000),
        ("pull-up", 10, 7, 850_000), ("dumbbell-bench-press", 16, 8, 300_000), ("dumbbell-bench-press", 16, 8, 97_000),
      ] : [("back-squat", 100, 5, 1_210_000), ("back-squat", 100, 5, 97_000)]
      for logged in logged {
        let set = TrainingSet(id: gym.runner.mint(TrainingSet.self), sessionId: id, exerciseId: ID(RecordID(logged.movement)),
                              weightKg: other && logged.movement == "pull-up" ? -5 : logged.kg, reps: logged.reps, completedAt: Instant(ms: now.ms - logged.agoMs - rested))
        _ = gym.run(AppendSet(set))
      }
    }
    gym.workout.reconcile()
    if !planned { gym.workout.select(ID("back-squat")) }
    if upper { gym.workout.select(other ? ID("pull-up") : ID("dumbbell-bench-press")) }
    if board == "workout-notice", let runtime = gym.runtime, let server = runtime.auth.fake {
      await runtime.engine.flushOnLeave(); gym.refresh(); gym.workout.reconcile()
      server.state.withLock { $0.server.refuse(code: .cap, detail: ["type": .string(TrainingSet.type), "cap": 10]) }
      gym.workout.logSet()
      await runtime.engine.flushOnLeave(); gym.refresh(); gym.workout.reconcile()
      gym.workout.message = "Check the weight and reps before logging."
    }
    // The receipt of a workout that set a record, holding the review the server would answer for it.
    if board == "workout-record" {
      await gym.workout.finish()
      gym.workout.receipt?.review = try? JSONDecoder().decode(WorkoutReview.self, from: Data(#"{"record":{"kind":"e1rm","exerciseId":"back-squat","value":116.7,"weightKg":100,"reps":5,"previous":110.8,"previousAt":\#(now.ms - 604_800_000)}}"#.utf8))
    }
    return true
    #else
    return false
    #endif
  }

  #if DEBUG && targetEnvironment(simulator)
  // The in-flight wave's fixture (workout-in-flight.md): Upper A, signed in so the log records the routine's revision at the
  // start, four squat sets and two dumbbell press sets logged, the last 1:37 ago, and Pull-up and the cable row untouched.
  // `-logged` stands at the press, every other board at Pull-up.
  static func prepareInFlight(_ board: String, model: AppModel) async -> Bool {
    let gym = model.gym
    guard let runtime = gym.runtime, let server = runtime.auth.fake else { gym.error = "The in-flight fixture needs the model server."; return true }
    do { try await model.signIn(server.identity(email: "workout-in-flight-fixture@example.com")) }
    catch { gym.error = "The in-flight fixture could not sign in."; return true }
    model.openRoom(.gym)
    guard gym.run(UpdateExercise(ID("pull-up"), name: "Pull-up", equipment: "bodyweight"))?.refusal == nil else { return true }
    let entry = { (id: String, count: Int, reps: Int, kg: Double, rest: Int?) in
      RoutineEntry(exerciseId: ID(RecordID(id)), sets: Array(repeating: SetTarget(reps: reps, weightKg: kg), count: count), restSeconds: rest)
    }
    var draft = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Upper A", entries: [
      entry("back-squat", 4, 5, 100, 180), entry("dumbbell-bench-press", 3, 8, 16, 120), entry("pull-up", 3, 8, 10, 120),
      entry("seated-cable-row", 3, 10, 50, nil),
    ]))
    guard case .saved = gym.save(&draft) else { return true }
    await runtime.engine.flushOnLeave(); gym.refresh()
    let now = (try? gym.runner.moment().now) ?? Instant(ms: BoardClock().nowMs())
    let id = gym.runner.mint(Session.self)
    guard gym.run(StartSession(id: id, routineId: draft.current.id, startedAt: Instant(ms: now.ms - 1_930_000)))?.refusal == nil else { return true }
    let logged: [(movement: String, kg: Double, reps: Int, agoMs: Int64)] = [
      ("back-squat", 100, 5, 1_800_000), ("back-squat", 100, 5, 1_600_000), ("back-squat", 100, 5, 1_400_000), ("back-squat", 100, 5, 1_200_000),
      ("dumbbell-bench-press", 16, 8, 300_000), ("dumbbell-bench-press", 16, 8, 97_000),
    ]
    for set in logged {
      _ = gym.run(AppendSet(TrainingSet(id: gym.runner.mint(TrainingSet.self), sessionId: id, exerciseId: ID(RecordID(set.movement)),
                                        weightKg: set.kg, reps: set.reps, completedAt: Instant(ms: now.ms - set.agoMs))))
    }
    await runtime.engine.flushOnLeave(); gym.refresh()
    guard gym.restoreWorkout() else { return true }
    gym.workout.reconcile()
    gym.workout.select(board.hasSuffix("-logged") ? ID("dumbbell-bench-press") : ID("pull-up"))
    // The sign-in can land while the shell still holds its first screen, so the gym opens again once the workout stands.
    for _ in 0..<100 where model.editorReadOnly { try? await Task.sleep(for: .milliseconds(100)) }
    model.openRoom(.gym)
    if ProcessInfo.processInfo.arguments.contains("-log-set-on-signal") {
      landsSet = {
        _ = gym.run(AppendSet(TrainingSet(id: gym.runner.mint(TrainingSet.self), sessionId: id, exerciseId: ID("pull-up"), weightKg: 10, reps: 8,
                                          completedAt: (try? gym.runner.moment().now) ?? Instant(ms: BoardClock().nowMs()))))
      }
      CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
        Task { @MainActor in WorkoutFixture.landsSet?() }
      }, logSetSignal as CFString, nil, .deliverImmediately)
    }
    return true
  }
  // `-log-set-on-signal`: Pull-up takes a set when a UI test posts this Darwin notification, as a set logged outside the
  // app lands while a sheet is open over the workout.
  static let logSetSignal = "works.windmill.fixture.log-set"
  @MainActor static var landsSet: (() -> Void)?
  #endif
}

struct WorkoutActivityFixtureProbe: ViewModifier {
  let gym: GymModel
  func body(content: Content) -> some View {
    #if DEBUG && targetEnvironment(simulator)
    content.background {
      if let model = WorkoutActivityIntentHandler.model, model.gym === gym,
         model.runtime?.settings.board == "workout-live-activity-planned" {
        WorkoutActivityFixtureStatus(model: model).frame(width: 1, height: 1).allowsHitTesting(false)
      }
    }
    #else
    content
    #endif
  }
}

#if DEBUG && targetEnvironment(simulator)
struct WorkoutActivityFixtureStatus: UIViewRepresentable {
  let model: AppModel
  func makeUIView(context: Context) -> StatusView {
    let view = StatusView()
    view.backgroundColor = .clear
    view.isAccessibilityElement = true
    view.accessibilityIdentifier = "workout-activity-state"
    view.accessibilityLabel = "Workout Live Activity"
    view.model = model
    return view
  }
  func updateUIView(_ view: StatusView, context: Context) { view.model = model }

  final class StatusView: UIView {
    weak var model: AppModel?
    override var accessibilityValue: String? {
      get {
        guard let model, model.syncStarted, !model.editorReadOnly,
              let session = model.gym.openSession,
              let controller = model.gym.existingWorkoutActivity, !controller.reconciling,
              let activity = controller.activity, activity.attributes.sessionID == session.id.description,
              activity.activityState == .active, activity.content.state.offer != nil else { return "pending" }
        return "active"
      }
      set { super.accessibilityValue = newValue }
    }
  }
}
#endif
