import SwiftUI
import DomainKit
import GymDomain

struct LogTab: View {
  enum Destination: Hashable {
    case workout(ID<Session>)
    case bodyweight
    case record(ID<Exercise>, ID<Session>, source: String)
  }
  let gym: GymModel
  // iOS 26 brings a hidden workout back from the tab bar's accessory (GymRoom); iOS 18 from the Hidden row at the head.
  var tabBarAccessory = LogTab.hasTabBarAccessory
  @Environment(\.coachOpenAccount) private var openAccount
  @Environment(\.gymShareSession) private var share
  @Namespace private var moments
  @State var limit = 30
  @State var weighing = false
  @State var correcting: BodyweightScreen.Selection?
  @State var destination: Destination?
  @State var discard: ID<Session>?
  @State var historyNoticeDismissed = false

  static var hasTabBarAccessory: Bool {
    if #available(iOS 26, *) { return true }
    return false
  }

  var body: some View {
    let days = gym.logTimeline(limit: limit)
    let older = limit < gym.finishedLogSessions.count
    let dates = gym.dates
    List {
      if let hidden = hiddenRow {
        Section {
          Button { openHiddenWorkout() } label: { hidden }
            .disabled(gym.accountTransition).accessibilityIdentifier("gym-hidden-workout")
        }.listRowBackground(GymPalette.card)
      }
      OnThisPhoneSection(gym: gym)
      if gym.log == nil && !gym.readFailed {
        ProgressView().frame(maxWidth: .infinity).listRowBackground(GymPalette.canvas)
      } else if days.isEmpty && !gym.readFailed && (gym.isAnonymous || gym.log?.firstPullComplete == true) {
        // `calendar` drawn resizable, since the view's own sizing of that symbol draws nothing on iOS 26.
        ContentUnavailableView {
          Label { Text(emptyTitle) } icon: { Image(systemName: "calendar").resizable().scaledToFit().frame(width: 52) }
        }.listRowBackground(GymPalette.canvas)
      }
      ForEach(days) { day in
        Text(day.title).font(.footnote.weight(.semibold)).foregroundStyle(GymPalette.inkDim)
          .textCase(nil).accessibilityAddTraits(.isHeader)
          .listRowInsets(EdgeInsets(top: RoomSpace.inset, leading: RoomSpace.inset * 2, bottom: RoomSpace.related, trailing: RoomSpace.inset))
          .listRowSeparator(.hidden).listRowBackground(GymPalette.canvas)
        ForEach(Array(day.entries.enumerated()), id: \.element.id) { index, entry in
          row(entry, dates: dates)
            .listRowInsets(EdgeInsets(top: 0, leading: RoomSpace.inset, bottom: rowGap(after: index, in: day.entries), trailing: RoomSpace.inset))
            .listRowSeparator(.hidden).listRowBackground(Color.clear)
        }
        if day.id == days.last?.id && older {
          ProgressView().frame(maxWidth: .infinity).id(limit)
            .listRowSeparator(.hidden).listRowBackground(GymPalette.canvas)
            .accessibilityIdentifier("gym-log-older").onAppear { limit += 30 }
        }
      }
      if !older, let total, !days.isEmpty {
        Text(total).font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim)
          .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("gym-log-end")
          .listRowInsets(EdgeInsets(top: RoomSpace.inset, leading: RoomSpace.inset * 2, bottom: RoomSpace.inset, trailing: RoomSpace.inset))
          .listRowSeparator(.hidden).listRowBackground(GymPalette.canvas)
      }
    }.listStyle(.plain).modifier(GymPage(titleDisplayMode: .large))
      .navigationTitle("The log").accessibilityIdentifier("gym-log")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { RoomAccountButton(action: { openAccount?() }).disabled(gym.accountTransition) }
      }.roomBar(.gym)
      .safeAreaInset(edge: .bottom, spacing: 0) {
        VStack(spacing: RoomSpace.related) {
          GymTransient(gym: gym, message: historyNotice, dismiss: { historyNoticeDismissed = true },
                       errorIdentifier: "gym-log-error")
          FloatingAction(title: "Weigh in", symbol: "scalemass", labelled: true, identifier: "gym-weigh-in") {
            gym.telemetry.event("gym_action", properties: ["screen": "log", "action": "open", "item": "weigh_in"])
            weighing = true
          }
            .disabled(gym.accountTransition)
        }
      }
      .discardWorkoutQuestion(gym, screen: "log", isPresented: Binding(get: { discard != nil }, set: { if !$0 { discard = nil } }),
                           sets: discard.flatMap { gym.log?.sets(session: $0).count } ?? 0) {
        if let discard { gym.run(DiscardSession(discard)) }
      }
      .sheet(isPresented: $weighing) { WeighInSheet(gym: gym) }
      .sheet(item: $correcting) { WeighInSheet(gym: gym, entry: $0.entry) }
      .navigationDestination(item: $destination) { target in
        switch target {
        case .workout(let id): SessionDetailScreen(gym: gym, sessionID: id)
        case .bodyweight: BodyweightScreen(gym: gym)
        case .record(let id, let selected, let source):
          MovementRecordScreen(gym: gym, exerciseID: id, selected: selected)
            .navigationTransition(.zoom(sourceID: source, in: moments))
        }
      }
      .onAppear { prepareLogFixture(); gym.telemetry.event("gym_screen_viewed", properties: ["screen": "log"]) }
      .onChange(of: gym.account) { _, _ in limit = 30; historyNoticeDismissed = false; correcting = nil; destination = nil }
  }

  // An empty log never says there are no workouts while one is open.
  var emptyTitle: String { gym.openSession == nil ? "No workouts yet" : "No finished workouts yet" }

  // The log's end, its total, once the whole log is loaded and holds more than the one row.
  var total: String? {
    guard gym.isAnonymous || gym.log?.firstPullComplete == true, gym.finishedLogSessions.count > 1 else { return nil }
    return GymCount.of(gym.finishedLogSessions.count, "workout")
  }

  // Signed in before the first pull lands, the band says the history is still arriving; it never covers a refusal.
  var historyNotice: String? {
    guard !gym.isAnonymous, gym.log?.firstPullComplete == false, !historyNoticeDismissed,
          gym.error == nil, gym.notices.isEmpty else { return nil }
    return "Your full training history needs a connection to finish syncing."
  }

  // While the open workout is hidden, the head's first row is that workout, and it brings the logger back. It names the
  // day it began only when that was not today.
  var hiddenRow: GymRow? {
    guard !tabBarAccessory, gym.workoutHidden, let open = gym.openSession else { return nil }
    let dates = gym.dates, start = open.startedAt
    let since = LocalDay(start, in: dates.moment.zone) == dates.moment.today ? dates.time(start) : dates.dayAndTime(start, inSentence: true)
    return GymRow(title: open.name ?? Readout.noRoutine, meta: "Open since \(since)", trailing: .door)
  }
  // The row is iOS 18's door back, the one return iOS 26's accessory makes, recorded as door: row.
  func openHiddenWorkout() { gym.openHiddenWorkout(from: .row) }

  func rowGap(after index: Int, in entries: [LogTimelineEntry]) -> CGFloat {
    guard index + 1 < entries.count else { return 0 }
    if case .session(let session, _) = entries[index].kind,
       case .best(_, let record) = entries[index + 1].kind, record.point.id == session.id { return RoomSpace.small }
    return RoomSpace.related + RoomSpace.small
  }

  @ViewBuilder func row(_ entry: LogTimelineEntry, dates: GymDate) -> some View {
    switch entry.kind {
    case .session(let session, let recordDot): sessionRow(session, recordDot: recordDot, dates: dates)
    case .best(let id, let record): bestMoment(entry, id: id, record: record)
    case .month(let first):
      Text(LogPresentation.trainedEvery(first, dates: dates))
        .font(.footnote).foregroundStyle(GymPalette.inkDim).padding(RoomSpace.inset)
        .accessibilityIdentifier("gym-month-moment")
    case .weight(let weight): weightRow(weight, dates: dates)
    }
  }

  func sessionRow(_ session: Session, recordDot: Bool, dates: GymDate) -> some View {
    Button { destination = .workout(session.id) } label: {
      LogEntryLabel(title: session.name ?? Readout.noRoutine,
                    meta: gym.log?.readout(session: session.id).map(LogPresentation.sessionFacts),
                    symbol: "dumbbell", time: dates.time(session.startedAt), workout: true,
                    record: recordDot, unsent: gym.sessionIsUnsent(session.id))
        .padding(.horizontal, RoomSpace.inset).padding(.vertical, 14)
        .frame(minHeight: 76)
        .background(GymPalette.card, in: .card)
    }.buttonStyle(.plain).accessibilityIdentifier("gym-log-session-\(session.id)")
      .contextMenu {
        Button("Open workout") { destination = .workout(session.id) }
        Button("Share this workout", systemImage: "square.and.arrow.up") { share?(session.id) }
        Button("Discard workout", systemImage: "trash", role: .destructive) { discard = session.id }
      }
      .trashSwipe("Discard workout") { discard = session.id }
      .accessibilityAction(named: "Share this workout") { share?(session.id) }
      .accessibilityAction(named: "Discard workout") { discard = session.id }
  }

  func weightRow(_ weight: Bodyweight.Entry, dates: GymDate) -> some View {
    Button { correct(weight) } label: {
      LogEntryLabel(title: "\(Readout.weight(weight.kg)) kg", meta: "Weigh-in", symbol: "scalemass",
                    time: weight.time(in: dates.moment.zone).map(dates.time))
        .padding(.horizontal, RoomSpace.inset).padding(.vertical, 9).frame(minHeight: 60)
        .overlay(alignment: .top) { Rectangle().fill(GymPalette.line).frame(height: 1).padding(.horizontal, RoomSpace.inset) }
        .overlay(alignment: .bottom) { Rectangle().fill(GymPalette.line).frame(height: 1).padding(.horizontal, RoomSpace.inset) }
        .contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityIdentifier("gym-weight-moment")
      .accessibilityLabel("Weigh-in, \(BodyweightScreen.spoken(weight, dates: dates))")
      .accessibilityHint("Correct this weigh-in")
      .contextMenu {
        Button("Bodyweight", systemImage: "chart.xyaxis.line") { openBodyweight() }
          .accessibilityIdentifier("gym-bodyweight-door")
        Button("Delete weigh-in", systemImage: "trash", role: .destructive) { gym.logDeleteWeighIn(day: weight.day) }
      }
      .trashSwipe("Delete weigh-in") { gym.logDeleteWeighIn(day: weight.day) }
      .accessibilityAction(named: "Correct weigh-in") { correct(weight) }
      .accessibilityAction(named: "Bodyweight") { openBodyweight() }
      .accessibilityAction(named: "Delete weigh-in") { gym.logDeleteWeighIn(day: weight.day) }
  }

  func correct(_ weight: Bodyweight.Entry) {
    guard !gym.accountTransition else { return }
    gym.telemetry.event("gym_action", properties: ["screen": "log", "action": "fix", "item": "weigh_in"])
    correcting = BodyweightScreen.Selection(entry: weight)
  }

  func openBodyweight() {
    gym.telemetry.event("gym_action", properties: ["screen": "log", "action": "inspect", "item": "bodyweight"])
    destination = .bodyweight
  }

  func bestMoment(_ entry: LogTimelineEntry, id: ID<Exercise>, record: ProgressRecords.Record) -> some View {
    Button { destination = .record(id, record.point.id, source: entry.id) } label: {
      HStack(spacing: 14) {
        RoundedRectangle(cornerRadius: 1).fill(GymPalette.record).frame(width: 2, height: 32).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text("New best · \(gym.catalogue.find(id)?.name ?? "Movement")").font(.subheadline).foregroundStyle(GymPalette.record)
          Text("\(Readout.estimatedWeight(record.estimate)) kg est").font(.footnote).foregroundStyle(GymPalette.inkDim)
        }.frame(maxWidth: .infinity, alignment: .leading)
        DoorChevron(room: .gym)
      }.padding(.horizontal, RoomSpace.inset).padding(.vertical, RoomSpace.small).frame(minHeight: 48)
        .contentShape(Rectangle()).matchedTransitionSource(id: entry.id, in: moments)
    }.buttonStyle(.plain).accessibilityIdentifier("gym-best-moment")
  }
}

struct LogEntryLabel: View {
  let title: String
  let meta: String?
  let symbol: String
  let time: String?
  var workout = false
  var record = false
  var unsent = false
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: symbol).resizable().scaledToFit().frame(width: 20, height: 20).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: RoomSpace.related) {
          Text(title).font(workout ? .body.weight(.semibold) : .body).monospacedDigit()
          if record { Circle().fill(GymPalette.record).frame(width: 8, height: 8).accessibilityLabel("New best") }
        }
        if let meta { Text(meta).font(.footnote).foregroundStyle(GymPalette.inkDim) }
        if typeSize.isAccessibilitySize { clock }
      }.frame(maxWidth: .infinity, alignment: .leading)
      if !typeSize.isAccessibilitySize { clock }
      DoorChevron(room: .gym)
    }.foregroundStyle(GymPalette.ink)
  }

  var clock: some View {
    HStack(spacing: RoomSpace.small) {
      if unsent { Image(systemName: "iphone").accessibilityLabel("On this phone") }
      if let time { Text(time).monospacedDigit() }
    }.font(.subheadline).foregroundStyle(GymPalette.inkDim)
  }
}
