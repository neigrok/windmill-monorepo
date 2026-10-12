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
          FactTiles(facts: [
            .init(value: readout.durationMs.map(Readout.duration) ?? "—", label: "Duration"),
            .init(value: "\(readout.workingSetCount)", label: readout.workingSetCount == 1 ? "Working set" : "Working sets"),
            .init(value: "\(Readout.weight(readout.volumeKg)) kg", label: "Volume"),
          ])
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
        if let fixing { SetEditor(gym: gym, set: fixing, routine: session?.plan?.routine, identifier: "gym-fix") }
      }
      .sheet(isPresented: $sharing) { SessionShareSheet(gym: gym, sessionID: sessionID) }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "session"]) }
  }
  func discard() {
    guard let outcome = gym.run(DiscardSession(sessionID)), outcome.refusal == nil else { return }
    dismiss()
  }
}
