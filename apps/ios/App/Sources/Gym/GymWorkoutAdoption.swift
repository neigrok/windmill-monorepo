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
      VStack(alignment: .leading, spacing: RoomSpace.related) {
        Text(saving ? "Adding your signed-out workout…" : "A signed-out workout is on this phone · \(workout.sets.count) sets · \(workout.session.name ?? "No routine")")
          .font(.footnote).foregroundStyle(GymPalette.ink)
        if !saving {
          Button("Keep as finished workout") { gym.keepAdoptedWorkout(workout.session.id) }
            .disabled(gym.accountTransition || gym.authPaused || gym.readFailed || gym.log?.firstPullComplete != true)
            .accessibilityIdentifier("gym-adoption-keep-\(workout.session.id)")
        }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(RoomSpace.inset)
        .background(GymPalette.card, in: RoundedRectangle(cornerRadius: RoomSpace.cardRadius))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("gym-adoption-recovery")
    }
  }
}
