import SwiftUI
import DomainKit
import GymDomain

extension GymModel {
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
        }
        if !saving, let error = gym.error { Text(error).font(.footnote).foregroundStyle(GymPalette.inkDim) }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
        .background(GymPalette.canvas).accessibilityElement(children: .contain)
        .accessibilityIdentifier("gym-adoption-recovery")
    }
  }
}
