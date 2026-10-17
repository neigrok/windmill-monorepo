import SwiftUI
import DomainKit
import GymDomain
import SyncAPI

struct SessionDetailScreen: View {
  let gym: GymModel
  let sessionID: ID<Session>
  @Environment(\.dismiss) var dismiss
  @Environment(\.gymShareSession) private var share
  @State var fixing: TrainingSet?
  var session: Session? { gym.sessions.first { $0.id == sessionID } }
  var sets: [TrainingSet] { gym.log?.sets(session: sessionID) ?? [] }

  var body: some View {
    List {
      if let session {
        let readout = SessionReadout(session: session, sets: sets)
        Section {
          FactTiles(readout)
        } footer: {
          let lines = [session.closedBy == "stale" ? "Closed after four hours without a set" : nil,
                       gym.sessionIsUnsent(sessionID) ? "On this phone, not yet on your account." : nil,
                       sets.isEmpty ? "No sets in this workout." : nil].compactMap { $0 }
          if !lines.isEmpty { Text(lines.joined(separator: "\n")).foregroundStyle(GymPalette.inkDim).accessibilityIdentifier("gym-session-footer") }
        }.listRowBackground(GymPalette.card)
        ForEach(SetRow.movements(sets), id: \.self) { id in
          let mine = sets.filter { $0.exerciseId == id }
          Section {
            NavigationLink { MovementRecordScreen(gym: gym, exerciseID: id) } label: {
              GymRow(title: gym.catalogue.find(id)?.name ?? "Movement", meta: LogPresentation.planLine(id, plan: session.plan))
            }.accessibilityIdentifier("gym-session-movement")
            ForEach(Array(mine.enumerated()), id: \.element.id) { index, set in
              Button { fixing = set } label: {
                SetRow(marker: SetRow.marker(set, in: mine), set: set,
                       caption: LogPresentation.comparison(set, preceding: Array(mine.prefix(index)), plan: session.plan))
              }.accessibilityIdentifier("gym-finished-set-\(set.id)")
                .swipeActions { Button("Delete", role: .destructive) { gym.run(DeleteSet(set.id)) } }
                .contextMenu { Button("Fix set", systemImage: "pencil") { fixing = set }; Button("Delete set", systemImage: "trash", role: .destructive) { gym.run(DeleteSet(set.id)) } }
                .accessibilityAction(named: "Delete set") { gym.run(DeleteSet(set.id)) }
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
      .roomTitle(session?.name ?? Readout.noRoutine, subtitle: session.map { gym.dates.span($0.startedAt, $0.finishedAt) })
      .gymTabBar().accessibilityIdentifier("gym-session-detail")
      .toolbar {
        if session != nil {
          ToolbarItem(placement: .topBarTrailing) {
            Button { share?(sessionID) } label: { Image(systemName: "square.and.arrow.up") }
              .accessibilityLabel("Share this workout").accessibilityIdentifier("gym-session-share")
          }
          ToolbarItem(placement: .topBarTrailing) {
            MoreMenu(identifier: "gym-session-more") {
              Button("Discard workout", systemImage: "trash", role: .destructive) {
                if let outcome = gym.run(DiscardSession(sessionID)), outcome.refusal == nil { dismiss() }
              }.accessibilityIdentifier("gym-session-discard")
            }.disabled(gym.accountTransition)
          }
        }
      }.roomBar(.gym)
      .reachBand { GymTransient(gym: gym, errorIdentifier: "gym-log-error", undoIdentifier: "gym-log-undo") }
      .sheet(isPresented: Binding(get: { fixing != nil }, set: { if !$0 { fixing = nil } })) {
        if let fixing { SetEditor(gym: gym, set: fixing, routine: session?.plan?.routine, identifier: "gym-fix") }
      }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "session"]) }
  }
}
