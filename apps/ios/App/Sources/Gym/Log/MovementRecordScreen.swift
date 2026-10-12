import SwiftUI
import UIKit
import DomainKit
import GymDomain
import SyncAPI

struct MovementRecordScreen: View {
  enum Window: Hashable { case recent, all }
  let gym: GymModel
  let exerciseID: ID<Exercise>
  @State private var window = Window.recent
  @State var renaming = false
  var movement: Exercise? { gym.catalogue.find(exerciseID) }
  var progress: MovementProgress? { gym.log?.progress.movement(exerciseID) }
  var ready: Bool { !gym.readFailed && (gym.isAnonymous || gym.log?.firstPullComplete == true) }
  var all: Bool { window == .all }
  var body: some View {
    List {
      if gym.readFailed {
        EmptyView() // the transient band owns a failed read and its retry
      } else if !ready { Text("Your full training record needs a connection to finish syncing.").listRowBackground(GymPalette.card) }
      else if let progress, let log = gym.log {
        Section {
          Text(movement?.equipment.capitalized ?? "Movement").font(.subheadline).foregroundStyle(GymPalette.inkDim)
          if progress.sessions.isEmpty && !gym.sets.contains(where: { $0.exerciseId == exerciseID }) {
            Text("Nothing logged for this movement yet. The first set you log lands here.").accessibilityIdentifier("gym-record-empty")
          }
        }.listRowBackground(GymPalette.card)
        let tiles = facts(progress)
        if !tiles.isEmpty { Section { FactTiles(facts: tiles) }.listRowBackground(GymPalette.card) }
        if !progress.estimates.isEmpty {
          let display = all ? progress : progress.window(now: log.moment.now, zone: log.moment.zone)
          Section("Estimated strength") {
            VStack(alignment: .leading, spacing: 12) {
              RecordWindowPicker(window: $window).frame(height: 32)
              if display.hasChart(in: log.moment.zone), let first = display.logPlotPoints.first {
                LogDatedChart(points: display.logPlotPoints, from: all ? first.date : LogPresentation.date(log.moment.today.adding(days: -84)), through: LogPresentation.date(log.moment.now), gapDays: MovementProgress.gapDays, bestID: progress.best?.id.description)
                  .accessibilityIdentifier("gym-record-chart")
              } else if let best = display.best?.fact.estimate {
                Text("Best so far: \(Readout.estimate(best.e1rm)), from \(Readout.effort(weightKg: best.weightKg, reps: best.reps)).")
                  .font(.subheadline.monospacedDigit())
              }
              Text("\(all ? "All" : "Last 12 weeks") · \(display.sessions.count) \(display.sessions.count == 1 ? "session" : "sessions")")
                .font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
              if display.estimates.isEmpty { Text("No eligible estimate in this window.").font(.subheadline).foregroundStyle(GymPalette.inkDim) }
            }
          }.listRowBackground(GymPalette.card)
        } else if !progress.sessions.isEmpty && (progress.heaviest?.fact.heaviest.weightKg ?? 0) > 0 {
          Section { Text("No eligible estimate yet. Estimates use 1–10 reps at effort 7 or higher, or unrated sets.").font(.subheadline).foregroundStyle(GymPalette.inkDim) }
            .listRowBackground(GymPalette.card)
        }
        if progress.records.count > 1 {
          Section("Personal records") {
            ForEach(progress.records.reversed(), id: \.id) { record in
              if let fact = record.fact.estimate {
                VStack(alignment: .leading, spacing: 4) {
                  Text("\(Readout.effort(weightKg: fact.weightKg, reps: fact.reps)) · \(Readout.estimate(fact.e1rm))").font(.body.monospacedDigit())
                  Text(LogPresentation.brief(LogPresentation.date(record.startedAt))).font(.caption).foregroundStyle(GymPalette.inkDim)
                }.foregroundStyle(record.id == progress.best?.id ? GymPalette.record : GymPalette.ink)
              }
            }
          }.listRowBackground(GymPalette.card)
        }
        let recent = gym.finishedLogSessions.filter { session in log.sets(session: session.id).contains { $0.exerciseId == exerciseID } }.prefix(10)
        if !recent.isEmpty { Section("Recent sets") {
          ForEach(recent, id: \.id) { session in
            let sets = log.sets(session: session.id).filter { $0.exerciseId == exerciseID }
            VStack(alignment: .leading, spacing: 5) {
              Text(LogPresentation.brief(LogPresentation.date(session.startedAt))).font(.caption).foregroundStyle(GymPalette.inkDim)
              Text(sets.map { Readout.effort(weightKg: $0.weightKg, reps: $0.reps) + ($0.kind == "working" ? "" : " \($0.kind)") }.joined(separator: " · "))
                .font(.body.monospacedDigit()).fixedSize(horizontal: false, vertical: true)
            }
          }
        }.listRowBackground(GymPalette.card) }
      }
    }.listStyle(.insetGrouped).modifier(GymPage())
      .navigationTitle(movement?.name ?? "Movement").navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .tabBar)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Rename") { renaming = true }.disabled(gym.readFailed || gym.accountTransition || movement == nil) } }
      .safeAreaInset(edge: .bottom) { GymTransient(gym: gym, errorIdentifier: "gym-log-error", undoIdentifier: "gym-log-undo") }
      .sheet(isPresented: $renaming) { if let movement { RenameMovementSheet(gym: gym, exercise: movement) } }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "record"]) }
      .accessibilityIdentifier("gym-movement-record")
  }
  func facts(_ progress: MovementProgress) -> [FactTiles.Fact] {
    let best = progress.best.flatMap { best in best.fact.estimate.map { estimate in
      FactTiles.Fact(value: "\(Readout.estimatedWeight(estimate.e1rm)) kg",
                     label: "Best e1RM · \(LogPresentation.brief(LogPresentation.date(best.startedAt)))", record: true, identifier: "gym-record-best")
    } }
    let efforts = LogPresentation.progressEfforts(progress).map { effort in
      effort.weightKg == 0
        ? FactTiles.Fact(value: "\(effort.reps) reps", label: "Most reps · no added load", identifier: "gym-record-bodyweight-reps")
        : FactTiles.Fact(value: "\(Readout.weight(effort.weightKg)) kg", label: "Heaviest · \(effort.reps) reps", identifier: "gym-record-heaviest")
    }
    return [best].compactMap { $0 } + efforts
  }
}

private struct RecordWindowPicker: UIViewRepresentable {
  @Binding var window: MovementRecordScreen.Window
  func makeCoordinator() -> Coordinator { Coordinator(window: $window) }
  func makeUIView(context: Context) -> UISegmentedControl {
    let control = UISegmentedControl(items: ["12 weeks", "All"])
    control.accessibilityIdentifier = "gym-record-window"
    control.accessibilityLabel = "Window"
    control.addTarget(context.coordinator, action: #selector(Coordinator.changed), for: .valueChanged)
    return control
  }
  func updateUIView(_ control: UISegmentedControl, context: Context) {
    context.coordinator.window = $window
    control.selectedSegmentIndex = window == .all ? 1 : 0
  }
  final class Coordinator: NSObject {
    var window: Binding<MovementRecordScreen.Window>
    init(window: Binding<MovementRecordScreen.Window>) { self.window = window }
    @objc func changed(_ control: UISegmentedControl) {
      window.wrappedValue = control.selectedSegmentIndex == 1 ? .all : .recent
    }
  }
}
