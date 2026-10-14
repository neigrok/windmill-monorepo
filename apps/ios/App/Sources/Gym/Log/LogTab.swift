import SwiftUI
import DomainKit
import GymDomain
import SyncAPI

struct LogTab: View {
  let gym: GymModel
  @Environment(\.coachOpenAccount) private var openAccount
  @Environment(\.dynamicTypeSize) private var typeSize
  @ScaledMetric(relativeTo: .body) private var dot = 8.0
  @State var limit = 30
  @State var expanded: String?
  @State var weighing = false
  @State var sharing: String?
  @State var shareMessage: String?
  @State var shareGeneration = 0
  @State var shareTask: Task<Void, Never>?
  @State var historyNoticeDismissed = false

  var body: some View {
    let progress = gym.log?.progress
    let months = gym.logTimeline(limit: limit)
    let older = limit < gym.finishedLogSessions.count
    List {
      OnThisPhoneSection(gym: gym)
      head(progress)
      if gym.log == nil && !gym.readFailed {
        ProgressView().frame(maxWidth: .infinity).listRowBackground(GymPalette.canvas)
      } else if months.isEmpty && !gym.readFailed && (gym.isAnonymous || gym.log?.firstPullComplete == true) {
        ContentUnavailableView("No sessions yet", systemImage: "clock", description: Text("Your training will land here."))
          .listRowBackground(GymPalette.canvas)
      }
      if let moment = gym.log?.moment {
        ForEach(months) { month in
          let last = month.id == months.last?.id
          Section {
            ForEach(month.entries) { entry in row(entry, progress: progress, moment: moment) }
            if last && older {
              ProgressView().frame(maxWidth: .infinity).id(limit)
                .accessibilityIdentifier("gym-log-older").onAppear { limit += 30 }
            }
          } header: { Text(month.title) } footer: {
            if last && !older, let first = gym.finishedLogSessions.last {
              Text("First session · \(LogPresentation.brief(LocalDay(first.startedAt, in: moment.zone), today: moment.today))")
                .monospacedDigit().foregroundStyle(GymPalette.inkFaint).accessibilityIdentifier("gym-log-first-session")
            }
          }.listRowBackground(GymPalette.card)
        }
      }
    }.listStyle(.insetGrouped).modifier(GymPage(titleDisplayMode: .large))
      .navigationTitle("The log").accessibilityIdentifier("gym-log")
      .toolbar { ToolbarItem(placement: .topBarTrailing) { RoomAccountButton(action: { openAccount?() }).disabled(gym.accountTransition) } }
      .safeAreaInset(edge: .bottom) {
        VStack(alignment: .trailing, spacing: 0) {
          GymTransient(gym: gym, message: shareMessage ?? historyNotice,
                       dismiss: { if shareMessage != nil { shareMessage = nil } else { historyNoticeDismissed = true } },
                       errorIdentifier: "gym-log-error", undoIdentifier: "gym-log-undo")
          Button { weighing = true } label: {
            Image(systemName: "scalemass").font(.system(size: 18)).foregroundStyle(GymPalette.ink)
          }.buttonStyle(RoomSeatStyle())
            .accessibilityLabel("Weigh in").accessibilityIdentifier("gym-weigh-in")
            .padding(.trailing, RoomSpace.inset).padding(.bottom, RoomSpace.inset)
        }.frame(maxWidth: .infinity, alignment: .trailing)
      }
      .sheet(isPresented: $weighing) { WeighInSheet(gym: gym) }
      .onAppear { prepareLogFixture(); gym.telemetry.event("gym_screen_viewed", properties: ["screen": "log"]) }
      .onDisappear { shareGeneration += 1; shareTask?.cancel(); sharing = nil }
      .onChange(of: gym.account) { _, _ in
        shareGeneration += 1; shareTask?.cancel(); sharing = nil; shareMessage = nil; limit = 30; expanded = nil; historyNoticeDismissed = false
      }
  }

  // Signed in before the first pull lands, the band says the history is still arriving; it never covers a refusal or an Undo.
  var historyNotice: String? {
    guard !gym.isAnonymous, gym.log?.firstPullComplete == false, !historyNoticeDismissed,
          gym.error == nil, gym.notices.isEmpty, gym.undoOffers.isEmpty else { return nil }
    return "Your full training history needs a connection to finish syncing."
  }

  func head(_ progress: StatsProgress?) -> some View {
    Section {
      NavigationLink { BodyweightScreen(gym: gym) } label: {
        GymRow(title: "Bodyweight", meta: gym.bodyweight?.reading.map { "\(Readout.weight($0.entry.kg)) kg · \(Readout.ago(days: $0.daysAgo))" })
      }.accessibilityIdentifier("gym-bodyweight-door")
    } footer: {
      if let progress, let log = gym.log, !gym.readFailed, let weeks = progress.consistency(now: log.moment.now, zone: log.moment.zone) {
        Text("Trained \(weeks) of the last 4 weeks").monospacedDigit().foregroundStyle(GymPalette.inkDim)
          .accessibilityIdentifier("gym-log-consistency")
      }
    }.listRowBackground(GymPalette.card)
  }

  @ViewBuilder func row(_ entry: LogTimelineEntry, progress: StatsProgress?, moment: Moment) -> some View {
    switch entry.kind {
    case .session(let session): sessionRow(session, progress: progress, moment: moment)
    case .best(let id, let point, let previous): bestMoment(entry, id: id, point: point, previous: previous, progress: progress, zone: moment.zone)
    case .month(_, let weeks):
      Text("Trained \(weeks) of \(weeks) weeks").foregroundStyle(GymPalette.ink).monospacedDigit()
        .accessibilityIdentifier("gym-month-moment")
    case .weight(let weight):
      NavigationLink { BodyweightScreen(gym: gym) } label: {
        HStack {
          Text("Weighed in · \(Readout.weight(weight.kg)) kg").foregroundStyle(GymPalette.ink).monospacedDigit()
          Spacer()
          Text(LogPresentation.dayLabel(weight.day, today: moment.today)).font(.footnote).foregroundStyle(GymPalette.inkDim)
        }
      }.accessibilityIdentifier("gym-weight-moment")
    }
  }

  func sessionRow(_ session: Session, progress: StatsProgress?, moment: Moment) -> some View {
    let record = gym.logRecordFact(session.id, progress: progress)
    let facts = record ?? gym.log?.readout(session: session.id).map(LogPresentation.sessionFacts) ?? ""
    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: RoomSpace.small))
      : AnyLayout(HStackLayout(spacing: RoomSpace.related))
    return NavigationLink { SessionDetailScreen(gym: gym, sessionID: session.id) } label: {
      layout {
        VStack(alignment: .leading, spacing: RoomSpace.small) {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(session.name ?? Readout.noRoutine).font(.body.weight(.semibold)).foregroundStyle(GymPalette.ink)
            if record != nil { recordDot }
          }
          Text(facts).font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim)
        }.frame(maxWidth: .infinity, alignment: .leading)
        HStack(spacing: RoomSpace.related) {
          if gym.sessionIsUnsent(session.id) {
            Image(systemName: "iphone").font(.footnote).foregroundStyle(GymPalette.inkDim).accessibilityLabel("On this phone")
          }
          Text(LogPresentation.dayLabel(LocalDay(session.startedAt, in: moment.zone), today: moment.today)).font(.footnote).foregroundStyle(GymPalette.inkDim)
        }
      }
    }.accessibilityIdentifier("gym-log-session-\(session.id)")
      .contextMenu {
        NavigationLink("Open workout") { SessionDetailScreen(gym: gym, sessionID: session.id) }
        Button("Share this workout", systemImage: "square.and.arrow.up") { share(session.id) }.disabled(sharing != nil)
        Button("Discard workout", systemImage: "trash", role: .destructive) { gym.run(DiscardSession(session.id)) }
      }
      .swipeActions { Button("Discard", role: .destructive) { gym.run(DiscardSession(session.id)) } }
      .accessibilityAction(named: "Share this workout") { share(session.id) }
      .accessibilityAction(named: "Discard workout") { gym.run(DiscardSession(session.id)) }
  }

  func bestMoment(_ entry: LogTimelineEntry, id: ID<Exercise>, point: MovementProgress.Point, previous: MovementProgress.Point?,
                  progress: StatsProgress?, zone: any Zone) -> some View {
    let value = point.fact.estimate!.e1rm
    let change = previous.map {
      "up \(Readout.estimatedWeight(value - $0.fact.estimate!.e1rm)) kg since \(LogPresentation.since(LocalDay($0.startedAt, in: zone), best: LocalDay(point.startedAt, in: zone)))"
    } ?? LogPresentation.brief(point.startedAt.date)
    let window = progress?.movement(id).window(now: point.startedAt, zone: zone)
    return DisclosureGroup(isExpanded: Binding(get: { expanded == entry.id }, set: { open in
      expanded = open ? entry.id : nil
      if open { gym.telemetry.event("gym_moment_opened", properties: [:]) }
    })) {
      if let window, window.hasChart(in: zone), let first = window.logPlotPoints.first {
        LogDatedChart(points: window.logPlotPoints, from: first.date, through: point.startedAt.date, series: .strength,
                      bestID: window.best?.id.description, compact: true)
      }
      if let window {
        Text("Last 12 weeks · \(GymCount.of(window.sessions.count, "session"))").font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim)
      }
      NavigationLink { MovementRecordScreen(gym: gym, exerciseID: id) } label: { Text("Open record").foregroundStyle(GymPalette.ink) }
        .accessibilityIdentifier("gym-open-record")
    } label: {
      VStack(alignment: .leading, spacing: RoomSpace.small) {
        HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) {
          recordDot
          Text("\(gym.catalogue.find(id)?.name ?? "Movement") · new best").foregroundStyle(GymPalette.ink)
        }
        Text("\(Readout.estimatedWeight(value)) kg est · \(change)").font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim)
      }
    }.accessibilityIdentifier("gym-best-moment")
      .accessibilityValue(expanded == entry.id ? "Expanded" : "Collapsed")
  }

  // 8 pt at the default size, centred on the first line's capitals at every size.
  var recordDot: some View {
    let size = dot
    return Circle().fill(GymPalette.record).frame(width: size, height: size)
      .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + size * 0.75 }
      .accessibilityHidden(true)
  }

  func share(_ id: ID<Session>) {
    guard sharing == nil else { return }
    sharing = id.description; shareMessage = nil; shareGeneration += 1
    let generation = shareGeneration
    shareTask = Task {
      defer { if generation == shareGeneration { sharing = nil } }
      do {
        let link = try await gym.mintSessionShare(id)
        try Task.checkCancellation()
        UIPasteboard.general.string = link.link(base: gym.runtime?.settings.baseURL?.absoluteString ?? "https://windmill.works")
        shareMessage = "Link copied — anyone who has it can read this workout"
      } catch {
        guard !Task.isCancelled, generation == shareGeneration else { return }
        shareMessage = SessionShareModel.message(error, revoking: false)
      }
    }
  }
}
