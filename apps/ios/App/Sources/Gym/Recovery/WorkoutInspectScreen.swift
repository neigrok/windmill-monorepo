import SwiftUI
import DomainKit
import GymDomain

// A saved workout the account has not taken, read-only, with the one way out its reason names in the band; a refusal
// that arrives while it is open is said there too. A workout that lands stays on screen as last seen until the lifter
// goes back. Discard returns to The log, which holds it for the room's window with Undo in its band.
struct WorkoutInspectScreen: View {
  let gym: GymModel
  let id: ID<Session>
  @State var seen: SignedOutWorkout?
  @State var fixing: WorkoutFix?
  @State var message: String?
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
      .toolbar(.hidden, for: .tabBar)
      .toolbar {
        if let recovery {
          ToolbarItem(placement: .topBarTrailing) {
            MoreMenu(identifier: "recovery-more") {
              if recovery.canFix, recovery.primary != .fix { Button("Fix workout", systemImage: "pencil") { fix() } }
              Button(recovery.discardTitle, systemImage: "trash", role: .destructive) { gym.holdDiscard(id); dismiss() }
                .accessibilityIdentifier("recovery-discard")
            }
          }
        }
      }
      .reachBand { band(recovery) }
      .sheet(isPresented: Binding(get: { fixing != nil }, set: { if !$0 { fixing = nil } })) {
        if let fixing, let recovery { WorkoutFixSheet(gym: gym, fix: fixing, reason: recovery.reason) { message = $0 } }
      }
      .onAppear { seen = saved ?? seen; _ = gym.inspectWorkout(id) }
      .onChange(of: saved) { _, saved in if let saved { seen = saved } }
      .onChange(of: recovery?.noticeIds.last) { _, latest in if latest != nil, let recovery { message = recovery.line } }
  }

  // Tiles, then the times, then a section per movement; a stranded set has only its own tiles and rows.
  @ViewBuilder func content(_ workout: SignedOutWorkout, _ recovery: WorkoutRecovery?) -> some View {
    let stranded = recovery?.retry == .restoreSets
    let sets = stranded ? recovery?.strandedSets ?? [] : workout.sets
    let readout = SessionReadout(session: workout.session, sets: sets)
    let duration = FactTiles.Fact(value: readout.durationMs.map(Readout.duration) ?? "—", label: "Duration")
    Section {
      FactTiles(facts: (stranded ? [] : [duration]) + [
        .init(value: "\(readout.workingSetCount)", label: "Working sets"),
        .init(value: "\(Readout.weight(readout.volumeKg)) kg", label: "Volume"),
      ])
    } footer: {
      if let recovery { Text(recovery.line).accessibilityIdentifier("recovery-reason") }
    }
    if !stranded {
      Section {
        LabeledContent("Started", value: SignedOutWorkout.time(workout.session.startedAt, day: true))
        LabeledContent("Finished", value: workout.session.finishedAt.map { SignedOutWorkout.time($0, day: true) } ?? "Not finished")
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
      GymTransient(gym: gym, message: message ?? (waiting ? gym.recoveryWait : nil),
                   dismiss: message == nil ? nil : { message = nil },
                   errorIdentifier: "recovery-error", undoIdentifier: "recovery-undo")
      if let recovery, let primary {
        ActionBand(title: primary.title, room: .gym, disabled: waiting, actionIdentifier: "recovery-primary") { act(primary, recovery) }
      }
    }
  }

  // The date, and the refusal's own code when the line is the catch-all.
  func subtitle(_ recovery: WorkoutRecovery?) -> String? {
    guard let workout else { return nil }
    let day = workout.session.startedAt.date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    return recovery?.code.map { "\(day) · \($0)" } ?? day
  }

  // A queued Keep or Retry says so here, until the log confirms it and the row leaves; a refused one says its reason.
  func act(_ primary: WorkoutRecovery.Primary, _ recovery: WorkoutRecovery) {
    let queued: Bool
    switch primary {
    case .fix: fix(); return
    case .keep: queued = gym.keepAdoptedWorkout(id)
    case .retry: queued = gym.retryWorkout(id)
    }
    if queued { message = "Adding \(recovery.workout.name) to your log." }
  }

  func fix() { fixing = gym.fixWorkout(id) }
}

