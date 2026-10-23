import SwiftUI
import DomainKit
import GymDomain

struct LogTab: View {
  let gym: GymModel
  // iOS 26 brings a hidden workout back from the tab bar's accessory (GymRoom); iOS 18 from the Hidden row at the head.
  var tabBarAccessory = LogTab.hasTabBarAccessory
  @Environment(\.coachOpenAccount) private var openAccount
  @Environment(\.gymShareSession) private var share
  @Namespace private var moments
  @State var limit = 30
  @State var weighing = false
  @State var discard: ID<Session>?
  @State var historyNoticeDismissed = false

  static var hasTabBarAccessory: Bool {
    if #available(iOS 26, *) { return true }
    return false
  }

  var body: some View {
    let months = gym.logTimeline(limit: limit)
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
      head
      if gym.log == nil && !gym.readFailed {
        ProgressView().frame(maxWidth: .infinity).listRowBackground(GymPalette.canvas)
      } else if months.isEmpty && !gym.readFailed && (gym.isAnonymous || gym.log?.firstPullComplete == true) {
        // `calendar` drawn resizable, since the view's own sizing of that symbol draws nothing on iOS 26.
        ContentUnavailableView {
          Label { Text(emptyTitle) } icon: { Image(systemName: "calendar").resizable().scaledToFit().frame(width: 52) }
        }.listRowBackground(GymPalette.canvas)
      }
      ForEach(months) { month in
        let last = month.id == months.last?.id
        Section {
          ForEach(month.entries) { entry in row(entry, dates: dates) }
          if last && older {
            ProgressView().frame(maxWidth: .infinity).id(limit)
              .accessibilityIdentifier("gym-log-older").onAppear { limit += 30 }
          }
        } header: { Text(month.title) } footer: {
          if last && !older, let total {
            Text(total).monospacedDigit().foregroundStyle(GymPalette.inkDim).accessibilityIdentifier("gym-log-end")
          }
        }.listRowBackground(GymPalette.card)
      }
    }.listStyle(.insetGrouped).modifier(GymPage(titleDisplayMode: .large))
      .navigationTitle("The log").accessibilityIdentifier("gym-log")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { RoomAccountButton(action: { openAccount?() }).disabled(gym.accountTransition) }
      }.roomBar(.gym)
      .reachBand {
        VStack(spacing: RoomSpace.related) {
          GymTransient(gym: gym, message: historyNotice, dismiss: { historyNoticeDismissed = true },
                       errorIdentifier: "gym-log-error")
          FloatingAction(title: "Weigh in", symbol: "scalemass", labelled: true, identifier: "gym-weigh-in") { weighing = true }
            .disabled(gym.accountTransition)
        }
      }
      .discardWorkoutAlert(gym, screen: "log", isPresented: Binding(get: { discard != nil }, set: { if !$0 { discard = nil } }),
                           sets: discard.flatMap { gym.log?.sets(session: $0).count } ?? 0) {
        if let discard { gym.run(DiscardSession(discard)) }
      }
      .sheet(isPresented: $weighing) { WeighInSheet(gym: gym) }
      .onAppear { prepareLogFixture(); gym.telemetry.event("gym_screen_viewed", properties: ["screen": "log"]) }
      .onChange(of: gym.account) { _, _ in limit = 30; historyNoticeDismissed = false }
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

  // The head: Bodyweight once a weigh-in exists, with the weeks trained as its footer.
  @ViewBuilder var head: some View {
    let reading = gym.bodyweight?.reading
    let consistency = gym.logConsistency
    if reading != nil || consistency != nil {
      Section {
        if let reading {
          NavigationLink { BodyweightScreen(gym: gym) } label: {
            GymRow(title: "Bodyweight", meta: "\(Readout.weight(reading.entry.kg)) kg · \(Readout.ago(days: reading.daysAgo))")
          }.accessibilityIdentifier("gym-bodyweight-door")
        }
      } footer: {
        if let consistency {
          Text(consistency).monospacedDigit().foregroundStyle(GymPalette.inkDim)
            .accessibilityIdentifier("gym-log-consistency")
        }
      }.listRowBackground(GymPalette.card)
    }
  }

  @ViewBuilder func row(_ entry: LogTimelineEntry, dates: GymDate) -> some View {
    switch entry.kind {
    case .session(let session, let recordDot): sessionRow(session, recordDot: recordDot, dates: dates)
    case .best(let id, let record): bestMoment(entry, id: id, record: record, dates: dates)
    case .month(let first):
      GymRow(title: LogPresentation.trainedEvery(first, dates: dates)).accessibilityIdentifier("gym-month-moment")
    case .weight(let weight):
      NavigationLink { BodyweightScreen(gym: gym) } label: {
        GymRow(title: "Weighed in · \(Readout.weight(weight.kg)) kg", trailing: .fact(dates.rowDay(weight.day)))
      }.accessibilityIdentifier("gym-weight-moment")
    }
  }

  // A record its moment states carries nothing on its row; one the week's cap left without a moment carries the dot.
  func sessionRow(_ session: Session, recordDot: Bool, dates: GymDate) -> some View {
    NavigationLink { SessionDetailScreen(gym: gym, sessionID: session.id) } label: {
      GymRow(title: session.name ?? Readout.noRoutine, meta: gym.log?.readout(session: session.id).map(LogPresentation.sessionFacts),
             titleDot: recordDot ? .dot(GymPalette.record, label: "new best") : nil,
             trailing: .fact(dates.rowDay(session.startedAt), unsent: gym.sessionIsUnsent(session.id)))
    }.accessibilityIdentifier("gym-log-session-\(session.id)")
      .contextMenu {
        NavigationLink("Open workout") { SessionDetailScreen(gym: gym, sessionID: session.id) }
        Button("Share this workout", systemImage: "square.and.arrow.up") { share?(session.id) }
        Button("Discard workout", systemImage: "trash", role: .destructive) { discard = session.id }
      }
      .trashSwipe("Discard workout") { discard = session.id }
      .accessibilityAction(named: "Share this workout") { share?(session.id) }
      .accessibilityAction(named: "Discard workout") { discard = session.id }
  }

  // A new best is a door to its movement's Record, which zooms from the moment and opens at the session that set it.
  func bestMoment(_ entry: LogTimelineEntry, id: ID<Exercise>, record: ProgressRecords.Record, dates: GymDate) -> some View {
    NavigationLink {
      MovementRecordScreen(gym: gym, exerciseID: id, selected: record.point.id)
        .navigationTransition(.zoom(sourceID: entry.id, in: moments))
    } label: {
      GymRow(title: "\(gym.catalogue.find(id)?.name ?? "Movement") · new best", meta: LogPresentation.newBest(record, dates: dates),
             leading: .dot(GymPalette.record))
        .matchedTransitionSource(id: entry.id, in: moments)
    }.accessibilityIdentifier("gym-best-moment")
  }
}
