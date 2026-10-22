import SwiftUI
import DomainKit
import GymDomain
import SyncAPI

struct MovementRecordScreen: View {
  let gym: GymModel
  let exerciseID: ID<Exercise>
  // The session a moment opened this Record at: the chart's window holds it and its point is marked.
  let selected: ID<Session>?
  @State private var window: ChartWindow
  @State var renaming = false
  var movement: Exercise? { gym.catalogue.find(exerciseID) }
  var progress: MovementProgress? { gym.logRecords?.progress.movement(exerciseID) }
  var syncing: Bool { !gym.isAnonymous && gym.log?.firstPullComplete == false }
  var all: Bool { window == .all }

  init(gym: GymModel, exerciseID: ID<Exercise>, selected: ID<Session>? = nil) {
    self.gym = gym; self.exerciseID = exerciseID; self.selected = selected
    let recent = gym.log.flatMap { log in gym.logRecords?.progress.movement(exerciseID).window(now: log.moment.now, zone: log.moment.zone) }
    let outside = selected.map { id in recent?.sessions.contains { $0.id == id } == false } ?? false
    _window = State(initialValue: outside ? .all : .recent)
  }

  var body: some View {
    List {
      if syncing && !gym.readFailed {
        ContentUnavailableView("Still syncing", systemImage: "arrow.triangle.2.circlepath",
                               description: Text("Your full training record needs a connection to finish syncing."))
          .listRowBackground(GymPalette.canvas)
      } else if let progress, let log = gym.log {
        let dates = gym.dates
        if progress.sessions.isEmpty && !gym.sets.contains(where: { $0.exerciseId == exerciseID }) {
          ContentUnavailableView {
            Label("Nothing logged yet", systemImage: "chart.xyaxis.line")
          } description: {
            Text("The first set you log lands here.").accessibilityIdentifier("gym-record-empty")
          }.listRowBackground(GymPalette.canvas)
        }
        let tiles = facts(progress, dates: dates)
        if !tiles.isEmpty {
          Section {
            FactTiles(facts: tiles)
          } footer: {
            if progress.estimates.isEmpty && (progress.heaviest?.fact.heaviest.weightKg ?? 0) > 0 {
              Text("Estimates need 1–10 reps, unrated or at effort 7 or more.").foregroundStyle(GymPalette.inkDim)
            }
          }.listRowBackground(GymPalette.card)
        }
        if !progress.estimates.isEmpty { strength(progress, log: log, dates: dates) }
        if progress.records.count > 1 {
          Section("Earlier records") {
            ForEach(progress.records.reversed().filter { $0.id != progress.best?.id }, id: \.id) { record in
              if let fact = record.fact.estimate {
                VStack(alignment: .leading, spacing: RoomSpace.small) {
                  Text("\(Readout.effort(weightKg: fact.weightKg, reps: fact.reps)) · \(Readout.estimate(fact.e1rm))").monospacedDigit()
                  Text(dates.day(record.startedAt)).font(.footnote).foregroundStyle(GymPalette.inkDim)
                }.foregroundStyle(GymPalette.ink)
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
                Text(dates.day(session.startedAt)).font(.footnote).foregroundStyle(GymPalette.inkDim)
                Text(sets.map { Readout.effort(weightKg: $0.weightKg, reps: $0.reps) }.joined(separator: " · "))
                  .monospacedDigit().foregroundStyle(GymPalette.ink).fixedSize(horizontal: false, vertical: true)
              }
            }
          }.listRowBackground(GymPalette.card)
        }
      }
    }.listStyle(.insetGrouped).modifier(GymPage())
      .roomTitle(movement?.name ?? "Movement", subtitle: movement.map { MovementEquipment($0).title + " · " + MovementEquipment($0).unit })
      .gymTabBar()
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          MoreMenu(identifier: "gym-record-more") {
            Button("Edit exercise", systemImage: "pencil") { renaming = true }.accessibilityIdentifier("gym-record-rename")
          }.disabled(gym.readFailed || gym.accountTransition || movement == nil)
        }
      }
      .reachBand { GymTransient(gym: gym, errorIdentifier: "gym-log-error") }
      .sheet(isPresented: $renaming) { if let movement { RenameMovementSheet(gym: gym, exercise: movement) } }
      .onAppear {
        gym.telemetry.event("gym_screen_viewed", properties: ["screen": "record"])
        if selected != nil { gym.telemetry.event("gym_moment_opened", properties: [:]) }
      }
      .accessibilityIdentifier("gym-movement-record")
  }

  // The chart says its window in its caption, *last 12 weeks · 28 workouts*, which its readout takes over while scrubbing.
  func strength(_ progress: MovementProgress, log: TrainingLog, dates: GymDate) -> some View {
    let display = all ? progress : progress.window(now: log.moment.now, zone: log.moment.zone)
    let caption = window.line(recent: "12 weeks", holding: GymCount.of(display.sessions.count, "workout"))
    let points = display.logPlotPoints(dates)
    return Section("Estimated strength") {
      VStack(alignment: .leading, spacing: 12) {
        ChartWindowPicker(recent: "12 weeks", identifier: "gym-record-window", window: $window)
        if display.hasChart(in: log.moment.zone), let first = points.first {
          LogDatedChart(points: points, from: all ? first.date : LogPresentation.date(log.moment.today.adding(days: -84)),
                        through: log.moment.now.date, series: .strength, dates: dates, caption: caption,
                        bestID: progress.best?.id.description, selected: selected?.description)
            .accessibilityIdentifier("gym-record-chart")
        } else {
          if let best = display.best, best.id != progress.best?.id, let estimate = best.fact.estimate {
            Text("Best in 12 weeks: \(Readout.estimate(estimate.e1rm)), from \(Readout.effort(weightKg: estimate.weightKg, reps: estimate.reps)).")
              .font(.subheadline).monospacedDigit().foregroundStyle(GymPalette.ink)
          }
          Text(caption).font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim)
        }
        if display.estimates.isEmpty { Text("No eligible estimate in this window.").font(.subheadline).foregroundStyle(GymPalette.inkDim) }
      }
    }.listRowBackground(GymPalette.card)
  }

  func facts(_ progress: MovementProgress, dates: GymDate) -> [FactTiles.Fact] {
    let best = progress.best.flatMap { best in best.fact.estimate.map { estimate in
      FactTiles.Fact(value: "\(Readout.estimatedWeight(estimate.e1rm)) kg",
                     label: "Best e1RM · \(dates.day(best.startedAt))", record: true, identifier: "gym-record-best")
    } }
    let efforts = LogPresentation.progressEfforts(progress).map { effort in
      effort.weightKg == 0
        ? FactTiles.Fact(value: GymCount.of(effort.reps, "rep"), label: "Most reps · no added load", identifier: "gym-record-bodyweight-reps")
        : FactTiles.Fact(value: "\(Readout.weight(effort.weightKg)) kg", label: "Heaviest · \(GymCount.of(effort.reps, "rep"))", identifier: "gym-record-heaviest")
    }
    return [best].compactMap { $0 } + efforts
  }
}
