import SwiftUI
import UIKit
import Foundation
import DomainKit
import GymDomain
import SyncCore

enum BodyweightLogInput {
  static let notANumber = "That is not a number yet."
  static let onePoint = "One decimal point only."
  static let outOfRange = "Between 20 and 400 kg"
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
    guard refusal == nil, case .weight(let kg) = parse(typed) else { return false }
    return entry?.kg != kg
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
    let action = draft.isNew ? "create" : "update"
    switch save(&draft) {
    case .saved:
      telemetry.event("gym_action", properties: ["screen": "weigh_in", "action": action, "outcome": "saved"])
      return nil
    case .refused(let refusal):
      telemetry.event("gym_action", properties: ["screen": "weigh_in", "action": action, "outcome": "refused"])
      if case .future = refusal { return BodyweightLogInput.notAForecast }
      if case .invalid(let violation) = refusal {
        if violation.rule == WeighInRules.dayRule { return BodyweightLogInput.notAForecast }
        if violation.rule == WeighInRules.kg.path {
          return violation.reason == .notANumber ? BodyweightLogInput.notANumber : BodyweightLogInput.outOfRange
        }
      }
      return error ?? "That weigh-in could not be saved."
    case .failed:
      telemetry.event("gym_action", properties: ["screen": "weigh_in", "action": action, "outcome": "failed"])
      return accountTransition ? "Wait for the account change to finish." : "That weigh-in could not be saved. Try again."
    }
  }

  @discardableResult
  func logDeleteWeighIn(day: LocalDay) -> Bool {
    guard let outcome = run(DeleteWeighIn(ID(day))) else {
      telemetry.event("gym_action", properties: ["screen": "weigh_in", "action": "discard", "outcome": "failed"])
      return false
    }
    let accepted = outcome.refusal == nil
    telemetry.event("gym_action", properties: ["screen": "weigh_in", "action": "discard", "outcome": accepted ? "saved" : "refused"])
    return accepted
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
  // A weigh-in row reads its weight first, then its day: *82.5 kilograms, Sep 23*.
  static func spoken(_ entry: Bodyweight.Entry, dates: GymDate) -> String {
    "\(BodyweightLogInput.kilograms(entry.kg)) kilograms, \(dates.day(entry.day))"
  }

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
            VStack(alignment: .leading, spacing: 12) {
              ChartWindowPicker(recent: "90 days", identifier: "gym-bodyweight-window", window: $window)
              let chart = weight.chart(window == .recent ? .recent : .all)
              let caption = window.line(recent: "90 days", holding: GymCount.of(chart.dots.count, "weigh-in"))
              if !chart.dots.isEmpty {
                LogDatedChart(points: chart.dots.map { entry in
                  LogPlotPoint(id: entry.day.text, date: LogPresentation.date(entry.day), value: entry.kg,
                               label: "\(BodyweightLogInput.kilograms(entry.kg)) kg · \(dates.day(entry.day))")
                }, from: LogPresentation.date(window == .recent ? weight.today.adding(days: -89) : chart.dots[0].day),
                through: LogPresentation.date(weight.today), series: .bodyweight, dates: dates, caption: caption)
                .accessibilityIdentifier("gym-bodyweight-chart")
              } else {
                if window == .recent && !gym.readFailed && gym.personalCounts[WeighIn.type, default: 0] == weight.entries.count {
                  Text("no weigh-in in the last 90 days")
                    .foregroundStyle(GymPalette.inkDim)
                    .accessibilityIdentifier("gym-bodyweight-window-empty")
                }
                Text(caption).font(.footnote.monospaced()).foregroundStyle(GymPalette.inkDim)
              }
            }
          }.listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 14, trailing: 0))

          Section {
            ForEach(weight.entries.reversed(), id: \.day) { entry in
              Button {
                correcting = Selection(entry: entry)
              } label: {
                GymRow(title: "\(BodyweightLogInput.kilograms(entry.kg)) kg", trailing: .fact(dates.day(entry.day), door: true))
              }
              .accessibilityLabel(Self.spoken(entry, dates: dates))
              .accessibilityHint("Correct this weigh-in")
              .accessibilityIdentifier("gym-weigh-in-\(entry.day.text)")
              .trashSwipe("Delete weigh-in") { gym.logDeleteWeighIn(day: entry.day) }
              .accessibilityAction(named: "Delete weigh-in") { gym.logDeleteWeighIn(day: entry.day) }
            }
          } footer: {
            Text("Coach can read your weigh-ins but cannot change them.").foregroundStyle(GymPalette.inkDim)
          }.listRowBackground(GymPalette.card)
        }
      }
    }
    .listStyle(.insetGrouped)
    .contentMargins(.top, RoomSpace.small, for: .scrollContent)
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
  @State private var proposedDate: Date?
  @State private var contentHeight: CGFloat = 0
  @State private var navigationHeight: CGFloat = RoomSpace.minimumTarget + RoomSpace.inset
  private var today: LocalDay { gym.bodyweight?.today ?? LogPresentation.day(Date()) }
  private var choosingDate: Bool { proposedDate != nil }
  private var cannotSave: Bool { !BodyweightLogInput.canSave(typed, refusal: refusal, entry: entry) }

  init(gym: GymModel, entry: Bodyweight.Entry? = nil) {
    self.gym = gym; self.entry = entry
    _typed = State(initialValue: entry.map { BodyweightLogInput.kilograms($0.kg) } ?? "")
    _date = State(initialValue: LogPresentation.date(entry?.day ?? gym.bodyweight?.today ?? LogPresentation.day(Date())))
  }

  var body: some View {
    NavigationStack { form }
      .tint(GymPalette.accent)
      .presentationBackground(GymPalette.canvas)
      .presentationDragIndicator(.visible)
      .presentationDetents([.height(max(RoomSpace.minimumTarget, contentHeight) + navigationHeight)])
      .interactiveDismissDisabled(saving)
      .sensoryFeedback(.success, trigger: saved)
      .onChange(of: typed) { (_: String, _: String) in refusal = nil }
      .onChange(of: weightFocused) { (_: Bool, focused: Bool) in
        if !focused { validateWeight() }
      }
      .onChange(of: refusal) { (_: String?, refusal: String?) in
        if let refusal { UIAccessibility.post(notification: .announcement, argument: refusal) }
      }
      .onChange(of: gym.account) { (_: String?, _: String?) in dismiss() }
      .onChange(of: gym.accountTransition) { (_: Bool, changing: Bool) in if changing { dismiss() } }
      .onAppear {
        weightFocused = true
        gym.telemetry.event("gym_screen_viewed", properties: ["screen": "weigh_in"])
      }
  }

  private var form: some View {
    ScrollView {
      VStack(spacing: RoomSpace.related + RoomSpace.small) {
        if choosingDate { calendar } else { fields }
      }.padding(RoomSpace.inset)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { (height: CGFloat) in contentHeight = height }
    }
    .scrollBounceBehavior(.basedOnSize)
    .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.top } action: { (height: CGFloat) in
      if height > 0 { navigationHeight = height }
    }
    .disabled(saving)
    .background(GymPalette.canvas)
    .navigationTitle(choosingDate ? "Date" : "Weigh in")
    .navigationBarTitleDisplayMode(.inline)
    .modifier(SheetCommit(title: choosingDate ? "Use date" : "Save",
                          identifier: choosingDate ? "gym-weigh-in-date-accept" : "gym-weigh-in-save",
                          dismissal: choosingDate ? "Back" : "Cancel",
                          dismissalIdentifier: choosingDate ? "gym-weigh-in-date-back" : "gym-weigh-in-cancel",
                          disabled: !choosingDate && cannotSave, busy: saving,
                          dismiss: cancel, commit: {
                            if choosingDate { acceptDate() } else { save() }
                          }))
  }

  @ViewBuilder var fields: some View {
    VStack(alignment: .leading, spacing: RoomSpace.related) {
      HStack(spacing: RoomSpace.related) {
        TextField("Weight", text: $typed)
          .font(.title2.weight(.medium)).monospacedDigit()
          .keyboardType(.decimalPad).focused($weightFocused)
          .accessibilityLabel("Weight in kilograms").accessibilityIdentifier("gym-weigh-in-weight")
          .onSubmit { save() }
        Text("kg").foregroundStyle(GymPalette.inkDim)
      }.padding(.horizontal, RoomSpace.inset).frame(minHeight: 52)
        .background(GymPalette.card, in: RoundedRectangle(cornerRadius: 24))
        .overlay { RoundedRectangle(cornerRadius: 24).strokeBorder(weightFocused ? GymPalette.accent : .clear, lineWidth: 1.5) }
      if let refusal {
        Text(refusal).font(.footnote).foregroundStyle(GymPalette.alarm)
          .padding(.horizontal, RoomSpace.inset).fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("gym-weigh-in-refusal")
      }
    }
    Group {
      if let entry {
        LabeledContent("Date", value: gym.dates.subtitle(entry.day))
          .padding(.horizontal, RoomSpace.inset).frame(minHeight: 52)
          .accessibilityIdentifier("gym-weigh-in-fixed-date")
      } else {
        Button {
          weightFocused = false
          proposedDate = date
          gym.telemetry.event("gym_action", properties: ["screen": "weigh_in", "action": "open", "item": "date"])
        } label: {
          LabeledContent("Date") {
            Text(gym.dates.day(LogPresentation.day(date)))
              .font(.subheadline).padding(.horizontal, 12).padding(.vertical, 6)
              .background(GymPalette.control, in: RoundedRectangle(cornerRadius: 8))
          }.padding(.horizontal, RoomSpace.inset).frame(minHeight: 52).contentShape(Rectangle())
        }.buttonStyle(.plain).foregroundStyle(GymPalette.ink)
          .accessibilityLabel("Date").accessibilityValue(gym.dates.day(LogPresentation.day(date)))
          .accessibilityIdentifier("gym-weigh-in-date")
      }
    }.background(GymPalette.card, in: RoundedRectangle(cornerRadius: 24))
    if let entry {
      Button("Delete weigh-in", role: .destructive) {
        if gym.logDeleteWeighIn(day: entry.day) { dismiss() }
        else { refusal = gym.error ?? "That weigh-in could not be deleted. Try again." }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, RoomSpace.inset).frame(minHeight: 52)
        .background(GymPalette.card, in: RoundedRectangle(cornerRadius: 24))
        .accessibilityIdentifier("gym-weigh-in-delete")
    }
  }

  var calendar: some View {
    DatePicker("Date", selection: Binding(get: { proposedDate ?? date }, set: { proposedDate = $0 }),
               in: ...LogPresentation.date(today), displayedComponents: .date)
      .datePickerStyle(.graphical).labelsHidden().fixedSize(horizontal: false, vertical: true)
      .tint(GymPalette.accent)
      .accessibilityIdentifier("gym-weigh-in-calendar")
  }

  func cancel() {
    if choosingDate {
      proposedDate = nil
      weightFocused = true
      gym.telemetry.event("gym_action", properties: ["screen": "weigh_in", "action": "cancel", "item": "date"])
      return
    }
    gym.telemetry.event("gym_action", properties: ["screen": "weigh_in", "action": "cancel", "outcome": "cancelled"])
    dismiss()
  }

  func acceptDate() {
    guard let proposedDate else { return }
    date = proposedDate
    self.proposedDate = nil
    draft = nil
    weightFocused = true
    gym.telemetry.event("gym_action", properties: ["screen": "weigh_in", "action": "apply", "item": "date"])
  }

  func validateWeight() {
    guard !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          case .refused(let message) = BodyweightLogInput.parse(typed) else { return }
    if refusal != message {
      gym.telemetry.event("gym_action", properties: ["screen": "weigh_in", "action": "fix", "outcome": "refused"])
    }
    refusal = message
  }

  private func save() {
    guard !saving else { return }
    validateWeight()
    guard !cannotSave else { return }
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
