import SwiftUI
import DomainKit
import RoadmapDomain

// A roadmap's Activity (Roadmap · iOS 01.13, 01.13b, 01.15), pushed from the title menu: the domain's read of the phone's
// copy, so it asks no server and reads the same signed out and with no connection, and a change the copy comes to hold
// shows as it lands. Each step's creation and completion, the symbol in the step's kind colour, its name and its time,
// under Today, Yesterday and Earlier; more than three steps added within a minute fold into one row a tap opens in place,
// and which stays open as a step lands within that minute. A row opens its step's page.
struct RoadmapActivity: View {
  let roadmap: RoadmapModel
  // The folds opened, by their ids.
  @State private var unfolded: Set<String> = []

  var body: some View {
    let open = roadmap.shown
    let days = roadmap.activity().map { ActivityDays($0, now: roadmap.moment, folds: true) }
    Group {
      if let open, let days, !days.sections.isEmpty {
        List {
          ForEach(days.sections) { section in
            Section {
              ForEach(section.entries) { entry in self.entry(entry, on: section.day, in: open, days: days) }
            } header: {
              section.day.header
            }.listRowBackground(RoadmapPalette.card)
          }
        }.listStyle(.insetGrouped).scrollContentBackground(.hidden).contentMargins(.top, RoomSpace.related, for: .scrollContent)
      } else if open != nil {
        ContentUnavailableView {
          Label { Text("No activity yet").foregroundStyle(RoadmapPalette.ink) } icon: {
            Image(systemName: "clock.arrow.circlepath").foregroundStyle(RoadmapPalette.inkDim)
          }
        } description: {
          Text("Steps you add and complete show here.").foregroundStyle(RoadmapPalette.inkDim)
        }
      }
    }.frame(maxWidth: .infinity, maxHeight: .infinity)
      .background { RoadmapPalette.canvas.ignoresSafeArea() }
      .tint(RoadmapPalette.accent)
      .navigationTitle("Activity").navigationBarTitleDisplayMode(.inline)
      .roomBar(.roadmap)
      .roadmapFoot(roadmap) {}
  }

  @ViewBuilder func entry(_ entry: ActivityDays.Entry, on day: ActivityDays.Day, in open: RoadmapModel.OpenRoadmap, days: ActivityDays) -> some View {
    switch entry {
    case .row(let row): self.row(row, on: day, in: open, days: days)
    // 01.13b: the steps added at once, under one row that says how many, whose chevron unfolds them in place.
    case .added(let rows):
      DisclosureGroup(isExpanded: Binding(get: { unfolded.contains(entry.id) }, set: { opens in
        guard opens else {
          unfolded.remove(entry.id)
          return
        }
        unfolded.insert(entry.id)
        roadmap.unfolded(rows.count)
      })) {
        ForEach(rows, id: \.step) { row in self.row(row, on: day, in: open, days: days) }
      } label: {
        let count = String(localized: "\(rows.count) steps", locale: .copy, comment: "How many steps: beside Opens on a step's page, and Activity's row of the steps added within one minute")
        let time = days.time(of: rows[0].at, on: day)
        HStack(spacing: 12) {
          ActivitySymbol(kind: .created, colour: RoadmapPalette.inkDim)
          Text(count).foregroundStyle(RoadmapPalette.ink).frame(maxWidth: .infinity, alignment: .leading)
          Text(time).foregroundStyle(RoadmapPalette.inkDim)
        }.accessibilityElement(children: .ignore)
          .accessibilityLabel(String(localized: "Added \(count), \(time)", comment: "VoiceOver on an Activity row: what was added, a step's name or how many steps were added at once, and when"))
          .accessibilityIdentifier("roadmap-activity-added")
      }.listRowInsets(ActivitySymbol.insets)
    }
  }

  // A creation or a completion: the step's name and the time, opening the step's page.
  func row(_ row: ActivityRead.Row, on day: ActivityDays.Day, in open: RoadmapModel.OpenRoadmap, days: ActivityDays) -> some View {
    let step = open.step(row.step)
    let name = step?.name ?? RoadmapModel.Row.name(of: "")
    let time = days.time(of: row.at, on: day)
    return NavigationLink(value: roadmap.stacked(.step(row.step, by: .activity))) {
      HStack(spacing: 12) {
        ActivitySymbol(kind: row.kind, colour: RoadmapPalette.kind(step?.step.color ?? ""))
        Text(name).foregroundStyle(RoadmapPalette.ink).frame(maxWidth: .infinity, alignment: .leading)
        Text(time).foregroundStyle(RoadmapPalette.inkDim)
      }
    }.listRowInsets(ActivitySymbol.insets)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(row.kind == .completed
                          ? String(localized: "Completed \(name), \(time)", comment: "VoiceOver on an Activity row: the step completed, and when")
                          : String(localized: "Added \(name), \(time)", comment: "VoiceOver on an Activity row: what was added, a step's name or how many steps were added at once, and when"))
      .accessibilityAddTraits(.isButton)
      .accessibilityIdentifier("roadmap-activity-row")
  }
}

// A step's History (Roadmap · iOS 03.12), pushed from its page's History row: the same read narrowed to the step, when it
// was added and when it was completed, under the same days. It opens nothing.
struct StepHistory: View {
  let roadmap: RoadmapModel
  let step: String

  var body: some View {
    let row = roadmap.shown?.step(step)
    let days = roadmap.activity(of: step).map { ActivityDays($0, now: roadmap.moment, folds: false) }
    List {
      ForEach(days?.sections ?? []) { section in
        Section {
          ForEach(section.entries) { entry in
            if case .row(let read) = entry {
              let time = days?.time(of: read.at, on: section.day) ?? ""
              LabeledContent {
                Text(time).foregroundStyle(RoadmapPalette.inkDim)
              } label: {
                HStack(spacing: 12) {
                  ActivitySymbol(kind: read.kind, colour: RoadmapPalette.kind(row?.step.color ?? ""))
                  Text(read.kind == .completed ? String(localized: "Completed", comment: "A step's History: the row of its completion")
                       : String(localized: "roadmap.history.added", defaultValue: "Added", comment: "A step's History: the row of its creation"))
                    .foregroundStyle(RoadmapPalette.ink)
                }
              }.listRowInsets(ActivitySymbol.insets).accessibilityElement(children: .combine).accessibilityIdentifier("roadmap-history-row")
            }
          }
        } header: {
          section.day.header
        }.listRowBackground(RoadmapPalette.card)
      }
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden).contentMargins(.top, RoomSpace.related, for: .scrollContent)
      .background { RoadmapPalette.canvas.ignoresSafeArea() }
      .modifier(HistoryTitle(step: row?.name ?? ""))
      .roomBar(.roadmap)
      .roadmapFoot(roadmap) {}
  }

  // History over the step's name: the system's subtitle on iOS 26, the room's title before it.
  struct HistoryTitle: ViewModifier {
    let step: String

    @ViewBuilder func body(content: Content) -> some View {
      if #available(iOS 26.0, *) {
        content.navigationTitle("History").navigationSubtitle(step).navigationBarTitleDisplayMode(.inline)
      } else {
        content.navigationBarTitleDisplayMode(.inline).roomTitle(String(localized: "History"), subtitle: step)
      }
    }
  }
}

// The symbol that leads a row of Activity and History: a plus for a step added, a check for one completed, in the column
// every row of the room's lists keeps for its symbol.
struct ActivitySymbol: View {
  static let insets = EdgeInsets(top: 11, leading: RoomSpace.inset, bottom: 11, trailing: 13)

  let kind: ActivityRead.Row.Kind
  let colour: Color
  @ScaledMetric(relativeTo: .body) private var column = 24.0

  var body: some View {
    Image(systemName: kind == .completed ? "checkmark.circle.fill" : "plus.circle.fill").imageScale(.large).foregroundStyle(colour)
      .frame(width: column).accessibilityHidden(true)
  }
}

// What Activity and History lay out of the domain's read (01.13, 01.13b, 03.12): its rows, in its order, under the day
// each falls on in the phone's zone, Today, Yesterday or Earlier, Today's and Yesterday's at their clock time and
// Earlier's at their date, the year only where it is not this one. Where it folds, more than three steps added within a
// minute of the first of them stand as one entry, named by that first step, so a step that lands within the minute joins
// the same entry; folding is the view's, and the read still gives each its row.
struct ActivityDays {
  enum Day: Hashable, CaseIterable {
    case today, yesterday, earlier

    var title: String {
      switch self {
      case .today: String(localized: "Today")
      case .yesterday: String(localized: "Yesterday")
      case .earlier: String(localized: "Earlier", comment: "Activity's section of the days before yesterday")
      }
    }

    // The day's section header, in the room's footnote over its lists.
    var header: some View {
      Text(title).font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim).textCase(nil)
    }
  }

  enum Entry: Identifiable {
    case row(ActivityRead.Row)
    case added([ActivityRead.Row])

    var id: String {
      switch self {
      case .row(let row): "\(row.kind.rawValue)-\(row.step)"
      case .added(let rows): "fold-\(rows[rows.count - 1].step)"
      }
    }
  }

  struct Section: Identifiable {
    let day: Day
    let entries: [Entry]

    var id: Day { day }
  }

  // More than this many steps added within a minute fold into one entry.
  static let foldsPast = 3
  static let foldWindowMs: Int64 = 60_000

  let sections: [Section]
  let now: Moment

  init(_ read: ActivityRead, now: Moment, folds: Bool) {
    let today = now.today
    let dayOf = { (row: ActivityRead.Row) -> Day in
      let fell = LocalDay(row.at, in: now.zone)
      if fell >= today { return .today }
      return fell == today.adding(days: -1) ? .yesterday : .earlier
    }
    self.now = now
    sections = Day.allCases.compactMap { (day: Day) -> Section? in
      let rows = read.rows.filter { (row: ActivityRead.Row) -> Bool in dayOf(row) == day }
      guard !rows.isEmpty else { return nil }
      return Section(day: day, entries: folds ? Self.folded(rows) : rows.map(Entry.row))
    }
  }

  // A run of creations, each within a minute of the run's first, is one entry where it holds more than three of them. The
  // rows are read from the oldest, so a run starts at its first step, and the entries are given newest first again.
  static func folded(_ rows: [ActivityRead.Row]) -> [Entry] {
    var entries: [Entry] = []
    var run: [ActivityRead.Row] = []
    let close = {
      entries += run.count > foldsPast ? [.added(Array(run.reversed()))] : run.map(Entry.row)
      run = []
    }
    for row in rows.reversed() {
      if row.kind == .created, let first = run.first, row.at.ms - first.at.ms < foldWindowMs {
        run.append(row)
        continue
      }
      close()
      if row.kind == .created { run = [row] } else { entries.append(.row(row)) }
    }
    close()
    return Array(entries.reversed())
  }

  // A row's time as its day's section shows it.
  func time(of instant: Instant, on day: Day) -> String {
    let date = Date(timeIntervalSince1970: Double(instant.ms) / 1_000)
    let zone = TimeZone(secondsFromGMT: now.zone.offsetSeconds(at: instant)) ?? .gmt
    var style = Date.FormatStyle(timeZone: zone)
    guard day == .earlier else { return style.hour().minute().format(date) }
    style = style.day().month(.abbreviated)
    let year = LocalDay(instant, in: now.zone).year
    return (year == now.today.year ? style : style.year()).format(date)
  }
}
