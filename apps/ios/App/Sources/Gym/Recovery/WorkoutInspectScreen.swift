import SwiftUI
import DomainKit
import GymDomain

// A saved workout the account has not taken, read-only, with the one way out its reason names in the band. A workout
// that lands stays on screen as last seen until the lifter goes back. Discard is held for the room's nine-second window
// on this screen; leaving the screen or the app ends the window.
struct WorkoutInspectScreen: View {
  let gym: GymModel
  let id: ID<Session>
  @State var seen: SignedOutWorkout?
  @State var fixing: WorkoutFix?
  @State var message: String?
  @State var discarding: Task<Void, Never>?
  @Environment(\.dismiss) var dismiss
  @Environment(\.scenePhase) var phase

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
      .navigationTitle(workout?.name ?? Readout.noRoutine)
      .modifier(RecoverySubtitle(text: subtitle(recovery)))
      .toolbar(.hidden, for: .tabBar)
      .toolbar {
        if let recovery, discarding == nil {
          ToolbarItem(placement: .topBarTrailing) {
            Menu {
              if recovery.canFix, recovery.primary != .fix { Button("Fix workout", systemImage: "pencil") { fix() } }
              Button("Discard workout", systemImage: "trash", role: .destructive) { hold() }
                .accessibilityIdentifier("recovery-discard")
            } label: { Image(systemName: "ellipsis.circle").accessibilityLabel("More") }
              .accessibilityIdentifier("recovery-more")
          }
        }
      }
      .safeAreaInset(edge: .bottom) { band(recovery) }
      .sheet(isPresented: Binding(get: { fixing != nil }, set: { if !$0 { fixing = nil } })) {
        if let fixing, let recovery { WorkoutFixSheet(gym: gym, fix: fixing, reason: recovery.reason) { message = $0 } }
      }
      .onAppear { seen = saved ?? seen; _ = gym.inspectWorkout(id) }
      .onChange(of: saved) { _, saved in if let saved { seen = saved } }
      .onDisappear { if discarding != nil { discard(leaving: true) } }
      .onChange(of: phase) { _, phase in if phase == .background, discarding != nil { discard(leaving: false) } }
  }

  // Tiles, then the times, then a section per movement; a stranded set has only its own tiles and rows.
  @ViewBuilder func content(_ workout: SignedOutWorkout, _ recovery: WorkoutRecovery?) -> some View {
    let stranded = recovery?.retry == .restoreSets
    let sets = stranded ? recovery?.strandedSets ?? [] : workout.sets
    let readout = SessionReadout(session: workout.session, sets: sets)
    let duration = FactTiles.Fact(value: readout.durationMs.map(Readout.duration) ?? "—", label: "Duration")
    Section {
      FactTiles(facts: (stranded ? [] : [duration]) + [
        .init(value: "\(readout.workingSetCount)", label: readout.workingSetCount == 1 ? "Working set" : "Working sets"),
        .init(value: "\(Readout.weight(readout.volumeKg)) kg", label: "Volume"),
      ])
    } footer: {
      if let recovery { Text(recovery.line).accessibilityIdentifier("recovery-reason") }
    }
    if !stranded {
      Section {
        LabeledContent("Started", value: SavedSetRow.time(workout.session.startedAt, day: true))
        LabeledContent("Finished", value: workout.session.finishedAt.map { SavedSetRow.time($0, day: true) } ?? "Not finished")
      }.monospacedDigit()
    }
    ForEach(SavedSetRow.movements(sets), id: \.self) { exercise in
      Section(recovery?.movementNames[exercise] ?? gym.catalogue.find(exercise)?.name ?? "Missing movement") {
        let performed = sets.filter { $0.exerciseId == exercise }
        ForEach(Array(performed.enumerated()), id: \.element.id) { index, set in
          SavedSetRow(set: set, ordinal: performed.prefix(index + 1).filter { $0.kind == "working" }.count)
        }
      }
    }
  }

  // Keep and Retry wait for the account with the reason in the band above them, as Save and retry does.
  func band(_ recovery: WorkoutRecovery?) -> some View {
    let primary = discarding == nil ? recovery?.primary : nil
    let waiting = primary.map { $0 != .fix } == true && !gym.canSendRecovery
    return VStack(spacing: 0) {
      // The lifter's own discard is the news while its window is open, ahead of any refusal the room holds.
      if discarding != nil {
        RoomTransient(message: "Workout discarded", room: .gym, actionTitle: "Undo", actionIdentifier: "recovery-undo") { undo(recovery) }
          .accessibilityIdentifier("recovery-undo-band")
          .padding(.horizontal, RoomSpace.inset).padding(.vertical, RoomSpace.small)
      } else {
        GymTransient(gym: gym, message: message ?? (waiting ? gym.recoveryWait : nil),
                     dismiss: message == nil ? nil : { message = nil },
                     noticeMessage: gym.latestRecoveryNotice.flatMap { $0.id == id ? $0.line : nil },
                     errorIdentifier: "recovery-error", undoIdentifier: "recovery-undo")
      }
      if let recovery, let primary {
        ActionBand(title: primary.title, room: .gym, disabled: waiting, actionIdentifier: "recovery-primary") { act(primary, recovery) }
      }
    }
  }

  // The date, and the refusal's own code when the line is the catch-all.
  func subtitle(_ recovery: WorkoutRecovery?) -> String? {
    guard let workout else { return nil }
    let day = LogPresentation.date(workout.session.startedAt).formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    return recovery?.code.map { "\(day) · \($0)" } ?? day
  }

  // A queued Keep or Retry says so here; a refused one says its reason in the room's band.
  func act(_ primary: WorkoutRecovery.Primary, _ recovery: WorkoutRecovery) {
    let queued: Bool
    switch primary {
    case .fix: fix(); return
    case .keep: queued = gym.keepAdoptedWorkout(id)
    case .retry: queued = gym.retryWorkout(id)
    }
    if queued { message = "\(recovery.workout.name) is on your log." }
  }

  func fix() { fixing = gym.fixWorkout(id) }

  func hold() {
    message = nil
    discarding = Task {
      do { try await Task.sleep(for: .seconds(9)) } catch { return }
      discard(leaving: false)
    }
  }

  func undo(_ recovery: WorkoutRecovery?) {
    discarding?.cancel(); discarding = nil
    gym.recorded(.discard, recovery?.reason ?? .unsent, outcome: "cancelled")
  }

  // The window closes into the discard; the screen goes with the workout unless it is already going.
  func discard(leaving: Bool) {
    discarding?.cancel(); discarding = nil
    if gym.discardWorkout(id), !leaving { dismiss() }
  }
}

// A saved set read back: `1 · 100 × 5` for a working set, its kind's letter for any other; effort and note as the second
// line when present, after the time when the row is `timed` from its workout's start (the day too, when it differs).
struct SavedSetRow: View {
  let set: TrainingSet
  let ordinal: Int
  var timed: Instant?

  var body: some View {
    VStack(alignment: .leading, spacing: RoomSpace.small) {
      let marker = set.kind == "working" ? "\(ordinal)" : String(set.kind.prefix(1)).uppercased()
      Text("\(marker) · \(Readout.effort(weightKg: set.weightKg, reps: set.reps))").font(.body).monospacedDigit()
        .foregroundStyle(GymPalette.ink)
      let time = timed.map { Self.time(set.completedAt, day: !Calendar.current.isDate(LogPresentation.date($0), inSameDayAs: LogPresentation.date(set.completedAt))) }
      let second = [time, set.rpe.map { "RPE \(Readout.weight($0))" },
                    set.note.isEmpty ? nil : set.note].compactMap { $0 }
      if !second.isEmpty {
        Text(second.joined(separator: " · ")).font(.subheadline).monospacedDigit().foregroundStyle(GymPalette.inkDim)
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
  }

  static func time(_ instant: Instant, day: Bool) -> String {
    let date = LogPresentation.date(instant)
    return day ? date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
      : date.formatted(.dateTime.hour().minute())
  }

  static func movements(_ sets: [TrainingSet]) -> [ID<Exercise>] {
    var ids: [ID<Exercise>] = []
    for set in sets where !ids.contains(set.exerciseId) { ids.append(set.exerciseId) }
    return ids
  }
}

// The date under a recovery screen's title; iOS 18 draws the title alone.
struct RecoverySubtitle: ViewModifier {
  let text: String?

  func body(content: Content) -> some View {
    if #available(iOS 26.0, *), let text { content.navigationSubtitle(text) } else { content }
  }
}
