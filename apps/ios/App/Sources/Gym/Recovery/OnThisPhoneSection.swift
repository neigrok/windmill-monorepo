import SwiftUI
import DomainKit
import GymDomain

// The log's head while signed in and a saved workout waits for the account: the On this phone section, always one row.
// One workout is its own row, a door to Inspect; two or more are one row, *2 workouts* over how many need the lifter,
// that opens the On this phone list. The section leaves when nothing waits.
struct OnThisPhoneSection: View {
  let gym: GymModel

  var body: some View {
    let rows = gym.isAnonymous ? [] : gym.waitingRows
    if !rows.isEmpty {
      Section("On this phone") {
        if rows.count == 1, let row = rows.first {
          OnThisPhoneSection.door(row, gym: gym)
        } else {
          NavigationLink { OnThisPhoneList(gym: gym) } label: {
            GymRow(title: GymCount.of(rows.count, "workout"), meta: OnThisPhoneSection.summary(rows))
          }.accessibilityIdentifier("recovery-summary")
        }
      }.listRowBackground(GymPalette.card)
    }
  }

  // How many need the lifter, or Adding… while every one is on its way.
  static func summary(_ rows: [WaitingRow]) -> String {
    let count = rows.filter { $0.reason != nil }.count
    return count == 0 ? "Adding…" : "\(count) \(GymCount.noun(count, "needs", plural: "need")) you"
  }

  // A saved workout's door to Inspect: its reason, or Adding… with work on its way.
  static func door(_ row: WaitingRow, gym: GymModel) -> some View {
    NavigationLink { WorkoutInspectScreen(gym: gym, id: row.id) } label: {
      GymRow(title: row.title, meta: row.reason ?? "Adding…", trailing: row.reason == nil ? .progress : nil)
    }.accessibilityIdentifier("recovery-row-\(row.id)")
  }
}

// Every saved workout the account has not taken: the ones that need the lifter, then the ones on their way. Discard
// from Inspect comes back here with its Undo, and the list leaves once nothing waits.
struct OnThisPhoneList: View {
  let gym: GymModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let rows = gym.waitingRows
    let needYou = rows.filter { $0.reason != nil }, adding = rows.filter { $0.reason == nil }
    List {
      if !needYou.isEmpty { Section("Needs you") { ForEach(needYou) { OnThisPhoneSection.door($0, gym: gym) } }.listRowBackground(GymPalette.card) }
      if !adding.isEmpty { Section("Adding") { ForEach(adding) { OnThisPhoneSection.door($0, gym: gym) } }.listRowBackground(GymPalette.card) }
    }.listStyle(.insetGrouped).modifier(GymPage()).navigationTitle("On this phone").navigationBarTitleDisplayMode(.inline)
      .gymTabBar().accessibilityIdentifier("recovery-list")
      .reachBand {
        GymTransient(gym: gym, held: gym.discardHold.map { hold in .init(text: hold.line, undo: gym.undoDiscard, keep: gym.endDiscardWindow) },
                     errorIdentifier: "gym-log-error", undoIdentifier: "gym-log-undo")
      }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "on_this_phone"]) }
      .onChange(of: rows.isEmpty) { _, empty in if empty { dismiss() } }
  }
}

// A saved workout as On this phone draws it: its title, and the reason it waits on the lifter, none while it is on its way.
struct WaitingRow: Identifiable {
  let id: ID<Session>
  let title: String
  let reason: String?
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

  // The one way out the reason names; a retry is offered only for a reason a retry can change. A spent identity has no
  // primary, since its way out is Discard, which is never a prominent fill.
  var primary: Primary? {
    switch reason {
    case .accountWorkoutOpen: .keep
    case .strandedSets, .unsent: .retry
    case .identityTaken: nil
    case .overlap, .badTime, .tooManySets, .invalidSet, .unknownMovement, .other: .fix
    }
  }

  // What Discard drops: the whole copy, or the sets of a landed workout it still holds.
  var discardTitle: String { retry == .restoreSets ? "Discard \(GymCount.of(strandedSets.count, "set"))" : "Discard workout" }
  var discardedLine: String {
    guard retry == .restoreSets else { return "Workout discarded" }
    return strandedSets.count == 1 ? "Set discarded" : "\(GymCount.of(strandedSets.count, "set")) discarded"
  }

  func title(_ dates: GymDate) -> String {
    guard retry == .restoreSets else { return workout.title(dates) }
    return "\(GymCount.of(strandedSets.count, "set")) from \(workout.name) · \(dates.day(workout.session.startedAt))"
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
      : "\(GymCount.of(stranded, "set")) missed their workout — retry puts them back."
    case .unsent: "Not on your log yet — retry to add it."
    case .invalidSet, .other: "Refused by the log — fix the workout, then retry."
    }
  }
}

extension GymModel {
  // The saved workouts the account has not taken, newest first.
  var waitingRows: [WaitingRow] {
    let review = workoutsToReview, dates = self.dates
    return waitingWorkouts.sorted { $0.session.startedAt > $1.session.startedAt }.map { workout in
      let recovery = review.first { $0.id == workout.session.id }
      return WaitingRow(id: workout.session.id, title: recovery?.title(dates) ?? workout.title(dates), reason: recovery?.line)
    }
  }

  // Why Keep, Retry and Save and retry wait, as the line under their band.
  var recoveryWait: String? {
    if authPaused { return "Sign in again to add it." }
    return log?.firstPullComplete == true ? nil : "Adding it needs a connection."
  }
}

extension SignedOutWorkout {
  var name: String { session.name ?? Readout.noRoutine }

  func title(_ dates: GymDate) -> String { "\(name) · \(dates.day(session.startedAt)) · \(GymCount.of(sets.count, "set"))" }
}
