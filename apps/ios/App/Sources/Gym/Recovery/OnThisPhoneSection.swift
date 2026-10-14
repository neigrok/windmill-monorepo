import SwiftUI
import DomainKit
import GymDomain

// The log's head while signed in: a door per saved workout the account has not taken, its subtitle the reason it waits
// on the lifter or *adding…* while it is on its way. The section leaves when it is empty.
struct OnThisPhoneSection: View {
  let gym: GymModel

  var body: some View {
    let waiting = gym.workoutsToReview
    let workouts = gym.adoptionWorkouts.sorted { $0.session.startedAt > $1.session.startedAt }
    if !gym.isAnonymous, !workouts.isEmpty, let moment = gym.log?.moment {
      Section("On this phone") {
        ForEach(workouts, id: \.session.id) { workout in
          let recovery = waiting.first { $0.id == workout.session.id }
          NavigationLink { WorkoutInspectScreen(gym: gym, id: workout.session.id) } label: {
            HStack(spacing: RoomSpace.related) {
              VStack(alignment: .leading, spacing: RoomSpace.small) {
                Text(recovery?.title(at: moment) ?? workout.title(at: moment)).font(.body.weight(.semibold)).monospacedDigit()
                  .foregroundStyle(GymPalette.ink)
                Text(recovery?.line ?? "adding…").font(.subheadline).foregroundStyle(GymPalette.inkDim)
              }.frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget, alignment: .leading)
              if recovery == nil { ProgressView() }
            }.accessibilityElement(children: .combine)
          }.accessibilityIdentifier("recovery-row-\(workout.session.id)")
        }
      }.listRowBackground(GymPalette.card)
    }
  }
}

// Recovery's words. The line, at most twelve words naming the way out, is the row's subtitle, Inspect's footer and the
// transient after a refused retry.
extension WorkoutRecovery {
  enum Primary {
    case keep, retry, fix
    var title: String {
      switch self {
      case .keep: "Keep as finished"
      case .retry: "Retry"
      case .fix: "Fix workout"
      }
    }
  }

  var line: String { reason.line(stranded: strandedSets.count) }

  // Sets a landed workout refused only go back through Retry; a spent identity has no primary, since its way out is
  // Discard, which is never a prominent fill.
  var primary: Primary? {
    guard retry != .restoreSets else { return .retry }
    switch reason {
    case .accountWorkoutOpen: return .keep
    case .strandedSets, .unsent: return .retry
    case .identityTaken: return nil
    case .overlap, .badTime, .tooManySets, .invalidSet, .unknownMovement, .other: return .fix
    }
  }

  func title(at moment: Moment) -> String {
    guard retry == .restoreSets else { return workout.title(at: moment) }
    return "\(SignedOutWorkout.sets(strandedSets.count)) from \(workout.name) · \(workout.day(at: moment))"
  }

  // The refusal's own code, beside the date on Inspect, when the line is the catch-all.
  var code: String? {
    switch refusal {
    case .other(let refused)?: refused.code.description
    case .invalid(let violation)?: violation.rule
    default: nil
    }
  }
}

extension WorkoutRecovery.Reason {
  func line(stranded: Int) -> String {
    switch self {
    case .accountWorkoutOpen: "Your account has an open workout — keep this one as finished."
    case .overlap: "Overlaps another workout — fix its times."
    case .identityTaken: "Already added once — discard this copy."
    case .badTime: "Its times don't line up — fix the times."
    case .tooManySets: "Over 200 sets — remove some, then retry."
    case .unknownMovement: "A movement is missing — fix its sets, then retry."
    case .strandedSets: stranded == 1 ? "A set missed its workout — retry puts it back."
      : "\(stranded) sets missed their workout — retry puts them back."
    case .unsent: "Not on your log yet — retry to add it."
    case .invalidSet, .other: "Refused by the log — fix the workout, then retry."
    }
  }
}

extension GymModel {
  // Why Keep, Retry and Save and retry wait, as the line under their band.
  var recoveryWait: String? {
    if authPaused { return "Sign in again to add it." }
    return log?.firstPullComplete == true ? nil : "Adding it needs a connection."
  }
}

extension SignedOutWorkout {
  var name: String { session.name ?? Readout.noRoutine }

  func day(at moment: Moment) -> String { Readout.briefDay(session.startedAt, now: moment.now, zone: moment.zone) }

  func title(at moment: Moment) -> String { "\(name) · \(day(at: moment)) · \(Self.sets(sets.count))" }

  static func sets(_ count: Int) -> String { count == 1 ? "1 set" : "\(count) sets" }
}
