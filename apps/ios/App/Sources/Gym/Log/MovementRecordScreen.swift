import SwiftUI
import DomainKit
import GymDomain
import SyncAPI

struct MovementRecordScreen: View {
  let gym: GymModel
  let exerciseID: ID<Exercise>
  @State private var window = ChartWindow.recent
  @State var renaming = false
  var movement: Exercise? { gym.catalogue.find(exerciseID) }
  var progress: MovementProgress? { gym.log?.progress.movement(exerciseID) }
  var syncing: Bool { !gym.isAnonymous && gym.log?.firstPullComplete == false }
  var all: Bool { window == .all }

  var body: some View {
    List {
      if syncing && !gym.readFailed {
        ContentUnavailableView("Still syncing", systemImage: "arrow.triangle.2.circlepath",
                               description: Text("Your full training record needs a connection to finish syncing."))
          .listRowBackground(GymPalette.canvas)
      } else if let progress, let log = gym.log {
        if progress.sessions.isEmpty && !gym.sets.contains(where: { $0.exerciseId == exerciseID }) {
          ContentUnavailableView {
            Label("Nothing logged yet", systemImage: "chart.xyaxis.line")
          } description: {
            Text("The first set you log lands here.").accessibilityIdentifier("gym-record-empty")
          }.listRowBackground(GymPalette.canvas)
        }
        let tiles = facts(progress)
        if !tiles.isEmpty {
          Section {
            FactTiles(facts: tiles)
          } footer: {
            if progress.estimates.isEmpty && (progress.heaviest?.fact.heaviest.weightKg ?? 0) > 0 {
              Text("Estimates need 1–10 reps, unrated or at effort 7 or more.").foregroundStyle(GymPalette.inkDim)
            }
          }.listRowBackground(GymPalette.card)
        }
        if !progress.estimates.isEmpty { strength(progress, log: log) }
        if progress.records.count > 1 {
          Section("Personal records") {
            ForEach(progress.records.reversed(), id: \.id) { record in
              if let fact = record.fact.estimate {
                VStack(alignment: .leading, spacing: RoomSpace.small) {
                  Text("\(Readout.effort(weightKg: fact.weightKg, reps: fact.reps)) · \(Readout.estimate(fact.e1rm))").monospacedDigit()
                  Text(LogPresentation.brief(LocalDay(record.startedAt, in: log.moment.zone), today: log.moment.today)).font(.footnote).foregroundStyle(GymPalette.inkDim)
                }.foregroundStyle(record.id == progress.best?.id ? GymPalette.record : GymPalette.ink)
              }
            }
          }.listRowBackground(GymPalette.card)
        }
        let recent = gym.finishedLogSessions.filter { session in log.sets(session: session.id).contains { $0.exerciseId == exerciseID } }.prefix(10)
        if !recent.isEmpty {
          Section("Recent sets") {
            ForEach(recent, id: \.id) { session in
              let sets = log.sets(session: session.id).filter { $0.exerciseId == exerciseID }
              VStack(alignment: .leading, spacing: RoomSpace.small) {
                Text(LogPresentation.brief(LocalDay(session.startedAt, in: log.moment.zone), today: log.moment.today)).font(.footnote).foregroundStyle(GymPalette.inkDim)
                Text(sets.map { Readout.effort(weightKg: $0.weightKg, reps: $0.reps) + ($0.kind == "working" ? "" : " \($0.kind)") }.joined(separator: " · "))
                  .monospacedDigit().foregroundStyle(GymPalette.ink).fixedSize(horizontal: false, vertical: true)
              }
            }
          }.listRowBackground(GymPalette.card)
        }
      }
    }.listStyle(.insetGrouped).modifier(GymPage())
      .modifier(TitledPage(title: movement?.name ?? "Movement", subtitle: movement?.equipment.capitalized))
      .toolbar(.hidden, for: .tabBar)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            Button("Rename movement", systemImage: "pencil") { renaming = true }.accessibilityIdentifier("gym-record-rename")
          } label: { Image(systemName: "ellipsis.circle") }
            .accessibilityLabel("More").accessibilityIdentifier("gym-record-more")
            .disabled(gym.readFailed || gym.accountTransition || movement == nil)
        }
      }
      .safeAreaInset(edge: .bottom) { GymTransient(gym: gym, errorIdentifier: "gym-log-error", undoIdentifier: "gym-log-undo") }
      .sheet(isPresented: $renaming) { if let movement { RenameMovementSheet(gym: gym, exercise: movement) } }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "record"]) }
      .accessibilityIdentifier("gym-movement-record")
  }

  func strength(_ progress: MovementProgress, log: TrainingLog) -> some View {
    let display = all ? progress : progress.window(now: log.moment.now, zone: log.moment.zone)
    return Section("Estimated strength") {
      VStack(alignment: .leading, spacing: 12) {
        ChartWindowPicker(recent: "12 weeks", identifier: "gym-record-window", window: $window)
        if display.hasChart(in: log.moment.zone), let first = display.logPlotPoints.first {
          LogDatedChart(points: display.logPlotPoints, from: all ? first.date : LogPresentation.date(log.moment.today.adding(days: -84)),
                        through: LogPresentation.date(log.moment.now), series: .strength, bestID: progress.best?.id.description)
            .accessibilityIdentifier("gym-record-chart")
        } else if let best = display.best, best.id != progress.best?.id, let estimate = best.fact.estimate {
          Text("Best in 12 weeks: \(Readout.estimate(estimate.e1rm)), from \(Readout.effort(weightKg: estimate.weightKg, reps: estimate.reps)).")
            .font(.subheadline).monospacedDigit().foregroundStyle(GymPalette.ink)
        }
        Text("\(all ? "All" : "Last 12 weeks") · \(Readout.count(display.sessions.count, "session"))")
          .font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim)
        if display.estimates.isEmpty { Text("No eligible estimate in this window.").font(.subheadline).foregroundStyle(GymPalette.inkDim) }
      }
    }.listRowBackground(GymPalette.card)
  }

  func facts(_ progress: MovementProgress) -> [FactTiles.Fact] {
    let best = progress.best.flatMap { best in best.fact.estimate.map { estimate in
      FactTiles.Fact(value: "\(Readout.estimatedWeight(estimate.e1rm)) kg",
                     label: "Best e1RM · \(LogPresentation.brief(LogPresentation.date(best.startedAt)))", record: true, identifier: "gym-record-best")
    } }
    let efforts = LogPresentation.progressEfforts(progress).map { effort in
      effort.weightKg == 0
        ? FactTiles.Fact(value: Readout.count(effort.reps, "rep"), label: "Most reps · no added load", identifier: "gym-record-bodyweight-reps")
        : FactTiles.Fact(value: "\(Readout.weight(effort.weightKg)) kg", label: "Heaviest · \(Readout.count(effort.reps, "rep"))", identifier: "gym-record-heaviest")
    }
    return [best].compactMap { $0 } + efforts
  }
}
