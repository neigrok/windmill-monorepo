import SwiftUI
import UIKit
import DomainKit
import GymDomain
import SyncAPI

struct MovementRecordScreen: View {
  enum Window: Hashable { case recent, all }
  let gym: GymModel
  let exerciseID: ID<Exercise>
  @Environment(\.colorScheme) var scheme
  @State private var window = Window.recent
  @State var renaming = false
  var palette: LogPalette { LogPalette(dark: scheme == .dark) }
  var movement: Exercise? { gym.catalogue.find(exerciseID) }
  var progress: MovementProgress? { gym.log?.progress.movement(exerciseID) }
  var ready: Bool { !gym.readFailed && (gym.isAnonymous || gym.log?.firstPullComplete == true) }
  var all: Bool { window == .all }
  var body: some View {
    List {
      if gym.readFailed {
        Section { Text("Record unavailable").font(.headline); Text("Your record could not be read."); Button("Try again") { gym.refresh() } }.listRowBackground(palette.surface)
      } else if !ready { ProgressView("Reading your log…").listRowBackground(palette.surface) }
      else if let progress, let log = gym.log {
        Section {
          Text(movement?.equipment.capitalized ?? "Movement").font(.subheadline).foregroundStyle(palette.dim)
          if progress.sessions.isEmpty && !gym.sets.contains(where: { $0.exerciseId == exerciseID }) {
            Text("Nothing logged for this movement yet. The first set you log lands here.").accessibilityIdentifier("gym-record-empty")
          }
        }.listRowBackground(palette.surface)
        if let best = progress.best?.fact.estimate {
          Section {
            VStack(alignment: .leading, spacing: 5) {
              Text("Best e1RM").font(.caption).foregroundStyle(palette.dim)
              Text(Readout.estimatedWeight(best.e1rm)).font(.largeTitle.monospaced().weight(.bold)).foregroundStyle(palette.record)
              Text("kg · \(LogPresentation.brief(LogPresentation.date(progress.best!.startedAt)))").font(.subheadline.monospaced()).foregroundStyle(palette.dim)
            }.accessibilityIdentifier("gym-record-best")
          }.listRowBackground(palette.surface)
        }
        ForEach(LogPresentation.progressEfforts(progress), id: \.setId) { heaviest in
          Section {
            VStack(alignment: .leading, spacing: 5) {
              Text(heaviest.weightKg == 0 ? "Most reps" : "Heaviest").font(.caption).foregroundStyle(palette.dim)
              Text(heaviest.weightKg == 0 ? String(heaviest.reps) : Readout.weight(heaviest.weightKg))
                .font(.largeTitle.monospaced().weight(.bold))
              Text(heaviest.weightKg == 0 ? "reps · no added load" : "kg · \(heaviest.reps) reps").font(.subheadline.monospaced()).foregroundStyle(palette.dim)
            }.accessibilityIdentifier(heaviest.weightKg == 0 ? "gym-record-bodyweight-reps" : "gym-record-heaviest")
          }.listRowBackground(palette.surface)
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
                  .font(.subheadline.monospaced())
              }
              Text("\(all ? "All" : "Last 12 weeks") · \(display.sessions.count) \(display.sessions.count == 1 ? "session" : "sessions")")
                .font(.caption.monospaced()).foregroundStyle(palette.dim)
              if display.estimates.isEmpty { Text("No eligible estimate in this window.").font(.subheadline).foregroundStyle(palette.dim) }
            }
          }.listRowBackground(palette.surface)
        } else if !progress.sessions.isEmpty && (progress.heaviest?.fact.heaviest.weightKg ?? 0) > 0 {
          Section { Text("No eligible estimate yet. Estimates use 1–10 reps at effort 7 or higher, or unrated sets.").font(.subheadline).foregroundStyle(palette.dim) }
            .listRowBackground(palette.surface)
        }
        if progress.records.count > 1 {
          Section("Personal records") {
            ForEach(progress.records.reversed(), id: \.id) { record in
              if let fact = record.fact.estimate {
                VStack(alignment: .leading, spacing: 4) {
                  Text("\(Readout.effort(weightKg: fact.weightKg, reps: fact.reps)) · \(Readout.estimate(fact.e1rm))").font(.body.monospaced())
                  Text(LogPresentation.brief(LogPresentation.date(record.startedAt))).font(.caption).foregroundStyle(palette.dim)
                }.foregroundStyle(record.id == progress.best?.id ? palette.record : palette.ink)
              }
            }
          }.listRowBackground(palette.surface)
        }
        let recent = gym.finishedLogSessions.filter { session in log.sets(session: session.id).contains { $0.exerciseId == exerciseID } }.prefix(10)
        if !recent.isEmpty { Section("Recent sets") {
          ForEach(recent, id: \.id) { session in
            let sets = log.sets(session: session.id).filter { $0.exerciseId == exerciseID }
            VStack(alignment: .leading, spacing: 5) {
              Text(LogPresentation.brief(LogPresentation.date(session.startedAt))).font(.caption).foregroundStyle(palette.dim)
              Text(sets.map { Readout.effort(weightKg: $0.weightKg, reps: $0.reps) + ($0.kind == "working" ? "" : " \($0.kind)") }.joined(separator: " · "))
                .font(.body.monospaced()).fixedSize(horizontal: false, vertical: true)
            }
          }
        }.listRowBackground(palette.surface) }
      }
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden).background(palette.canvas).foregroundStyle(palette.ink).tint(palette.accent)
      .navigationTitle(movement?.name ?? "Movement").navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .tabBar)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Rename") { renaming = true }.disabled(!ready || movement == nil) } }
      .safeAreaInset(edge: .bottom) { LogNoticeBand(gym: gym) }
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
  @Environment(\.colorScheme) var scheme
  @State var name: String
  @State var failure: String?
  init(gym: GymModel, movement: Exercise) { self.gym = gym; self.movement = movement; account = gym.account; _name = State(initialValue: movement.name) }
  var palette: LogPalette { LogPalette(dark: scheme == .dark) }
  var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping }
  var problem: String? { trimmed.isEmpty ? "Name it to save it" : trimmed.unicodeScalars.count > 60 ? "Use 60 characters or fewer" : nil }
  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Name", text: $name).autocorrectionDisabled().accessibilityIdentifier("gym-rename-name")
          Text("\(trimmed.unicodeScalars.count) / 60").font(.caption.monospaced()).foregroundStyle(palette.dim)
          if let message = failure ?? problem { Text(message).foregroundStyle(palette.alarm) }
          Text("Renames this movement everywhere.")
          Text("Your logged sets and records keep the same movement.").font(.subheadline).foregroundStyle(palette.dim)
          Text("Old name: \(movement.name)\nSearchable as an alias.").font(.subheadline).foregroundStyle(palette.dim)
        }.listRowBackground(palette.surface)
      }.scrollContentBackground(.hidden).background(palette.canvas).foregroundStyle(palette.ink)
        .navigationTitle("Rename movement").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) { Button("Rename") { rename() }.disabled(problem != nil || trimmed == movement.name || gym.accountTransition) }
        }
    }.tint(palette.accent).presentationDetents([.medium, .large]).accessibilityIdentifier("gym-rename-sheet")
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
