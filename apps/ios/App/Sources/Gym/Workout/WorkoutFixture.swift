import Foundation
import DomainKit
import GymDomain
import SyncCore

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
