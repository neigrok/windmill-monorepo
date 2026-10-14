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

  var adoptionWorkoutToReview: SignedOutWorkout? { workoutsToReview.first?.workout ?? adoptionWorkouts.first }

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
    return WorkoutFix(recovery.workout)
  }

  func fixRefusal(_ fix: WorkoutFix) -> GymRefusal? {
    guard let log else { return nil }
    return fix.refusal(at: log.moment, among: log.drawnSessions)
  }

  @discardableResult
  func keepAdoptedWorkout(_ id: ID<Session>) -> Bool {
    recover(id, .keep) { failure in run(AdoptWorkout(id, mode: .keep), failure: failure) }
  }

  @discardableResult
  func retryWorkout(_ id: ID<Session>) -> Bool {
    guard let recovery = workoutsToReview.first(where: { $0.id == id }) else { return false }
    return recover(id, .retry) { failure in
      switch recovery.retry {
      case .importWorkout: run(AdoptWorkout(id, mode: .keep), failure: failure)
      case .restartWorkout: restartWorkout(id, revised: nil, failure: failure)
      case .restoreSets: restoreStrandedSets(id, failure: failure)
      }
    }
  }

  // The corrected copy replaces the saved one only once its retry is queued; a refusal reaches the editor, which keeps the draft.
  @discardableResult
  func saveAndRetryWorkout(_ fix: WorkoutFix) -> Bool {
    let id = fix.original.session.id
    return recover(id, .fix) { failure in
      fix.isOpen ? restartWorkout(id, revised: fix.workout, failure: failure)
        : run(AdoptWorkout(id, mode: .keep, revised: fix.workout), failure: failure)
    }
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
    let result = outcome == nil ? "failed" : outcome?.refusal == nil ? "ok" : "refused"
    recorded(action, recovery?.reason ?? .unsent, outcome: result)
    return result == "ok"
  }

  // An open workout's start, then each saved set the log does not draw, in the order performed.
  func restartWorkout(_ id: ID<Session>, revised: SignedOutWorkout?, failure: String) -> Outcome<Void, GymRefusal>? {
    let started = run(AdoptWorkout(id, mode: .restart, revised: revised), failure: failure)
    guard let started, started.refusal == nil else { return started }
    for set in adoptionWorkouts.first(where: { $0.session.id == id })?.sets ?? [] where !sets.contains(where: { $0.id == set.id }) {
      guard let appended = run(AppendSet(set), failure: failure) else { return nil }
      if let refusal = appended.refusal { return .refused(refusal) }
    }
    return started
  }

  // The sets inside the landed workout's window first, then the ones outside it as a workout of their own.
  func restoreStrandedSets(_ id: ID<Session>, failure: String) -> Outcome<Void, GymRefusal>? {
    let inside = run(RecoverStrandedSets(id, .intoWorkout), failure: failure)
    guard let inside, inside.refusal == nil else { return inside }
    let outside = run(RecoverStrandedSets(id, .separately), failure: failure)
    guard let outside, outside.refusal == nil else { return outside }
    return inside.receipt != nil ? inside : outside
  }

  enum RecoveryAction: String { case inspect, fix, keep, retry, discard }

  // Content-free: the action, the bounded reason and, for a commit or a cancel, its outcome.
  func recorded(_ action: RecoveryAction, _ reason: WorkoutRecovery.Reason, outcome: String? = nil) {
    var properties = ["action": action.rawValue, "reason": reason.rawValue]
    if let outcome { properties["outcome"] = outcome }
    telemetry.event("gym_import_recovery", properties: properties)
  }
}

struct WorkoutAdoptionBand: View {
  let gym: GymModel
  var body: some View {
    if !gym.isAnonymous, let workout = gym.adoptionWorkoutToReview {
      let saving = gym.sessions.contains { $0.id == workout.session.id }
      VStack(alignment: .leading, spacing: RoomSpace.related) {
        Text(saving ? "Adding your signed-out workout…" : "A signed-out workout is on this phone · \(workout.sets.count) sets · \(workout.session.name ?? "No routine")")
          .font(.footnote).foregroundStyle(GymPalette.ink)
        if !saving {
          Button("Keep as finished workout") { gym.keepAdoptedWorkout(workout.session.id) }
            .disabled(gym.accountTransition || gym.authPaused || gym.readFailed || gym.log?.firstPullComplete != true)
            .accessibilityIdentifier("gym-adoption-keep-\(workout.session.id)")
          if gym.log?.firstPullComplete != true { Text("Adding this workout to your account needs a connection. It stays saved on this phone.").font(.footnote) }
        }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(RoomSpace.inset)
        .background(GymPalette.card, in: RoundedRectangle(cornerRadius: RoomSpace.cardRadius))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("gym-adoption-recovery")
    }
  }
}
