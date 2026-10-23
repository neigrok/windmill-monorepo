import SwiftUI
import DomainKit
import GymDomain

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
        let tiles = facts(progress)
        if !tiles.isEmpty {
          Section {
            FactTiles(facts: tiles, ground: .own)
          }.listRowBackground(Color.clear).listRowInsets(EdgeInsets())
        }
        if !progress.estimates.isEmpty { strength(progress, log: log, dates: dates) }
        if progress.records.count > 1 {
          Section("Earlier records") {
            ForEach(progress.records.reversed().filter { $0.id != progress.best?.id }, id: \.id) { record in
              if let fact = record.fact.estimate {
                VStack(alignment: .leading, spacing: RoomSpace.small) {
                  Text("\(Readout.effort(weightKg: fact.weightKg, reps: fact.reps)) · \(Readout.estimate(fact.e1rm))").font(.body.monospaced())
                  Text(dates.day(record.startedAt)).font(.footnote).foregroundStyle(GymPalette.inkDim)
                }.foregroundStyle(GymPalette.ink).accessibilityElement(children: .combine).listRowSeparator(.hidden)
              }
            }
          }.listRowBackground(GymPalette.card)
        }
      }
    }.listStyle(.insetGrouped).listSectionSpacing(.compact).contentMargins(.top, RoomSpace.small, for: .scrollContent).modifier(GymPage())
      .roomTitle(movement?.name ?? "Movement", subtitle: movement.map { MovementEquipment($0).title })
      .gymTabBar()
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          MoreMenu(identifier: "gym-record-more") {
            Button("Edit movement", systemImage: "pencil") { renaming = true }.accessibilityIdentifier("gym-record-rename")
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

  // The chart says its window in its line, *last 12 weeks · 28 workouts*, which its readout takes over while scrubbing.
  func strength(_ progress: MovementProgress, log: TrainingLog, dates: GymDate) -> some View {
    let display = all ? progress : progress.window(now: log.moment.now, zone: log.moment.zone)
    let caption = window.line(recent: "12 weeks", holding: GymCount.of(display.sessions.count, "workout"))
    let points = display.logPlotPoints(dates)
    return Section {
      VStack(alignment: .leading, spacing: 12) {
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
          Text(caption).font(.footnote.monospaced()).foregroundStyle(GymPalette.inkDim)
        }
        if display.estimates.isEmpty { Text("No eligible estimate in this window.").font(.subheadline).foregroundStyle(GymPalette.inkDim) }
      }
    } header: {
      HStack {
        Text("Estimated strength").font(.body.weight(.semibold)).foregroundStyle(GymPalette.ink)
        Spacer(minLength: RoomSpace.related)
        ChartWindowPicker(recent: "12 weeks", identifier: "gym-record-window", window: $window).frame(maxWidth: 160)
      }.textCase(nil).listRowInsets(EdgeInsets())
    }.listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 14, trailing: 0))
  }

  // The standing records, each once: the best estimate and the heaviest load lifted.
  func facts(_ progress: MovementProgress) -> [FactTiles.Fact] {
    [progress.best?.fact.estimate.map { FactTiles.Fact(value: "\(Readout.estimatedWeight($0.e1rm)) kg", label: "Best e1RM", identifier: "gym-record-best") },
     progress.heaviest.flatMap { $0.fact.heaviest.weightKg == 0 ? nil : $0.fact.heaviest }
       .map { FactTiles.Fact(value: "\(Readout.weight($0.weightKg)) kg", label: "Heaviest", identifier: "gym-record-heaviest") }]
      .compactMap { $0 }
  }
}
