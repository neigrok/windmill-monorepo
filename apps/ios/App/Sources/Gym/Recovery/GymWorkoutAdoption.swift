import SwiftUI
import DomainKit
import GymDomain
import SyncEngine
import SyncSchema

// Before the engine changes the replica the gym writes to, training pauses, the Live Activity ends and each signed-out workout is snapshotted.
@MainActor final class GymBinding: ProductBinding {
  nonisolated let product = "gym"
  weak var gym: GymModel?
  var changingGym: GymModel?
  var seatChanges = 0
  func seatWillChange() async throws {
    if seatChanges == 0 { changingGym = gym; changingGym?.replicaChanging = true }
    seatChanges += 1
    guard let gym = changingGym else { return }
    if let controller = gym.existingWorkoutActivity {
      controller.seatChanging = true
      while controller.reconciling { try Task.checkCancellation(); await Task.yield() }
      await controller.end()
      controller.requestedSession = nil
    }
    try Task.checkCancellation()
    do { try gym.prepareWorkoutAdoption() }
    catch { gym.report("gym_action", error); throw error }
  }
  func seatChangeFinished() async {
    seatChanges -= 1
    guard seatChanges == 0 else { return }
    changingGym?.existingWorkoutActivity?.seatChanging = false
    changingGym?.replicaChanging = false
    changingGym = nil
  }
}

extension GymModel {
  func prepareWorkoutAdoption() throws {
    guard try runner.read(Gym.scope, { $0.isAnonymous }) else { return }
    let workouts = try runner.read(Gym.scope) { try $0.repository(Session.self).all(in: .drawn) }
    for workout in workouts {
      if let refusal = try runner.run(AdoptWorkout(workout.id, mode: .prepare)).refusal {
        throw AppFailure(message: "Your signed-out workout is kept on this phone. " + message(refusal))
      }
    }
    let saved = try runner.read(Gym.scope) { try SignedOutWorkout.read($0) }
    for workout in saved where workout.session.isOpen {
      for set in workout.sets {
        let present = try runner.read(Gym.scope) { try $0.repository(TrainingSet.self).find(set.id, in: .drawn) != nil }
        if !present, let refusal = try runner.run(AppendSet(set)).refusal {
          throw AppFailure(message: "Your signed-out sets are kept on this phone. " + message(refusal))
        }
      }
    }
  }

  // The saved workouts the account has not taken, each with why; their count is the Log tab's badge.
  var workoutsToReview: [WorkoutRecovery] {
    guard let log else { return [] }
    return WorkoutRecovery.review(adoptionWorkouts, notices: recoveryNotices, log: log, catalogue: catalogue)
  }

  // Keep, Retry and Save and retry queue an account write: they wait for the account's first pull and a live session.
  var canSendRecovery: Bool { !accountTransition && !authPaused && !readFailed && log?.firstPullComplete == true }

  func inspectWorkout(_ id: ID<Session>) -> WorkoutRecovery? {
    guard let recovery = workoutsToReview.first(where: { $0.id == id }) else { return nil }
    recorded(.inspect, recovery.reason)
    return recovery
  }

  func fixWorkout(_ id: ID<Session>) -> WorkoutFix? {
    guard let recovery = workoutsToReview.first(where: { $0.id == id }), recovery.canFix else { return nil }
    recorded(.fix, recovery.reason)
    return WorkoutFix(recovery)
  }

  func fixRefusal(_ fix: WorkoutFix) -> GymRefusal? {
    guard let log else { return nil }
    return fix.refusal(at: log.moment, among: log.drawnSessions, catalogue: catalogue)
  }

  @discardableResult
  func keepAdoptedWorkout(_ id: ID<Session>) -> Bool {
    recover(id, .keep) { failure in run(AdoptWorkout(id, mode: .keep), failure: failure) }
  }

  @discardableResult
  func retryWorkout(_ id: ID<Session>) -> Bool {
    guard let recovery = workoutsToReview.first(where: { $0.id == id }) else { return false }
    return recover(id, .retry) { failure in retry(recovery.retry, id, revised: nil, failure: failure) }
  }

  // The corrected copy replaces the saved one only once its retry is queued; a refusal reaches the editor, which keeps the draft.
  @discardableResult
  func saveAndRetryWorkout(_ fix: WorkoutFix) -> Bool {
    let id = fix.original.session.id
    let retry: WorkoutRecovery.Retry = fix.landed ? .restoreSets : fix.isOpen ? .restartWorkout : .importWorkout
    return recover(id, .fix) { failure in self.retry(retry, id, revised: fix.workout, failure: failure) }
  }

  // The saved copy and the notices it carried go; the screen holds the gesture for the room's window first.
  @discardableResult
  func discardWorkout(_ id: ID<Session>) -> Bool {
    recover(id, .discard) { failure in run(DiscardSignedOutWorkout(id), failure: failure) }
  }

  // One recovery commit over a saved workout: its attempt under the action's own failure operation, the notices it
  // answers dismissed once queued (so none outlives the copy into the room's band) or its refusal said in recovery's
  // words, and the action recorded with its outcome.
  @discardableResult
  func recover(_ id: ID<Session>, _ action: RecoveryAction, _ attempt: (String) -> Outcome<Void, GymRefusal>?) -> Bool {
    let recovery = workoutsToReview.first { $0.id == id }
    let outcome = attempt("gym_import_\(action.rawValue)")
    if outcome?.receipt != nil { for notice in recovery?.noticeIds ?? [] { dismissNotice(notice) } }
    if let refusal = outcome?.refusal { error = WorkoutRecovery.Reason(refusal).line(stranded: recovery?.strandedSets.count ?? 0) }
    let result = outcome == nil ? "failed" : outcome?.refusal == nil ? "completed" : "refused"
    recorded(action, recovery?.reason ?? .unsent, outcome: result)
    return result == "completed"
  }

  // The import of a finished copy, the start of an open one with its sets, or a landed workout's stranded sets: the
  // ones inside its window back into it first, then the ones outside as a copy of their own.
  func retry(_ retry: WorkoutRecovery.Retry, _ id: ID<Session>, revised: SignedOutWorkout?, failure: String) -> Outcome<Void, GymRefusal>? {
    switch retry {
    case .importWorkout: return run(AdoptWorkout(id, mode: .keep, revised: revised), failure: failure)
    case .restartWorkout: return run(AdoptWorkout(id, mode: .restart, revised: revised), failure: failure)
    case .restoreSets:
      let inside = run(RecoverStrandedSets(id, .intoWorkout, revised: revised), failure: failure)
      guard let inside, inside.refusal == nil else { return inside }
      let outside = run(RecoverStrandedSets(id, .separately, revised: revised), failure: failure)
      guard let outside, outside.refusal == nil else { return outside }
      return inside.receipt != nil ? inside : outside
    }
  }

  enum RecoveryAction: String { case inspect, fix, keep, retry, discard }

  // Content-free, in the vocabulary Android's `gym_import_recovery` uses: a screen opening is `state=opened`; a commit or
  // a close carries its outcome; the bounded reason rides along.
  func recorded(_ action: RecoveryAction, _ reason: WorkoutRecovery.Reason, outcome: String? = nil) {
    var properties = ["action": action.rawValue, "reason": reason.rawValue]
    if let outcome { properties["outcome"] = outcome } else { properties["state"] = "opened" }
    telemetry.event("gym_import_recovery", properties: properties)
  }
}
