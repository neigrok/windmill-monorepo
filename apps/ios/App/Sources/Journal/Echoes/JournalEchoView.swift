import SwiftUI
import UIKit
import DomainKit

// Echo presentation stays here so the room's skin can change without changing its evidence.
struct JournalEchoButton: View {
  let echoes: JournalEchoes
  let day: String
  let writing: Bool
  let open: () -> Void
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @State private var visible = false
  var page: JournalEchoPage? { echoes.pages[day] }

  var body: some View {
    Group {
      if let page {
        Button(action: open) {
          HStack(spacing: 5) {
            Image(systemName: "quote.opening").font(.caption)
            Text(page.matches.count.formatted()).font(.callout.monospacedDigit())
          }.foregroundStyle(JournalPalette.lamp).padding(.horizontal, 10).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            .background(JournalPalette.lamp.opacity(echoes.arrivalDay == day ? 0.16 : 0.06), in: Capsule())
            .animation(reduceMotion ? nil : .easeInOut(duration: 1.2), value: echoes.arrivalDay == day)
        }.buttonStyle(.plain)
          .accessibilityLabel(Self.label(page.matches.count))
          .accessibilityHint("Opens echoes for \(JournalEchoSheet.date(day))")
          .accessibilityIdentifier("journal-echo-\(day)")
          .onScrollVisibilityChange { value in visible = value; if value { echoes.shown(day) } }
          .onChange(of: page.matches) { _, _ in if visible { echoes.shown(day) } }
          .task(id: visible && !writing && echoes.arrivalDay == day) {
            guard visible, !writing, echoes.arrivalDay == day else { return }
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

struct JournalEchoSheet: View {
  @Bindable var echoes: JournalEchoes
  let day: String
  let read: (JournalEchoDestination) -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.dismiss) var dismiss
  var appearance: ColorScheme {
    let system = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first?.traitCollection.userInterfaceStyle
    return JournalEchoFixture.appearance ?? (system == .light ? .light : .dark)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        if let page = echoes.pages[day] {
          VStack(alignment: .leading, spacing: 28) {
            VStack(alignment: .leading, spacing: 8) {
              Text(Self.date(day)).font(.subheadline.monospaced()).foregroundStyle(JournalPalette.inkDim)
              Text(JournalEchoButton.label(page.matches.count)).font(.headline).accessibilityAddTraits(.isHeader)
            }
            ForEach(page.matches, id: \.day) { match in
              VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                  Text(Self.date(match.day)).font(.subheadline.monospaced())
                  Text(Self.distance(from: match.day, to: day)).font(.caption).foregroundStyle(JournalPalette.inkDim)
                }.accessibilityElement(children: .combine)
                Text(match.text).font(.body).lineSpacing(5).foregroundStyle(JournalPalette.lamp)
                  .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if let provenance = match.provenance { Text(provenance).font(.caption).foregroundStyle(JournalPalette.inkDim) }
                Button {
                  let previous = echoes.destination
                  echoes.walk(from: day, to: match)
                  if let destination = echoes.destination, destination != previous { read(destination) }
                } label: {
                  Label("Read this page", systemImage: "arrow.up.left").font(.body).frame(minHeight: 48).contentShape(Rectangle())
                }.accessibilityLabel("Read your page from \(Self.date(match.day))")
                  .accessibilityHint("Returns to the earlier passage in the canvas")
                  .accessibilityIdentifier("echo-open-\(match.day)")
                ViewThatFits(in: .horizontal) {
                  HStack(spacing: 24) { verdict(match) }
                  VStack(alignment: .leading, spacing: 4) { verdict(match) }
                }
                Divider().padding(.top, 8)
              }
            }
            if !page.matches.isEmpty {
              Button { Task { await echoes.answer(.dismiss, day: day) } } label: {
                Text("None of these are useful").frame(minHeight: 48).contentShape(Rectangle())
              }.disabled(echoes.pendingDays.contains(day))
                .accessibilityIdentifier("echo-dismiss-page")
            }
          }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
        }
      }.background(JournalPalette.canvas).navigationTitle("Echoes").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .confirmationAction) {
            Button("Done") { echoes.openDay = nil; dismiss() }.accessibilityIdentifier("echo-close")
          }
        }
        .toolbarBackground(JournalPalette.canvas, for: .navigationBar).toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(appearance, for: .navigationBar)
        .tint(JournalPalette.lamp).accessibilityIdentifier("echo-sheet")
    }.presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.medium, .large])
      .presentationDragIndicator(.visible)
      .presentationBackground(JournalPalette.canvas)
      .environment(\.colorScheme, appearance)
  }

  @ViewBuilder func verdict(_ match: JournalEchoMatch) -> some View {
    Button {
      Task { await echoes.answer(.useful, day: day, matchDay: match.day) }
    } label: {
      Label("Useful", systemImage: match.useful == true ? "checkmark.circle.fill" : "checkmark.circle")
        .font(.subheadline).frame(minHeight: 48).contentShape(Rectangle())
    }.disabled(echoes.pendingDays.contains(day) || match.useful == true)
      .accessibilityLabel("Useful, \(Self.date(match.day))")
      .accessibilityValue(match.useful == true ? "Selected" : "Not selected")
      .accessibilityIdentifier("echo-useful-\(match.day)")
    Button { Task { await echoes.answer(.dismiss, day: day, matchDay: match.day) } } label: {
      Text("Not useful").font(.subheadline).foregroundStyle(JournalPalette.inkDim).frame(minHeight: 48).contentShape(Rectangle())
    }
      .accessibilityLabel("Not useful, \(Self.date(match.day))")
      .disabled(echoes.pendingDays.contains(day)).accessibilityIdentifier("echo-dismiss-\(match.day)")
  }

  static func date(_ iso: String) -> String {
    guard let day = LocalDay(iso) else { return "" }
    let calendar = Calendar(identifier: .gregorian)
    guard let date = calendar.date(from: DateComponents(timeZone: TimeZone(secondsFromGMT: 0), year: day.year, month: day.month, day: day.day)) else { return "" }
    let formatter = DateFormatter()
    formatter.calendar = calendar; formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateStyle = .long
    return formatter.string(from: date)
  }

  static func distance(from source: String, to trigger: String) -> String {
    guard let source = LocalDay(source), let trigger = LocalDay(trigger) else { return "" }
    let days = source.days(until: trigger)
    return "\(days) \(days == 1 ? "day" : "days") before this page"
  }
}

struct JournalFirstEcho: View {
  let echoes: JournalEchoes
  let open: (String) -> Void
  var body: some View {
    if let day = echoes.firstEchoDay, day == echoes.access.today {
      Button { open(day) } label: {
        Text("Something you wrote before is close to this page.")
          .font(.body).foregroundStyle(JournalPalette.lamp).multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      }.buttonStyle(.plain).padding(.horizontal, 24)
        .accessibilityHint("Opens the earlier passage")
        .onScrollVisibilityChange { visible in if visible { echoes.claimFirstEcho() } }
    }
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
        Button(day == echoes.access.today ? "Tonight" : JournalEchoSheet.date(day)) { echoes.stand(on: day) }
      }
    } label: { Label("How you got here", systemImage: "point.topleft.down.to.point.bottomright.curvepath").frame(minHeight: 44).contentShape(Rectangle()) }
    Button { echoes.stand(on: echoes.access.today) } label: {
      Text("Back to tonight").frame(minHeight: 44).contentShape(Rectangle())
    }.accessibilityIdentifier("echo-back-to-tonight")
  }
}
