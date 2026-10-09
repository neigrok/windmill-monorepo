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
    let planned = board.contains("planned")
    var routineId: ID<Routine>?
    if planned {
      var draft = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Lower A", entries: [
        RoutineEntry(exerciseId: ID("back-squat"), sets: Array(repeating: SetTarget(reps: 5, weightKg: 100), count: 4)),
        RoutineEntry(exerciseId: ID("romanian-deadlift"), sets: Array(repeating: SetTarget(reps: 6, weightKg: 82.5), count: 3)),
      ]))
      guard case .saved = gym.save(&draft) else { return true }
      routineId = draft.current.id
    }
    guard let id = gym.startWorkout(routineId: routineId) else { return true }
    if !planned { gym.workout.add(ID("back-squat")); gym.workout.add(ID("romanian-deadlift")) }
    if !board.contains("empty") {
      for index in 0..<3 {
        let set = TrainingSet(id: gym.runner.mint(TrainingSet.self), sessionId: id, exerciseId: ID("back-squat"),
                              weightKg: index == 0 ? 80 : 100, reps: index == 0 ? 3 : 5,
                              kind: index == 0 ? "warmup" : "working", completedAt: (try? gym.runner.moment().now) ?? Instant(ms: BoardClock().nowMs()))
        _ = gym.run(AppendSet(set))
      }
    }
    gym.workout.reconcile()
    if !planned { gym.workout.select(ID("back-squat")) }
    if board == "workout-notice", let runtime = gym.runtime, let server = runtime.auth.fake {
      await runtime.engine.flushOnLeave(); gym.refresh(); gym.workout.reconcile()
      server.state.withLock { $0.server.refuse(code: .cap, detail: ["type": .string(TrainingSet.type), "cap": 10]) }
      gym.workout.logSet()
      await runtime.engine.flushOnLeave(); gym.refresh(); gym.workout.reconcile()
      gym.workout.message = "Check the weight and reps before logging."
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
