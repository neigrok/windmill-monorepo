import SwiftUI
import DomainKit
import GymDomain

// A saved workout the account has not taken, read-only, with the one way out its reason names in the band; a refusal
// that arrives while it is open is said there too. A workout that lands stays on screen as last seen until the lifter
// goes back. A confirmed discard removes the saved copy immediately.
struct WorkoutInspectScreen: View {
  let gym: GymModel
  let id: ID<Session>
  @State var seen: SignedOutWorkout?
  @State var fixing: WorkoutFix?
  @State var message: String?
  @State var discard = false
  @State var discardConfirmed = false
  @Environment(\.dismiss) var dismiss

  var saved: SignedOutWorkout? { gym.adoptionWorkouts.first { $0.session.id == id } }
  var workout: SignedOutWorkout? { saved ?? seen }

  var body: some View {
    let recovery = gym.workoutsToReview.first { $0.id == id }
    List {
      if let workout {
        content(workout, recovery).listRowBackground(GymPalette.card)
      } else {
        ContentUnavailableView("This workout is no longer here", systemImage: "iphone").listRowBackground(GymPalette.canvas)
      }
    }.listStyle(.insetGrouped).modifier(GymPage()).accessibilityIdentifier("recovery-inspect")
      .roomTitle(workout?.name ?? Readout.noRoutine, subtitle: subtitle(recovery))
      .gymTabBar()
      .toolbar {
        if let recovery {
          ToolbarItem(placement: .topBarTrailing) {
            MoreMenu(identifier: "recovery-more") {
              if recovery.canFix, recovery.primary != .fix { Button("Fix workout", systemImage: "pencil") { fix() } }
              Button(recovery.discardTitle, systemImage: "trash", role: .destructive) { discard = true }
                .accessibilityIdentifier("recovery-discard")
            }
          }
        }
      }
      .onChange(of: discard) { _, shown in
        if shown {
          discardConfirmed = false
          gym.telemetry.event("gym_action", properties: ["screen": "on_this_phone", "action": "discard", "state": "shown"])
        } else if !discardConfirmed {
          gym.telemetry.event("gym_action", properties: ["screen": "on_this_phone", "action": "cancel", "outcome": "cancelled"])
        }
      }
      .onChange(of: gym.account) { _, _ in discard = false }
      .confirmationDialog("Discard this workout?", isPresented: $discard, titleVisibility: .visible) {
        Button(recovery?.discardTitle ?? "Discard workout", role: .destructive) {
          discardConfirmed = true
          if gym.discardWorkout(id) { dismiss() }
        }
        Button("Cancel", role: .cancel) {}
      } message: { Text("This permanently removes the copy saved on this phone.") }
      .reachBand { band(recovery) }
      .sheet(isPresented: Binding(get: { fixing != nil }, set: { if !$0 { fixing = nil } })) {
        if let fixing, let recovery { WorkoutFixSheet(gym: gym, fix: fixing, reason: recovery.reason) { message = nil } }
      }
      .onAppear { seen = saved ?? seen; _ = gym.inspectWorkout(id) }
      .onChange(of: saved) { _, saved in if let saved { seen = saved } }
      .onChange(of: recovery?.noticeIds.last) { _, latest in if latest != nil, let recovery { message = recovery.line } }
  }

  // Tiles, then the times, then a section per movement; a stranded set has only its own tiles and rows. The subtitle
  // carries the day, so the times hold the time alone, and a finish on a later day adds its day.
  @ViewBuilder func content(_ workout: SignedOutWorkout, _ recovery: WorkoutRecovery?) -> some View {
    let stranded = recovery?.retry == .restoreSets
    let sets = stranded ? recovery?.strandedSets ?? [] : workout.sets
    let start = workout.session.startedAt, dates = gym.dates
    // A stranded set has no span of its own, so its tiles read without the workout's finish.
    let span = stranded ? Session(id: workout.session.id, startedAt: start) : workout.session
    Section {
      FactTiles(SessionReadout(session: span, sets: sets))
    } footer: {
      if let recovery { Text(recovery.line).accessibilityIdentifier("recovery-reason") }
    }
    if !stranded {
      Section {
        LabeledContent("Started", value: dates.time(start))
        LabeledContent("Finished", value: workout.session.finishedAt.map { end in
          LocalDay(end, in: dates.moment.zone) == LocalDay(start, in: dates.moment.zone) ? dates.time(end) : dates.dayAndTime(end)
        } ?? "Not finished")
      }.monospacedDigit()
    }
    ForEach(SetRow.movements(sets), id: \.self) { exercise in
      Section(recovery?.movementNames[exercise] ?? gym.catalogue.find(exercise)?.name ?? "Missing movement") {
        let performed = sets.filter { $0.exerciseId == exercise }
        ForEach(performed, id: \.id) { set in SetRow(marker: SetRow.marker(set, in: performed), set: set) }
      }
    }
  }

  // Keep and Retry wait for the account with the reason in the band above them, as Save and retry does.
  func band(_ recovery: WorkoutRecovery?) -> some View {
    let primary = recovery?.primary
    let waiting = primary.map { $0 != .fix } == true && !gym.canSendRecovery
    return VStack(spacing: 0) {
      GymTransient(gym: gym, message: message ?? gym.addingLine(id) ?? (waiting ? gym.recoveryWait : nil),
                   dismiss: message == nil ? nil : { message = nil },
                   errorIdentifier: "recovery-error")
      if let recovery, let primary {
        ActionBand(title: primary.title, room: .gym, disabled: waiting, actionIdentifier: "recovery-primary") { act(primary, recovery) }
      }
    }
  }

  // The date, and the refusal's own code when the line is the catch-all.
  func subtitle(_ recovery: WorkoutRecovery?) -> String? {
    guard let workout else { return nil }
    let day = gym.dates.subtitle(workout.session.startedAt)
    return recovery?.code.map { "\(day) · \($0)" } ?? day
  }

  // A queued Keep or Retry clears what the band last said: the workout on its way is the model's line until the log
  // confirms it, and a refusal that comes back says its reason.
  func act(_ primary: WorkoutRecovery.Primary, _ recovery: WorkoutRecovery) {
    switch primary {
    case .fix: fix()
    case .keep: if gym.keepAdoptedWorkout(id) { message = nil }
    case .retry: if gym.retryWorkout(id) { message = nil }
    }
  }

  func fix() { fixing = gym.fixWorkout(id) }
}

