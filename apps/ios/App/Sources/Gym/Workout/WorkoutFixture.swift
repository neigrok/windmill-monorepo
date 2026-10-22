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
    if board == "workout-notice", let runtime = gym.runtime, let server = runtime.auth.fake {
      do {
        let identity = server.identity(email: "workout-notice-fixture@example.com")
        _ = try await runtime.engine.signIn(account: identity.account, token: identity.token)
        gym.refresh()
      } catch { gym.error = "Workout notice fixture could not sign in."; return true }
    }
    if gym.openSession != nil { gym.workout.restore(); return true }
    // The rack's boards (03.x) stand at Upper A's dumbbell press, its squat and pull-up sets already logged.
    let upper = board.contains("upper"), planned = upper || board.contains("planned")
    let targets = { (id: String, count: Int, reps: Int, kg: Double) in
      RoutineEntry(exerciseId: ID(RecordID(id)), sets: Array(repeating: SetTarget(reps: reps, weightKg: kg), count: count))
    }
    var routineId: ID<Routine>?
    if planned {
      var draft = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: upper ? "Upper A" : "Lower A", entries: upper ? [
        targets("back-squat", 4, 5, 100), targets("dumbbell-bench-press", 4, 8, 16), targets("pull-up", 4, 8, 10), targets("overhead-press", 3, 8, 40),
      ] : [targets("back-squat", 4, 5, 100), targets("romanian-deadlift", 3, 6, 82.5)]))
      guard case .saved = gym.save(&draft) else { return true }
      routineId = draft.current.id
    }
    // The board's workout began 32:10 ago and its sets were logged in turn, the last 1:37 ago, so the clocks read as at the rack.
    let now = (try? gym.runner.moment().now) ?? Instant(ms: BoardClock().nowMs())
    let id = gym.runner.mint(Session.self)
    guard gym.run(StartSession(id: id, routineId: routineId, startedAt: Instant(ms: now.ms - 1_930_000)))?.refusal == nil,
          gym.restoreWorkout() else { return true }
    // A free workout before its first movement: 03.9 in the app, 04.4 on the Lock Screen under the live-activity board's real clock.
    if board.hasSuffix("blank") { gym.workout.reconcile(); return true }
    if !planned { gym.workout.add(ID("back-squat")); gym.workout.add(ID("romanian-deadlift")) }
    if !board.contains("empty") {
      let logged: [(movement: String, kg: Double, reps: Int, agoMs: Int64)] = upper ? [
        ("back-squat", 100, 5, 1_800_000), ("back-squat", 100, 5, 1_650_000), ("pull-up", 10, 8, 1_000_000),
        ("pull-up", 10, 7, 850_000), ("dumbbell-bench-press", 16, 8, 300_000), ("dumbbell-bench-press", 16, 8, 97_000),
      ] : [("back-squat", 100, 5, 1_210_000), ("back-squat", 100, 5, 97_000)]
      for logged in logged {
        let set = TrainingSet(id: gym.runner.mint(TrainingSet.self), sessionId: id, exerciseId: ID(RecordID(logged.movement)),
                              weightKg: logged.kg, reps: logged.reps, completedAt: Instant(ms: now.ms - logged.agoMs))
        _ = gym.run(AppendSet(set))
      }
    }
    gym.workout.reconcile()
    if !planned { gym.workout.select(ID("back-squat")) }
    if upper { gym.workout.select(ID("dumbbell-bench-press")) }
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
