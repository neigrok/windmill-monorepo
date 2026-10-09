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
        if let best = progress.best?.fact.estimate {
          Section {
            VStack(alignment: .leading, spacing: 5) {
              Text("Best e1RM").font(.caption).foregroundStyle(GymPalette.inkDim)
              Text(Readout.estimatedWeight(best.e1rm)).font(.largeTitle.monospacedDigit().weight(.bold)).foregroundStyle(GymPalette.record)
              Text("kg · \(LogPresentation.brief(LogPresentation.date(progress.best!.startedAt)))").font(.subheadline.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
            }.accessibilityIdentifier("gym-record-best")
          }.listRowBackground(GymPalette.card)
        }
        ForEach(LogPresentation.progressEfforts(progress), id: \.setId) { heaviest in
          Section {
            VStack(alignment: .leading, spacing: 5) {
              Text(heaviest.weightKg == 0 ? "Most reps" : "Heaviest").font(.caption).foregroundStyle(GymPalette.inkDim)
              Text(heaviest.weightKg == 0 ? String(heaviest.reps) : Readout.weight(heaviest.weightKg))
                .font(.largeTitle.monospacedDigit().weight(.bold))
              Text(heaviest.weightKg == 0 ? "reps · no added load" : "kg · \(heaviest.reps) reps").font(.subheadline.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
            }.accessibilityIdentifier(heaviest.weightKg == 0 ? "gym-record-bodyweight-reps" : "gym-record-heaviest")
          }.listRowBackground(GymPalette.card)
        }
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
      .sheet(isPresented: $renaming) { if let movement { LogRenameSheet(gym: gym, movement: movement) } }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "record"]) }
      .accessibilityIdentifier("gym-movement-record")
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

struct LogRenameSheet: View {
  let gym: GymModel
  let movement: Exercise
  let account: String?
  @Environment(\.dismiss) var dismiss
  @State var name: String
  @State var failure: String?
  init(gym: GymModel, movement: Exercise) { self.gym = gym; self.movement = movement; account = gym.account; _name = State(initialValue: movement.name) }
  var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping }
  var problem: String? { trimmed.isEmpty ? "Name it to save it" : trimmed.unicodeScalars.count > 60 ? "Use 60 characters or fewer" : nil }
  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Name", text: $name).autocorrectionDisabled().accessibilityIdentifier("gym-rename-name")
          Text("\(trimmed.unicodeScalars.count) / 60").font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
          if let message = failure ?? problem { Text(message).foregroundStyle(GymPalette.alarm) }
          Text("Renames this movement everywhere.")
          Text("Your logged sets and records keep the same movement.").font(.subheadline).foregroundStyle(GymPalette.inkDim)
          Text("Old name: \(movement.name)\nSearchable as an alias.").font(.subheadline).foregroundStyle(GymPalette.inkDim)
        }.listRowBackground(GymPalette.card)
      }.modifier(GymPage())
        .navigationTitle("Rename movement").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) { Button("Rename") { rename() }.disabled(problem != nil || trimmed == movement.name || gym.accountTransition) }
        }
    }.modifier(GymPage()).presentationDetents([.medium]).accessibilityIdentifier("gym-rename-sheet")
      .onChange(of: name) { _, _ in failure = nil }
      .onChange(of: gym.account) { _, _ in dismiss() }
  }
  func rename() {
    gym.refresh()
    guard gym.account == account, !gym.readFailed, gym.catalogue.find(movement.id)?.name == movement.name else { failure = "That movement changed. Review its name."; return }
    if gym.isAnonymous && SeedExercises.all.contains(where: { $0.id == movement.id }) { failure = "renaming a catalog movement needs your account — sign in first"; return }
    guard let result = gym.run(RenameExercise(movement.id, name: trimmed)), result.refusal == nil else { failure = gym.error ?? "That movement kept its name."; return }
    dismiss()
  }
}
