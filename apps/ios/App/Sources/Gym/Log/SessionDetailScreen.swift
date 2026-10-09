import SwiftUI
import DomainKit
import GymDomain
import SyncAPI

struct SessionDetailScreen: View {
  let gym: GymModel
  let sessionID: ID<Session>
  @Environment(\.dismiss) var dismiss
  @State var fixing: TrainingSet?
  @State var sharing = false
  var session: Session? { gym.sessions.first { $0.id == sessionID } }
  var sets: [TrainingSet] { gym.log?.sets(session: sessionID) ?? [] }
  var movements: [ID<Exercise>] {
    var ids: [ID<Exercise>] = []
    for set in sets where !ids.contains(set.exerciseId) { ids.append(set.exerciseId) }
    return ids
  }
  var body: some View {
    List {
      if let session {
        Section {
          let readout = SessionReadout(session: session, sets: sets)
          Text(LogPresentation.date(session.startedAt).formatted(.dateTime.day().month(.wide).year().hour().minute()))
            .font(.subheadline.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
          Text("\(readout.durationMs.map(Readout.duration) ?? "—") · \(readout.workingSetCount) working sets · \(readout.movementCount) movements")
            .font(.subheadline.monospacedDigit())
          Text("\(Readout.weight(readout.volumeKg)) kg volume").font(.subheadline.monospacedDigit())
          if session.plan != nil { Label("Plan saved at start", systemImage: "snowflake").font(.caption).foregroundStyle(GymPalette.accent) }
          if session.closedBy == "stale" { Text("Closed after four hours without a set").font(.subheadline).foregroundStyle(GymPalette.inkDim) }
          if gym.logSessionIsDeviceOnly(sessionID) { Label("On this device", systemImage: "iphone").font(.caption).foregroundStyle(GymPalette.inkDim) }
        }.listRowBackground(GymPalette.card)
        if gym.readFailed {
          Section {
            Text("Your workout could not be read — the saved sets are shown.")
            Button("Try again") { gym.refresh() }
          }.listRowBackground(GymPalette.card)
        }
        ForEach(movements, id: \.self) { id in
          let mine = sets.filter { $0.exerciseId == id }
          let plan = session.plan?.entries.filter { $0.exerciseId == id }
          Section {
            NavigationLink { MovementRecordScreen(gym: gym, exerciseID: id) } label: {
              Text(gym.catalogue.find(id)?.name ?? "Movement").font(.headline)
            }.accessibilityIdentifier("gym-session-movement")
            if let plan, plan.count == 1 { Text("plan \(Readout.target(plan[0].sets))").font(.caption.monospacedDigit()).foregroundStyle(GymPalette.accent) }
            ForEach(Array(mine.enumerated()), id: \.element.id) { index, set in
              Button { fixing = set } label: {
                VStack(alignment: .leading, spacing: 5) {
                  Text("\(set.setNumber ?? index + 1) · \(Readout.effort(weightKg: set.weightKg, reps: set.reps))")
                    .font(.body.monospacedDigit()).foregroundStyle(set.kind == "warmup" ? GymPalette.inkDim : GymPalette.ink)
                  if let note = LogPresentation.comparison(set, preceding: Array(mine.prefix(index)), plan: session.plan) {
                    Text(note).font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
                  }
                  if set.rpe != nil || !set.note.isEmpty {
                    Text([set.rpe.map { "RPE \(Readout.weight($0))" }, set.note.isEmpty ? nil : set.note].compactMap { $0 }.joined(separator: " · "))
                      .font(.subheadline).foregroundStyle(GymPalette.inkDim)
                  }
                }.frame(maxWidth: .infinity, alignment: .leading)
              }.accessibilityIdentifier("gym-finished-set-\(set.id)")
                .swipeActions { Button("Delete", role: .destructive) { gym.run(DeleteSet(set.id)) } }
                .contextMenu { Button("Fix set", systemImage: "pencil") { fixing = set }; Button("Delete set", systemImage: "trash", role: .destructive) { gym.run(DeleteSet(set.id)) } }
                .accessibilityAction(named: "Delete set") { gym.run(DeleteSet(set.id)) }
            }
          }.listRowBackground(GymPalette.card)
        }
        if sets.isEmpty { Text("No sets in this workout.").foregroundStyle(GymPalette.inkDim).listRowBackground(GymPalette.card) }
        Section {
          Button("Share this workout", systemImage: "square.and.arrow.up") { sharing = true }.accessibilityIdentifier("gym-session-share")
          Button("Discard workout", systemImage: "trash", role: .destructive) { discard() }.foregroundStyle(GymPalette.alarm).accessibilityIdentifier("gym-session-discard")
        }.listRowBackground(GymPalette.card)
      } else if gym.readFailed {
        ContentUnavailableView { Label("Workout unavailable", systemImage: "exclamationmark.triangle") } description: { Text("Your workout could not be read.") } actions: { Button("Try again") { gym.refresh() } }
      } else { ContentUnavailableView("This workout is no longer here", systemImage: "clock") }
    }.listStyle(.insetGrouped).modifier(GymPage())
      .navigationTitle(session?.name ?? Readout.noRoutine).navigationBarTitleDisplayMode(.inline)
      .toolbar(.hidden, for: .tabBar).accessibilityIdentifier("gym-session-detail")
      .safeAreaInset(edge: .bottom) { GymTransient(gym: gym, errorIdentifier: "gym-log-error", undoIdentifier: "gym-log-undo") }
      .sheet(isPresented: Binding(get: { fixing != nil }, set: { if !$0 { fixing = nil } })) {
        if let fixing { FinishedSetFixSheet(gym: gym, original: fixing) }
      }
      .sheet(isPresented: $sharing) { SessionShareSheet(gym: gym, sessionID: sessionID) }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "session"]) }
  }
  func discard() {
    guard let outcome = gym.run(DiscardSession(sessionID)), outcome.refusal == nil else { return }
    dismiss()
  }
}

struct FinishedSetDraft: Equatable {
  var original: TrainingSet
  var weight: String
  var reps: String
  var rpe: Double?
  var note: String
  init(_ set: TrainingSet) { original = set; weight = Readout.weight(set.weightKg).replacingOccurrences(of: "−", with: "-"); reps = String(set.reps); rpe = set.rpe; note = set.note }
  var problem: String? {
    let raw = weight.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
    if raw.filter({ $0 == "." }).count > 1 { return "One decimal point only." }
    guard let kg = Double(raw), kg.isFinite else { return "That is not a number yet." }
    guard (-500...500).contains(kg) else { return "Between −500 and 500 kg — check the number." }
    guard let n = Int(reps), (1...99).contains(n) else { return "Whole reps, 1–99." }
    guard note.utf8.count <= 4000 else { return "A set note runs to 4000 bytes." }
    return nil
  }
  var value: TrainingSet? {
    guard problem == nil else { return nil }
    var value = original
    value.weightKg = Double(weight.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: "."))!
    value.reps = Int(reps)!; value.rpe = rpe; value.note = note
    return value
  }
}

struct FinishedSetFixSheet: View {
  let gym: GymModel
  let original: TrainingSet
  let account: String?
  @Environment(\.dismiss) var dismiss
  @State var draft: FinishedSetDraft
  @State var failed: String?
  @State var saved = false
  init(gym: GymModel, original: TrainingSet) {
    self.gym = gym; self.original = original; account = gym.account
    _draft = State(initialValue: FinishedSetDraft(original))
  }
  var body: some View {
    NavigationStack {
      Form {
        Section(gym.catalogue.find(original.exerciseId)?.name ?? "Movement") {
          LabeledContent("Weight (kg)") {
            TextField("Weight in kg", text: $draft.weight).keyboardType(.numbersAndPunctuation).multilineTextAlignment(.trailing).accessibilityIdentifier("gym-fix-weight")
          }
          LabeledContent("Reps") {
            TextField("Reps", text: $draft.reps).keyboardType(.numberPad).multilineTextAlignment(.trailing).accessibilityIdentifier("gym-fix-reps")
          }
          Picker("Effort", selection: $draft.rpe) {
            Text("Unrated").tag(Optional<Double>.none)
            ForEach(Array(stride(from: 6.0, through: 10.0, by: 0.5)), id: \.self) { value in Text("RPE \(Readout.weight(value))").tag(Optional(value)) }
          }.accessibilityIdentifier("gym-fix-rpe")
        }.listRowBackground(GymPalette.card)
        Section("Set note") {
          TextField("Note", text: $draft.note, axis: .vertical).lineLimit(3...8).accessibilityIdentifier("gym-fix-note")
          Text("\(draft.note.utf8.count) / 4000 bytes").font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
        }.listRowBackground(GymPalette.card)
        Section {
          Text("Routine targets stay unchanged.").font(.subheadline).foregroundStyle(GymPalette.inkDim)
          Button("Delete set", systemImage: "trash", role: .destructive) {
            guard gym.account == account, !gym.readFailed, let outcome = gym.run(DeleteSet(original.id)), outcome.refusal == nil else { failed = gym.error; return }
            dismiss()
          }.foregroundStyle(GymPalette.alarm).accessibilityIdentifier("gym-fix-delete")
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage())
        .navigationTitle("Fix set").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        .safeAreaInset(edge: .bottom) {
          VStack(spacing: 0) {
            GymTransient(gym: gym, message: failed ?? draft.problem)
            ActionBand(title: "Save the fix", room: .gym,
                       disabled: draft.problem != nil || gym.accountTransition, actionIdentifier: "gym-fix-save") {
            guard let value = draft.value else { return }
            if gym.correctLoggedSet(draft.original, to: value, account: account) {
              draft.original = gym.sets.first { $0.id == original.id } ?? value
              saved = true; dismiss()
            }
            else if !gym.readFailed && !gym.sets.contains(where: { $0.id == original.id }) { dismiss() }
            else { failed = (gym.error ?? "That fix did not save.") + " The set is unchanged." }
            }
          }
        }
        .sensoryFeedback(.success, trigger: saved)
        .onChange(of: draft) { _, _ in failed = nil }
        .onChange(of: gym.sets) { _, sets in if !gym.readFailed && !sets.contains(where: { $0.id == original.id }) { dismiss() } }
        .onChange(of: gym.account) { _, _ in dismiss() }
        .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "fix_set"]) }
    }.modifier(GymPage()).presentationDetents([.large])
  }
}
