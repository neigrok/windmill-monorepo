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

  // The sheet's checkmark waits for a weight it could save: not while nothing is typed, a refusal stands, or a weigh-in
  // reads as it was.
  static func canSave(_ typed: String, refusal: String?, entry: Bodyweight.Entry?) -> Bool {
    !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && refusal == nil
      && entry.map { parse(typed) == .weight($0.kg) } != true
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
  let gym: GymModel
  @State private var window = ChartWindow.recent
  @State private var correcting: Selection?

  var body: some View {
    let dates = gym.dates
    List {
      if !gym.readFailed && (gym.bodyweight == nil || gym.bodyweight?.stance == .unknown) {
        ProgressView().frame(maxWidth: .infinity).listRowBackground(GymPalette.canvas)
          .accessibilityIdentifier("gym-bodyweight-loading")
      }
      if let weight = gym.bodyweight {
        if weight.stance == .empty && !gym.readFailed {
          ContentUnavailableView("No weigh-ins yet", systemImage: "scalemass", description: Text("Weigh in from the log."))
            .listRowBackground(GymPalette.canvas).accessibilityIdentifier("gym-bodyweight-empty")
        } else if weight.stance == .holding {
          Section {
            ChartWindowPicker(recent: "90 days", identifier: "gym-bodyweight-window", window: $window)
            let chart = weight.chart(window == .recent ? .recent : .all)
            let caption = window.line(recent: "90 days", holding: GymCount.of(chart.dots.count, "weigh-in"))
            if !chart.dots.isEmpty {
              LogDatedChart(points: chart.dots.map { entry in
                LogPlotPoint(id: entry.day.text, date: LogPresentation.date(entry.day), value: entry.kg,
                             label: "\(BodyweightLogInput.kilograms(entry.kg)) kg · \(dates.day(entry.day))")
              }, from: LogPresentation.date(window == .recent ? weight.today.adding(days: -89) : chart.dots[0].day),
              through: LogPresentation.date(weight.today), series: .bodyweight, dates: dates, caption: caption, select: { id in
                guard let entry = weight.entries.first(where: { $0.day.text == id }) else { return }
                correcting = Selection(entry: entry)
              })
              .accessibilityIdentifier("gym-bodyweight-chart")
            } else {
              if window == .recent && !gym.readFailed && gym.personalCounts[WeighIn.type, default: 0] == weight.entries.count {
                Text("no weigh-in in the last 90 days")
                  .foregroundStyle(GymPalette.inkDim)
                  .accessibilityIdentifier("gym-bodyweight-window-empty")
              }
              Text(caption).font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim)
            }
          } footer: {
            Text("Every point is a number you typed. Nothing here is estimated.")
              .foregroundStyle(GymPalette.inkDim)
          }.listRowBackground(GymPalette.card)

          Section {
            ForEach(weight.entries.reversed(), id: \.day) { entry in
              Button {
                correcting = Selection(entry: entry)
              } label: {
                GymRow(title: "\(BodyweightLogInput.kilograms(entry.kg)) kg", trailing: .fact(dates.day(entry.day), door: true))
              }
              .accessibilityLabel("\(BodyweightLogInput.kilograms(entry.kg)) kilograms, \(dates.day(entry.day))")
              .accessibilityHint("Correct this weigh-in")
              .accessibilityIdentifier("gym-weigh-in-\(entry.day.text)")
              .swipeActions(allowsFullSwipe: false) {
                Button("Delete", role: .destructive) { gym.logDeleteWeighIn(day: entry.day) }
              }
              .accessibilityAction(named: "Delete weigh-in") { gym.logDeleteWeighIn(day: entry.day) }
            }
          } header: {
            Text("Every weigh-in")
          } footer: {
            Text("Coach can read this. It can never write it.").foregroundStyle(GymPalette.inkDim)
          }.listRowBackground(GymPalette.card)
        }
      }
    }
    .listStyle(.insetGrouped)
    .modifier(GymPage())
    .navigationTitle("Bodyweight")
    .navigationBarTitleDisplayMode(.inline)
    .gymTabBar()
    .accessibilityIdentifier("gym-bodyweight")
    .reachBand { GymTransient(gym: gym, errorIdentifier: "gym-log-error") }
    .sheet(item: $correcting) { WeighInSheet(gym: gym, entry: $0.entry) }
    .onChange(of: gym.account) { _, _ in correcting = nil }
    .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "bodyweight"]) }
  }
}

struct WeighInSheet: View {
  let gym: GymModel
  let entry: Bodyweight.Entry?
  @Environment(\.dismiss) private var dismiss
  @FocusState private var weightFocused: Bool
  @State private var typed: String
  @State private var date: Date
  @State private var draft: Draft<WeighIn>?
  @State private var saving = false
  @State private var saved = false
  @State private var refusal: String?
  private var today: LocalDay { gym.bodyweight?.today ?? LogPresentation.day(Date()) }
  private var cannotSave: Bool { !BodyweightLogInput.canSave(typed, refusal: refusal, entry: entry) }

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
            Text("kg").foregroundStyle(GymPalette.inkDim)
          }
          if let refusal {
            Text(refusal).font(.footnote).foregroundStyle(GymPalette.alarm)
              .accessibilityIdentifier("gym-weigh-in-refusal")
          }
        }.listRowBackground(GymPalette.card)
        Section {
          if let entry {
            LabeledContent("Date", value: gym.dates.subtitle(entry.day)).accessibilityIdentifier("gym-weigh-in-fixed-date")
          } else {
            DatePicker("Date", selection: $date, in: ...LogPresentation.date(today), displayedComponents: .date)
              .accessibilityIdentifier("gym-weigh-in-date")
          }
        }.listRowBackground(GymPalette.card)
        if let entry {
          Section {
            Button("Delete weigh-in", role: .destructive) {
              if gym.logDeleteWeighIn(day: entry.day) { dismiss() }
              else { refusal = gym.error ?? "That weigh-in could not be deleted. Try again." }
            }.accessibilityIdentifier("gym-weigh-in-delete")
          }.listRowBackground(GymPalette.card)
        }
      }
      .disabled(saving)
      .modifier(GymPage())
      .navigationTitle("Weigh in")
      .navigationBarTitleDisplayMode(.inline)
      .sheetCommit("Save", identifier: "gym-weigh-in-save", dismissalIdentifier: "gym-weigh-in-cancel", disabled: cannotSave, busy: saving,
                   dismiss: { dismiss() }, commit: save)
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
    }.modifier(GymPage()).presentationDetents([.medium])
  }

  private func save() {
    guard !saving, !cannotSave else { return }
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
