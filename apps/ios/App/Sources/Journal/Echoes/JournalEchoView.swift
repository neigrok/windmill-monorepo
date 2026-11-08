import SwiftUI
import UIKit
import DomainKit

// Echo presentation stays here so the room's skin can change without changing its evidence.

// A day's count in its date row (Journal · iOS 02.3P): a lamp capsule in a 44 pt target, kindled for a moment when a passage arrives.
struct JournalEchoTab: View {
  let echoes: JournalEchoes
  let day: String
  let writing: Bool
  let toggle: () -> Void
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @ScaledMetric(relativeTo: .caption) var capsule = 22.0
  @State private var visible = false
  var page: JournalEchoPage? { echoes.pages[day] }

  var body: some View {
    if let page {
      let kindled = echoes.arrivalDay == day
      Button(action: toggle) {
        Text(page.matches.count.formatted()).font(JournalType.date).monospacedDigit().foregroundStyle(JournalPalette.lamp)
          .padding(.horizontal, 7).frame(minWidth: capsule, minHeight: capsule)
          .background(kindled ? JournalPalette.kindled : JournalPalette.lampSoft, in: Capsule())
          .animation(.easeOut(duration: reduceMotion ? 0.2 : 1.2), value: kindled)
          .frame(minWidth: RoomSpace.minimumTarget, minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
      }.buttonStyle(.plain)
        .accessibilityLabel(Self.label(page.matches.count))
        .accessibilityValue(echoes.sheetDay == day ? "Open" : "Closed")
        .accessibilityIdentifier("journal-echo-\(day)")
        .onScrollVisibilityChange { visible = $0 }
        .task(id: visible && !writing && kindled) {
          guard visible, !writing, kindled else { return }
          if UIAccessibility.isVoiceOverRunning, echoes.claimArrivalAnnouncement(day) {
            let message = NSAttributedString(string: Self.label(page.matches.count), attributes: [.accessibilitySpeechQueueAnnouncement: true])
            UIAccessibility.post(notification: .announcement, argument: message)
          }
          do { try await Task.sleep(for: .seconds(3)) } catch { return }
          echoes.settleArrival(day)
        }
    }
  }

  static func label(_ count: Int) -> String { String(localized: "\(count) passages you wrote before", locale: .copy, comment: "A day's echo count, spoken") }
}

// One day's echoes in one stock sheet (Journal · iOS 02.3P–02.6P): passages at .medium, by year at .large, the way back lowered.
struct JournalEchoSheet: View {
  static let lowered = PresentationDetent.height(140)
  @Bindable var echoes: JournalEchoes
  let day: String
  @Binding var detent: PresentationDetent

  var standing: Bool { detent == Self.lowered && !echoes.hops.isEmpty }

  var body: some View {
    NavigationStack {
      Group {
        if standing { whereYouStand } else { passages }
      }.background(JournalPalette.card)
        .navigationTitle("From your journal").navigationBarTitleDisplayMode(.inline)
        .toolbar(standing ? .hidden : .visible, for: .navigationBar)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { close } }
        .roomBar(.journal)
    }.tint(JournalPalette.lamp)
      .presentationDetents([Self.lowered, .medium, .large], selection: $detent)
      .presentationDragIndicator(.visible)
      .presentationBackgroundInteraction(.enabled(upThrough: .medium))
      .presentationContentInteraction(.scrolls)
      .presentationBackground(JournalPalette.card)
      .onChange(of: detent) { _, now in if now == .large { echoes.expand() } }
  }

  @ViewBuilder var close: some View {
    if #available(iOS 26.0, *) { Button(role: .close) { echoes.close() }.accessibilityIdentifier("echo-close") }
    else { Button("Close") { echoes.close() }.accessibilityIdentifier("echo-close") }
  }

  var passages: some View {
    let matches = echoes.pages[day]?.matches ?? []
    return List {
      if echoes.introducing == day { introduction }
      if detent == .large {
        ForEach(Array(Set(matches.map { String($0.day.prefix(4)) })).sorted(by: >), id: \.self) { year in
          Section {
            ForEach(matches.filter { $0.day.hasPrefix(year) }, id: \.day) { row($0, namedYear: Int(year)) }
          } header: {
            Text(year).font(.subheadline.weight(.semibold)).foregroundStyle(JournalPalette.inkDim).accessibilityAddTraits(.isHeader)
          }
        }
      } else {
        ForEach(matches, id: \.day) { row($0, namedYear: LocalDay(echoes.access.today)?.year) }
      }
    }.listStyle(.plain).scrollContentBackground(.hidden).accessibilityIdentifier("echo-sheet")
      .reachBand(onSurface: true) { verdicts(matches) }
  }

  func row(_ match: JournalEchoMatch, namedYear: Int?) -> some View {
    Button { if echoes.walk(from: day, to: match) { detent = Self.lowered } } label: {
      JournalEchoRow(echoes: echoes, match: match, trigger: day, namedYear: namedYear)
    }.buttonStyle(.plain).listRowBackground(Color.clear).listSectionSeparator(.hidden)
      .listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 10, trailing: 20))
      .accessibilityHint("Opens this page in the canvas")
      .accessibilityIdentifier("echo-open-\(match.day)")
  }

  // The first echo ever says once what echoes are, above its passages.
  var introduction: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Older lines that echo what you wrote today. Only you see them; they cost nothing.")
        .font(.footnote).foregroundStyle(JournalPalette.inkDim).fixedSize(horizontal: false, vertical: true)
      Button("Got it") { echoes.dismissIntroduction() }.buttonStyle(.borderless).font(.subheadline.weight(.semibold))
        .frame(minHeight: RoomSpace.minimumTarget).accessibilityIdentifier("echo-introduction-done")
    }.listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 0, trailing: 20))
  }

  // Quiet verdicts in thumb reach, side by side or stacked when the type will not fit; a chosen Useful fills its hand.
  func verdicts(_ matches: [JournalEchoMatch]) -> some View {
    let useful = !matches.isEmpty && matches.allSatisfy { $0.useful == true }
    let pending = echoes.pendingDays.contains(day)
    let buttons = Group {
      Button { Task { await echoes.answer(.useful, day: day) } } label: {
        Label("Useful", systemImage: "hand.thumbsup").symbolVariant(useful ? .fill : .none).frame(minHeight: RoomSpace.minimumTarget)
      }.tint(useful ? JournalPalette.lamp : JournalPalette.inkDim).disabled(pending)
        .accessibilityValue(useful ? "Selected" : "Not selected").accessibilityIdentifier("echo-useful-page")
      Button { Task { await echoes.answer(.dismiss, day: day) } } label: {
        Label("Not useful", systemImage: "hand.thumbsdown").frame(minHeight: RoomSpace.minimumTarget)
      }
        .tint(JournalPalette.inkDim).disabled(pending).accessibilityIdentifier("echo-dismiss-page")
    }.buttonStyle(.borderless).controlSize(.large).font(.subheadline)
    return ViewThatFits(in: .horizontal) {
      HStack(spacing: 24) { buttons }
      VStack(spacing: 0) { buttons }
    }.frame(maxWidth: .infinity).padding(.top, RoomSpace.related)
  }

  // Lowered while the canvas stands on a page: its stamp, and Back to tonight with the trail's days in its menu.
  var whereYouStand: some View {
    let here = echoes.hops.last ?? day
    let stamp = JournalEchoStamp.date(here, namedYear: nil)
    let back = Menu {
      ForEach(echoes.hops, id: \.self) { hop in
        Button(hop == echoes.access.today ? String(localized: "Tonight") : JournalEchoStamp.long(hop)) { echoes.stand(on: hop) }
      }
    } label: {
      Text("Back to tonight").fontWeight(.semibold).frame(maxWidth: .infinity)
    } primaryAction: { echoes.stand(on: echoes.access.today) }
    return VStack(spacing: 10) {
      Text(here == day ? stamp : String(localized: "\(stamp) · \(JournalEchoStamp.distance(from: here, to: day))", comment: "Where the canvas stands: 29 MAY 2025 · 4 MO"))
        .font(JournalType.date).tracking(JournalType.dateTracking)
        .foregroundStyle(JournalPalette.inkDim).accessibilityLabel(JournalEchoStamp.long(here)).accessibilityIdentifier("echo-where")
      Group {
        if #available(iOS 26.0, *) { back.buttonStyle(.glass) } else { back.buttonStyle(.bordered) }
      }.menuStyle(.button).controlSize(.large).tint(JournalPalette.ink).accessibilityIdentifier("echo-back-to-tonight")
    }.padding(.horizontal, RoomSpace.inset).padding(.top, RoomSpace.panel)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }
}

// One passage as the sheet draws it; drawn, it counts as shown.
struct JournalEchoRow: View {
  let echoes: JournalEchoes
  let match: JournalEchoMatch
  let trigger: String
  // The year the row's surroundings already name, left out of its stamp: this year at .medium, its header's at .large.
  let namedYear: Int?
  @Environment(\.dynamicTypeSize) var typeSize
  @ScaledMetric(relativeTo: .body) var stampColumn = 48.0

  var body: some View {
    let stacked = typeSize.isAccessibilitySize
    let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
    layout {
      VStack(alignment: .leading, spacing: 1) {
        Text(JournalEchoStamp.date(match.day, namedYear: namedYear))
        Text(JournalEchoStamp.distance(from: match.day, to: trigger))
      }.font(JournalType.date).foregroundStyle(JournalPalette.inkFaint).frame(width: stacked ? nil : stampColumn, alignment: .leading)
        .padding(.top, 3).accessibilityElement(children: .ignore).accessibilityLabel(JournalEchoStamp.long(match.day))
      VStack(alignment: .leading, spacing: 6) {
        Text(match.text).font(JournalType.body).lineSpacing(5).foregroundStyle(JournalPalette.lamp)
          .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        if let provenance = match.provenance { Text(provenance).font(.footnote).foregroundStyle(JournalPalette.inkDim) }
      }.alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
    }.frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget, alignment: .topLeading).contentShape(Rectangle())
      .accessibilityElement(children: .combine)
      .onAppear { echoes.shown(match, on: trigger) }
  }
}

// The echo stamp (Figma Journal · iOS 2c): 29 MAY over 4 MO, naming the year only when nothing around it does; months as `echoDates.js` counts.
enum JournalEchoStamp {
  static let months = [
    String(localized: "JAN", comment: "January in an echo's date stamp"), String(localized: "FEB", comment: "February in an echo's date stamp"),
    String(localized: "MAR", comment: "March in an echo's date stamp"), String(localized: "APR", comment: "April in an echo's date stamp"),
    String(localized: "MAY", comment: "May in an echo's date stamp"), String(localized: "JUN", comment: "June in an echo's date stamp"),
    String(localized: "JUL", comment: "July in an echo's date stamp"), String(localized: "AUG", comment: "August in an echo's date stamp"),
    String(localized: "SEP", comment: "September in an echo's date stamp"), String(localized: "OCT", comment: "October in an echo's date stamp"),
    String(localized: "NOV", comment: "November in an echo's date stamp"), String(localized: "DEC", comment: "December in an echo's date stamp"),
  ]

  static func date(_ iso: String, namedYear: Int?) -> String {
    guard let day = LocalDay(iso) else { return "" }
    let head = String(format: "%02d %@", day.day, months[day.month - 1])
    return day.year == namedYear ? head : "\(head) \(day.year)"
  }

  static func distance(from source: String, to trigger: String) -> String {
    guard let older = LocalDay(source), let newer = LocalDay(trigger) else { return "" }
    let months = monthsApart(older, newer)
    if months == 0 {
      let weeks = max(1, Int((Double(older.days(until: newer)) / 7).rounded()))
      return String(localized: "\(weeks) WK", locale: .copy, comment: "How long before a passage was written, in weeks: 2 WK")
    }
    return months < 12 ? String(localized: "\(months) MO", locale: .copy, comment: "How long before a passage was written, in months: 4 MO")
      : String(localized: "\(months / 12) YR", locale: .copy, comment: "How long before a passage was written, in years: 2 YR")
  }

  // Months between two days to the nearest month, rounded on the calendar and from zero, so 30 days is one month.
  static func monthsApart(_ older: LocalDay, _ newer: LocalDay) -> Int {
    let whole = (newer.year - older.year) * 12 + (newer.month - older.month) - (newer.day < older.day ? 1 : 0)
    guard whole >= 0 else { return 0 }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    func date(months: Int) -> Date { calendar.date(from: DateComponents(year: older.year, month: older.month + months, day: older.day))! }
    let target = calendar.date(from: DateComponents(year: newer.year, month: newer.month, day: newer.day))!
    let anchor = date(months: whole), next = date(months: whole + 1)
    return whole + (target.timeIntervalSince(anchor) * 2 >= next.timeIntervalSince(anchor) ? 1 : 0)
  }

  static func long(_ iso: String) -> String {
    guard let day = LocalDay(iso) else { return "" }
    let calendar = Calendar(identifier: .gregorian)
    guard let date = calendar.date(from: DateComponents(timeZone: TimeZone(secondsFromGMT: 0), year: day.year, month: day.month, day: day.day)) else { return "" }
    let formatter = DateFormatter()
    formatter.calendar = calendar; formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateStyle = .long
    return formatter.string(from: date)
  }
}
