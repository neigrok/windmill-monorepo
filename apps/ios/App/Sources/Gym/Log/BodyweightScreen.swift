import SwiftUI
import UIKit
import Foundation
import DomainKit
import GymDomain
import SyncCore

enum BodyweightLogInput {
  static let notANumber = "That is not a number yet."
  static let onePoint = "One decimal point only."
  static let outOfRange = "Between 20 and 400 kg — check the number."
  static let notAForecast = "A weigh-in is not a forecast — today or earlier."

  enum Parsed: Equatable {
    case weight(Double)
    case refused(String)
  }

  static func parse(_ typed: String) -> Parsed {
    let raw = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    let digit: (Character) -> Bool = { ("0"..."9").contains($0) }
    guard !raw.isEmpty, raw.contains(where: digit), raw.allSatisfy({ digit($0) || $0 == "." || $0 == "," }) else {
      return .refused(notANumber)
    }
    guard raw.filter({ $0 == "." || $0 == "," }).count <= 1 else { return .refused(onePoint) }
    guard var value = Decimal(string: raw.replacingOccurrences(of: ",", with: "."), locale: Locale(identifier: "en_US_POSIX")),
          !value.isNaN else { return .refused(notANumber) }
    guard value >= 20, value <= 400 else { return .refused(outOfRange) }
    var rounded = Decimal()
    NSDecimalRound(&rounded, &value, 2, .plain)
    return .weight(NSDecimalNumber(decimal: rounded).doubleValue)
  }

  static func kilograms(_ kg: Double) -> String {
    var value = Decimal(kg), rounded = Decimal()
    NSDecimalRound(&rounded, &value, 2, .plain)
    return NSDecimalNumber(decimal: rounded).stringValue
  }
}

extension GymModel {
  func logWeighInDraft(day: LocalDay) throws -> Draft<WeighIn> {
    let blank = WeighIn(day: day)
    return try runner.open(blank.id, orNew: blank)
  }

  @discardableResult
  func logSaveWeighIn(_ draft: inout Draft<WeighIn>) -> String? {
    switch save(&draft) {
    case .saved: return nil
    case .refused(let refusal):
      if case .future = refusal { return BodyweightLogInput.notAForecast }
      if case .invalid(let violation) = refusal {
        if violation.rule == WeighInRules.dayRule { return BodyweightLogInput.notAForecast }
        if violation.rule == WeighInRules.kg.path {
          return violation.reason == .notANumber ? BodyweightLogInput.notANumber : BodyweightLogInput.outOfRange
        }
      }
      return error ?? "That weigh-in could not be saved."
    case .failed:
      return accountTransition ? "Wait for the account change to finish." : "That weigh-in could not be saved. Try again."
    }
  }

  @discardableResult
  func logDeleteWeighIn(day: LocalDay) -> Bool {
    guard let outcome = run(DeleteWeighIn(ID(day))) else { return false }
    return outcome.refusal == nil
  }
}

struct BodyweightScreen: View {
  struct Selection: Identifiable {
    let entry: Bodyweight.Entry
    var id: LocalDay { entry.day }
  }
  enum Window: Hashable {
    case recent, all
    var domain: Bodyweight.Window { self == .recent ? .recent : .all }
  }
  let gym: GymModel
  @Environment(\.colorScheme) private var scheme
  @State private var window = Window.recent
  @State private var correcting: Selection?
  private var palette: LogPalette { LogPalette(dark: scheme == .dark) }

  var body: some View {
    List {
      if gym.readFailed {
        Section {
          Text("Your weigh-ins didn’t load.")
            .foregroundStyle(palette.dim)
          Button("Try again") { gym.refresh() }
            .accessibilityIdentifier("gym-bodyweight-retry")
        }.listRowBackground(palette.surface)
      } else if gym.bodyweight == nil || gym.bodyweight?.stance == .unknown {
        Section {
          Text("Reading your weigh-ins…")
            .foregroundStyle(palette.dim)
            .accessibilityIdentifier("gym-bodyweight-loading")
        }.listRowBackground(palette.surface)
      }
      if let weight = gym.bodyweight {
        if weight.stance == .empty && !gym.readFailed {
          Section {
            Text("No weigh-ins yet. Weigh in from the log.")
              .foregroundStyle(palette.dim)
              .accessibilityIdentifier("gym-bodyweight-empty")
          }.listRowBackground(palette.surface)
        } else if weight.stance == .holding {
          Section {
            BodyweightWindowPicker(window: $window).frame(height: 32)
            let chart = weight.chart(window.domain)
            if !chart.dots.isEmpty {
              LogDatedChart(points: chart.dots.map { entry in
                LogPlotPoint(id: entry.day.text, date: LogPresentation.date(entry.day), value: entry.kg,
                             label: "\(BodyweightLogInput.kilograms(entry.kg)) kg · \(LogPresentation.brief(LogPresentation.date(entry.day)))")
              }, from: LogPresentation.date(window == .recent ? weight.today.adding(days: -89) : chart.dots[0].day),
              through: LogPresentation.date(weight.today), gapDays: Bodyweight.gapDays, select: { id in
                guard let entry = weight.entries.first(where: { $0.day.text == id }) else { return }
                correcting = Selection(entry: entry)
              })
              .accessibilityIdentifier("gym-bodyweight-chart")
            } else if window == .recent && !gym.readFailed && gym.personalCounts[WeighIn.type, default: 0] == weight.entries.count {
              Text("no weigh-in in the last 90 days")
                .foregroundStyle(palette.dim)
                .accessibilityIdentifier("gym-bodyweight-window-empty")
            }
            Text("\(window == .recent ? "90 days" : "All") · \(chart.dots.count) \(chart.dots.count == 1 ? "weigh-in" : "weigh-ins")")
              .font(.footnote).foregroundStyle(palette.dim)
          } footer: {
            Text("Every point is a number you typed. Nothing here is estimated.")
              .foregroundStyle(palette.dim)
          }.listRowBackground(palette.surface)

          Section {
            ForEach(weight.entries.reversed(), id: \.day) { entry in
              Button {
                correcting = Selection(entry: entry)
              } label: {
                HStack {
                  Text(LogPresentation.date(entry.day), format: .dateTime.day().month(.abbreviated).year())
                    .foregroundStyle(palette.ink)
                  Spacer()
                  Text("\(BodyweightLogInput.kilograms(entry.kg)) kg")
                    .monospacedDigit().foregroundStyle(palette.ink)
                  Image(systemName: "pencil").font(.footnote).foregroundStyle(palette.dim)
                }
              }
              .accessibilityLabel("\(BodyweightLogInput.kilograms(entry.kg)) kilograms, \(entry.day.text)")
              .accessibilityHint("Correct this weigh-in")
              .accessibilityIdentifier("gym-weigh-in-\(entry.day.text)")
              .swipeActions {
                Button("Delete", role: .destructive) { gym.logDeleteWeighIn(day: entry.day) }
              }
              .accessibilityAction(named: "Delete weigh-in") { gym.logDeleteWeighIn(day: entry.day) }
            }
          } header: {
            HStack { Text("Every weigh-in"); Spacer(); Text("\(weight.entries.count)") }
          } footer: {
            Text("Coach can read this. It can never write it.").foregroundStyle(palette.dim)
          }.listRowBackground(palette.surface)
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(palette.canvas)
    .foregroundStyle(palette.ink)
    .tint(palette.accent)
    .navigationTitle("Bodyweight")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .accessibilityIdentifier("gym-bodyweight")
    .safeAreaInset(edge: .bottom) { LogNoticeBand(gym: gym) }
    .sheet(item: $correcting) { WeighInSheet(gym: gym, entry: $0.entry) }
    .onChange(of: gym.account) { _, _ in correcting = nil }
    .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "bodyweight"]) }
  }
}

private struct BodyweightWindowPicker: UIViewRepresentable {
  @Binding var window: BodyweightScreen.Window
  func makeCoordinator() -> Coordinator { Coordinator(window: $window) }
  func makeUIView(context: Context) -> UISegmentedControl {
    let control = UISegmentedControl(items: ["90 days", "All"])
    control.accessibilityIdentifier = "gym-bodyweight-window"
    control.accessibilityLabel = "Window"
    control.addTarget(context.coordinator, action: #selector(Coordinator.changed), for: .valueChanged)
    return control
  }
  func updateUIView(_ control: UISegmentedControl, context: Context) {
    context.coordinator.window = $window
    control.selectedSegmentIndex = window == .all ? 1 : 0
  }
  final class Coordinator: NSObject {
    var window: Binding<BodyweightScreen.Window>
    init(window: Binding<BodyweightScreen.Window>) { self.window = window }
    @objc func changed(_ control: UISegmentedControl) {
      window.wrappedValue = control.selectedSegmentIndex == 1 ? .all : .recent
    }
  }
}

struct WeighInSheet: View {
  let gym: GymModel
  let entry: Bodyweight.Entry?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.colorScheme) private var scheme
  @FocusState private var weightFocused: Bool
  @State private var typed: String
  @State private var date: Date
  @State private var draft: Draft<WeighIn>?
  @State private var saving = false
  @State private var saved = false
  @State private var refusal: String?
  private var palette: LogPalette { LogPalette(dark: scheme == .dark) }
  private var today: LocalDay { gym.bodyweight?.today ?? LogPresentation.day(Date()) }

  init(gym: GymModel, entry: Bodyweight.Entry? = nil) {
    self.gym = gym; self.entry = entry
    _typed = State(initialValue: entry.map { BodyweightLogInput.kilograms($0.kg) } ?? "")
    _date = State(initialValue: LogPresentation.date(entry?.day ?? gym.bodyweight?.today ?? LogPresentation.day(Date())))
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          HStack {
            TextField("Weight", text: $typed)
              .keyboardType(.decimalPad)
              .focused($weightFocused)
              .accessibilityLabel("Weight in kilograms")
              .accessibilityIdentifier("gym-weigh-in-weight")
              .onSubmit { save() }
            Text("kg").foregroundStyle(palette.dim)
          }
          if let refusal {
            Text(refusal).font(.footnote).foregroundStyle(palette.alarm)
              .accessibilityIdentifier("gym-weigh-in-refusal")
          }
        } header: { Text("Weight") }
          .listRowBackground(palette.surface)
        Section {
          if let entry {
            LabeledContent("Date") {
              Text(LogPresentation.date(entry.day), format: .dateTime.day().month(.wide).year())
                .foregroundStyle(palette.ink)
            }.accessibilityIdentifier("gym-weigh-in-fixed-date")
          } else {
            DatePicker("Date", selection: $date, in: ...LogPresentation.date(today), displayedComponents: .date)
              .accessibilityIdentifier("gym-weigh-in-date")
          }
        }.listRowBackground(palette.surface)
        if let entry {
          Section {
            Button("Delete weigh-in", role: .destructive) {
              if gym.logDeleteWeighIn(day: entry.day) { dismiss() }
              else { refusal = gym.error ?? "That weigh-in could not be deleted. Try again." }
            }.foregroundStyle(palette.alarm).accessibilityIdentifier("gym-weigh-in-delete")
          }.listRowBackground(palette.surface)
        }
      }
      .disabled(saving)
      .scrollContentBackground(.hidden)
      .background(palette.canvas)
      .foregroundStyle(palette.ink)
      .navigationTitle("Weigh in")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(saving).accessibilityIdentifier("gym-weigh-in-cancel")
        }
      }
      .safeAreaInset(edge: .bottom) {
        Button { save() } label: {
          Text(saving ? "Saving…" : "Save weight").frame(maxWidth: .infinity).foregroundStyle(scheme == .dark ? .black : .white)
        }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .disabled(saving)
          .accessibilityIdentifier("gym-weigh-in-save")
          .padding().background(palette.canvas)
      }
      .interactiveDismissDisabled(saving)
      .sensoryFeedback(.success, trigger: saved)
      .onChange(of: typed) { _, _ in refusal = nil }
      .onChange(of: refusal) { _, refusal in
        if let refusal { UIAccessibility.post(notification: .announcement, argument: refusal) }
      }
      .onChange(of: date) { _, _ in refusal = nil; draft = nil }
      .onChange(of: gym.account) { _, _ in dismiss() }
      .onChange(of: gym.accountTransition) { _, changing in if changing { dismiss() } }
      .onAppear {
        weightFocused = true
        gym.telemetry.event("gym_screen_viewed", properties: ["screen": "weigh_in"])
      }
    }.tint(palette.accent)
  }

  private func save() {
    guard !saving else { return }
    let kg: Double
    switch BodyweightLogInput.parse(typed) {
    case .weight(let value): kg = value
    case .refused(let message): refusal = message; return
    }
    let day = entry?.day ?? LogPresentation.day(date)
    guard day <= today else { refusal = BodyweightLogInput.notAForecast; return }
    saving = true
    defer { saving = false }
    do {
      if draft == nil { draft = try gym.logWeighInDraft(day: day) }
      guard var edited = draft else { return }
      edited.current.kg = kg
      refusal = gym.logSaveWeighIn(&edited)
      draft = edited
      if refusal == nil { saved = true; dismiss() }
    } catch {
      gym.report("gym_read", error)
      refusal = "That weigh-in could not be read. Try again."
    }
  }
}
