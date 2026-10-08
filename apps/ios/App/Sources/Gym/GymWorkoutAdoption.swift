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

  var adoptionWorkoutToReview: SignedOutWorkout? {
    adoptionWorkouts.first { workout in !sessions.contains { $0.id == workout.session.id } } ?? adoptionWorkouts.first
  }

  func keepAdoptedWorkout(_ id: ID<Session>) {
    _ = run(AdoptWorkout(id, mode: .keep))
  }
}

struct WorkoutAdoptionBand: View {
  let gym: GymModel
  var body: some View {
    if !gym.isAnonymous, let workout = gym.adoptionWorkoutToReview {
      let saving = gym.sessions.contains { $0.id == workout.session.id }
      VStack(alignment: .leading, spacing: 6) {
        Text(saving ? "Adding your signed-out workout…" : "Your signed-out workout is kept on this phone.").font(.headline)
        Text("\(workout.sets.count) sets · \(workout.session.name ?? "No routine")").font(.footnote)
        if !saving {
          Text(workout.session.isOpen && gym.openSession != nil ? "Your account already has another workout. Keep this one separately in the log, finished at its last set." : "Keep this workout separately in the log, finished at its last set.").font(.footnote)
          Button("Keep as finished workout") { gym.keepAdoptedWorkout(workout.session.id) }
            .disabled(gym.accountTransition || gym.authPaused || gym.readFailed || gym.log?.firstPullComplete != true)
            .accessibilityIdentifier("gym-adoption-keep-\(workout.session.id)")
          if gym.log?.firstPullComplete != true { Text("Adding this workout to your account needs a connection. It stays saved on this phone.").font(.footnote) }
        }
        if !saving, let error = gym.error { Text(error).font(.footnote).foregroundStyle(.secondary) }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
        .background(WorkoutPalette.canvas).accessibilityElement(children: .contain)
        .accessibilityIdentifier("gym-adoption-recovery")
    }
  }
}
