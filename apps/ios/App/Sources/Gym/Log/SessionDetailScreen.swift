import SwiftUI
import DomainKit
import GymDomain
import SyncAPI

struct SessionDetailScreen: View {
  let gym: GymModel
  let sessionID: ID<Session>
  @Environment(\.dismiss) var dismiss
  @Environment(\.dynamicTypeSize) private var typeSize
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
        let readout = SessionReadout(session: session, sets: sets)
        Section {
          FactTiles(facts: [
            .init(value: readout.durationMs.map(Readout.duration) ?? "—", label: "Duration"),
            .init(value: "\(readout.workingSetCount)", label: "Working sets"),
            .init(value: "\(Readout.weight(readout.volumeKg)) kg", label: "Volume"),
          ])
        } footer: {
          let lines = [session.closedBy == "stale" ? "Closed after four hours without a set" : nil,
                       gym.logSessionIsUnsent(sessionID) ? "On this phone, not yet on your account." : nil,
                       sets.isEmpty ? "No sets in this workout." : nil].compactMap { $0 }
          if !lines.isEmpty { Text(lines.joined(separator: "\n")).foregroundStyle(GymPalette.inkDim).accessibilityIdentifier("gym-session-footer") }
        }.listRowBackground(GymPalette.card)
        ForEach(movements, id: \.self) { id in
          let mine = sets.filter { $0.exerciseId == id }
          Section {
            NavigationLink { MovementRecordScreen(gym: gym, exerciseID: id) } label: {
              MovementRow(title: gym.catalogue.find(id)?.name ?? "Movement", meta: LogPresentation.planLine(id, plan: session.plan))
            }.accessibilityIdentifier("gym-session-movement")
            ForEach(Array(mine.enumerated()), id: \.element.id) { index, set in
              setRow(set, number: set.setNumber ?? index + 1,
                     comparison: LogPresentation.comparison(set, preceding: Array(mine.prefix(index)), plan: session.plan))
            }
          }.listRowBackground(GymPalette.card)
        }
      } else if gym.readFailed {
        ContentUnavailableView("Workout unavailable", systemImage: "exclamationmark.triangle", description: Text("Your workout could not be read."))
          .listRowBackground(GymPalette.canvas)
      } else {
        ContentUnavailableView("This workout is no longer here", systemImage: "clock").listRowBackground(GymPalette.canvas)
      }
    }.listStyle(.insetGrouped).modifier(GymPage())
      .modifier(TitledPage(title: session?.name ?? Readout.noRoutine, subtitle: session.map(LogPresentation.span)))
      .toolbar(.hidden, for: .tabBar).accessibilityIdentifier("gym-session-detail")
      .toolbar {
        if session != nil {
          ToolbarItem(placement: .topBarTrailing) {
            Button { sharing = true } label: { Image(systemName: "square.and.arrow.up") }
              .accessibilityLabel("Share this workout").accessibilityIdentifier("gym-session-share")
          }
          ToolbarItem(placement: .topBarTrailing) {
            Menu {
              Button("Discard workout", role: .destructive) { discard() }
                .accessibilityIdentifier("gym-session-discard")
            } label: { Image(systemName: "ellipsis.circle") }
              .accessibilityLabel("More").accessibilityIdentifier("gym-session-more")
              .disabled(gym.accountTransition)
          }
        }
      }
      .safeAreaInset(edge: .bottom) { GymTransient(gym: gym, errorIdentifier: "gym-log-error", undoIdentifier: "gym-log-undo") }
      .sheet(isPresented: Binding(get: { fixing != nil }, set: { if !$0 { fixing = nil } })) {
        if let fixing { SetEditor(gym: gym, set: fixing, routine: session?.plan?.routine, identifier: "gym-fix") }
      }
      .sheet(isPresented: $sharing) { SessionShareSheet(gym: gym, sessionID: sessionID) }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "session"]) }
  }

  func setRow(_ set: TrainingSet, number: Int, comparison: String?) -> some View {
    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: RoomSpace.small))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: RoomSpace.related))
    return Button { fixing = set } label: {
      VStack(alignment: .leading, spacing: RoomSpace.small) {
        layout {
          Text("\(number) · \(Readout.effort(weightKg: set.weightKg, reps: set.reps))")
            .monospacedDigit().foregroundStyle(set.kind == "warmup" ? GymPalette.inkDim : GymPalette.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
          if let comparison { Text(comparison).font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim) }
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

  func discard() {
    guard let outcome = gym.run(DiscardSession(sessionID)), outcome.refusal == nil else { return }
    dismiss()
  }
}
