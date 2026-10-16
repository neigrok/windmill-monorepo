import SwiftUI
import UIKit
import DomainKit

// Echo presentation stays here so the room's skin can change without changing its evidence.
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
    Group {
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
          .accessibilityValue(echoes.inkDay == day ? "Open" : "Closed")
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
  }

  static func label(_ count: Int) -> String { "\(count) \(count == 1 ? "passage" : "passages") you wrote before" }
}

struct JournalEchoInk: View {
  let echoes: JournalEchoes
  let day: String
  let read: (JournalEchoMatch) -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  @ScaledMetric(relativeTo: .body) var stampColumn = 48.0
  var indent: CGFloat { typeSize.isAccessibilitySize ? 0 : stampColumn + 12 }

  var body: some View {
    let shown = echoes.inkMatches(day)
    let remaining = (echoes.pages[day]?.matches.count ?? 0) - shown.count
    let useful = !shown.isEmpty && shown.allSatisfy { $0.useful == true }
    let pending = echoes.pendingDays.contains(day)
    VStack(alignment: .leading, spacing: 18) {
      if echoes.introducing == day { introduction }
      ForEach(shown, id: \.day) { match in
        Button { read(match) } label: { JournalEchoRow(echoes: echoes, match: match, trigger: day) }.buttonStyle(.plain)
          .accessibilityHint("Opens this page in the canvas")
          .accessibilityIdentifier("echo-open-\(match.day)")
      }
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 6) { verdict(useful: useful, pending: pending, inline: true) }
        VStack(alignment: .leading, spacing: 0) { verdict(useful: useful, pending: pending, inline: false) }
      }.font(.footnote).buttonStyle(.plain).padding(.leading, indent).padding(.vertical, -12)
      if remaining > 0 {
        Button { echoes.openReader(day) } label: {
          HStack(spacing: 4) { Text("\(remaining) more"); DoorChevron(room: .journal) }
            .foregroundStyle(JournalPalette.lamp).frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
        }.buttonStyle(.plain).padding(.leading, indent).accessibilityIdentifier("echo-more")
      }
    }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .contain).accessibilityIdentifier("echo-ink-\(day)")
  }

  // Side by side the two verdicts keep their dot at every text size; stacked, they need none.
  @ViewBuilder func verdict(useful: Bool, pending: Bool, inline: Bool) -> some View {
    Button { Task { await echoes.answer(.useful, day: day) } } label: {
      Text("Useful").foregroundStyle(useful ? JournalPalette.lamp : JournalPalette.inkDim)
        .frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
    }.disabled(useful || pending)
      .accessibilityValue(useful ? "Selected" : "Not selected").accessibilityIdentifier("echo-useful-page")
    if inline { Text("·").foregroundStyle(JournalPalette.inkFaint).accessibilityHidden(true) }
    Button { Task { await echoes.answer(.dismiss, day: day) } } label: {
      Text("Not useful").foregroundStyle(JournalPalette.inkDim).frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
    }.disabled(pending).accessibilityIdentifier("echo-dismiss-page")
  }

  var introduction: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label { Text("From your journal").font(.subheadline.weight(.semibold)).foregroundStyle(JournalPalette.ink) } icon: {
        Image(systemName: "quote.opening").foregroundStyle(JournalPalette.lamp)
      }
      Text("Older lines that echo what you wrote today. Only you see them; they cost nothing.")
        .font(.footnote).foregroundStyle(JournalPalette.inkDim).fixedSize(horizontal: false, vertical: true)
      Button { echoes.dismissIntroduction() } label: {
        Text("Got it").font(.subheadline.weight(.semibold)).foregroundStyle(JournalPalette.lamp)
          .frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
      }.buttonStyle(.plain).accessibilityIdentifier("echo-introduction-done")
    }.padding(.horizontal, RoomSpace.inset).padding(.top, RoomSpace.inset - 4)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(JournalPalette.card, in: RoundedRectangle(cornerRadius: RoomSpace.cardRadius))
  }
}

// One passage as the ink and the reader draw it; on screen, it counts as shown.
struct JournalEchoRow: View {
  let echoes: JournalEchoes
  let match: JournalEchoMatch
  let trigger: String
  @Environment(\.dynamicTypeSize) var typeSize
  @ScaledMetric(relativeTo: .body) var stampColumn = 48.0

  var body: some View {
    let stacked = typeSize.isAccessibilitySize
    let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
    layout {
      VStack(alignment: .leading, spacing: 1) {
        Text(JournalEchoStamp.date(match.day, today: echoes.access.today))
        Text(JournalEchoStamp.distance(from: match.day, to: trigger))
      }.font(JournalType.date).foregroundStyle(JournalPalette.inkFaint).frame(width: stacked ? nil : stampColumn, alignment: .leading)
        .padding(.top, 3).accessibilityElement(children: .ignore).accessibilityLabel(JournalEchoStamp.long(match.day))
      VStack(alignment: .leading, spacing: 6) {
        Text(match.text).font(JournalType.body).lineSpacing(5).foregroundStyle(JournalPalette.lamp)
          .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        if let provenance = match.provenance { Text(provenance).font(.footnote).foregroundStyle(JournalPalette.inkDim) }
      }
    }.frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget, alignment: .topLeading).contentShape(Rectangle())
      .accessibilityElement(children: .combine)
      .onScrollVisibilityChange { visible in if visible { echoes.shown(match, on: trigger) } }
  }
}

struct JournalEchoReader: View {
  @Bindable var echoes: JournalEchoes
  let day: String
  let read: (JournalEchoDestination) -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.dismiss) var dismiss

  var body: some View {
    let matches = echoes.pages[day]?.matches ?? []
    let years = Array(Set(matches.map { String($0.day.prefix(4)) })).sorted(by: >)
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 22) {
          ForEach(years, id: \.self) { year in
            Text(year).font(JournalType.date).tracking(JournalType.dateTracking).foregroundStyle(JournalPalette.inkFaint)
              .accessibilityAddTraits(.isHeader)
            ForEach(matches.filter { $0.day.hasPrefix(year) }, id: \.day) { match in
              Button {
                let previous = echoes.destination
                echoes.walk(from: day, to: match)
                if let destination = echoes.destination, destination != previous { read(destination) }
              } label: { JournalEchoRow(echoes: echoes, match: match, trigger: day) }.buttonStyle(.plain)
                .accessibilityHint("Opens this page in the canvas")
                .accessibilityIdentifier("echo-read-\(match.day)")
            }
          }
        }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
      }.accessibilityIdentifier("echo-sheet")
        .background(JournalPalette.canvas).navigationTitle("From your journal").navigationBarTitleDisplayMode(.inline)
        .tint(JournalPalette.lamp)
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Close") { echoes.readerDay = nil; dismiss() }.accessibilityIdentifier("echo-close")
          }
        }.roomBar(.journal)
        .toolbarBackground(JournalPalette.canvas, for: .navigationBar).toolbarBackground(.visible, for: .navigationBar)
    }.presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.medium, .large])
      .presentationDragIndicator(.visible)
      .presentationBackground(JournalPalette.canvas)
  }
}

struct JournalEchoTrail: View {
  let echoes: JournalEchoes
  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 16) { controls }
      VStack(alignment: .leading, spacing: 0) { controls }
    }.font(.subheadline).foregroundStyle(JournalPalette.lamp)
      .padding(.horizontal, 24).accessibilityElement(children: .contain).accessibilityIdentifier("echo-trail")
  }
  @ViewBuilder var controls: some View {
    Menu {
      ForEach(echoes.hops, id: \.self) { day in
        Button(day == echoes.access.today ? "Tonight" : JournalEchoStamp.long(day)) { echoes.stand(on: day) }
      }
    } label: { Label("How you got here", systemImage: "point.topleft.down.to.point.bottomright.curvepath").frame(minHeight: 44).contentShape(Rectangle()) }
    Button { echoes.stand(on: echoes.access.today) } label: {
      Text("Back to tonight").frame(minHeight: 44).contentShape(Rectangle())
    }.accessibilityIdentifier("echo-back-to-tonight")
  }
}

// The ink's stamp (ios-redesign §8): 29 MAY over 4 MO this year, 22 AUG 2025 over 1 YR before; months as `echoDates.js` counts.
enum JournalEchoStamp {
  static let months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

  static func date(_ iso: String, today: String) -> String {
    guard let day = LocalDay(iso) else { return "" }
    let head = String(format: "%02d %@", day.day, months[day.month - 1])
    return day.year == LocalDay(today)?.year ? head : "\(head) \(day.year)"
  }

  static func distance(from source: String, to trigger: String) -> String {
    guard let older = LocalDay(source), let newer = LocalDay(trigger) else { return "" }
    let months = monthsApart(older, newer)
    if months == 0 { return "\(max(1, Int((Double(older.days(until: newer)) / 7).rounded()))) WK" }
    return months < 12 ? "\(months) MO" : "\(months / 12) YR"
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
