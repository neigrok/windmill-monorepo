import SwiftUI
import DomainKit
import GymDomain
import SyncAPI

struct LogTab: View {
  let gym: GymModel
  @Environment(\.colorScheme) var scheme
  @Environment(\.dynamicTypeSize) var typeSize
  @State var limit = 30
  @State var loading = false
  @State var olderFailed = false
  @State var expanded: String?
  @State var weighing = false
  @State var sharing: String?
  @State var shareMessage: String?
  @State var shareGeneration = 0
  @State var shareTask: Task<Void, Never>?
  var palette: LogPalette { LogPalette(dark: scheme == .dark) }

  var body: some View {
    let progress = gym.log?.progress
    List {
      logHead
      progressStrip(progress)
      ForEach(gym.logTimeline(limit: limit)) { month in
        Section(month.title) { ForEach(month.entries) { entry in timelineRow(entry, progress: progress) } }.listRowBackground(palette.surface)
      }
      logFooter
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden).background(palette.canvas).foregroundStyle(palette.ink)
      .navigationTitle("The log").navigationBarTitleDisplayMode(.inline).accessibilityIdentifier("gym-log")
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 0) {
          LogNoticeBand(gym: gym)
          Button { weighing = true } label: { Label("Weigh in", systemImage: "plus").frame(maxWidth: .infinity).foregroundStyle(scheme == .dark ? .black : .white) }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .frame(maxWidth: .infinity).padding().accessibilityIdentifier("gym-weigh-in")
        }.background(palette.canvas)
      }
      .sheet(isPresented: $weighing) { WeighInSheet(gym: gym) }
      .onAppear { prepareLogFixture(); gym.telemetry.event("gym_screen_viewed", properties: ["screen": "log"]) }
      .onDisappear { shareGeneration += 1; shareTask?.cancel(); sharing = nil }
      .onChange(of: gym.account) { _, _ in shareGeneration += 1; shareTask?.cancel(); sharing = nil; shareMessage = nil; limit = 30; expanded = nil }
      .tint(palette.accent)
  }

  @ViewBuilder var logHead: some View {
      if let reading = gym.bodyweight?.reading {
        Section {
          NavigationLink { BodyweightScreen(gym: gym) } label: {
            VStack(alignment: .leading, spacing: 5) {
              Text("Bodyweight")
              Text("\(Readout.weight(reading.entry.kg)) kg · \(reading.daysAgo == 0 ? "today" : reading.daysAgo == 1 ? "yesterday" : "\(reading.daysAgo) days ago")")
                .font(.subheadline.monospaced()).foregroundStyle(palette.dim)
            }
          }.accessibilityIdentifier("gym-bodyweight-door")
        } footer: { Text("Coach can read this. It can never write it.") }.listRowBackground(palette.surface)
      } else {
        Section { NavigationLink("Bodyweight") { BodyweightScreen(gym: gym) }.accessibilityIdentifier("gym-bodyweight-door") }
          .listRowBackground(palette.surface)
      }
      if gym.readFailed {
        Section { Text("Progress unavailable").font(.headline); Text("Your progress could not be read."); Button("Try again") { gym.refresh() } }
          .listRowBackground(palette.surface)
      } else if gym.log == nil || gym.log?.firstPullComplete == false && !gym.isAnonymous {
        Section { ProgressView("Reading progress…") }.listRowBackground(palette.surface)
      }
      if gym.logTimeline(limit: limit).isEmpty && !gym.readFailed && (gym.isAnonymous || gym.log?.firstPullComplete == true) {
        ContentUnavailableView("No sessions yet", systemImage: "clock", description: Text("Your training will land here."))
          .listRowBackground(palette.canvas)
      }
  }

  @ViewBuilder func progressStrip(_ snapshot: StatsProgress?) -> some View {
    if let snapshot, let log = gym.log, !gym.readFailed, snapshot.isComplete {
      let ids = Set(snapshot.sessions.flatMap { $0.movements.map(\.exerciseId) })
      let movements = ids.map { snapshot.movement($0).window(now: log.moment.now, zone: log.moment.zone) }
        .filter { !$0.sessions.isEmpty }.sorted {
          let a = $0.sessions.last?.startedAt ?? Instant(ms: 0), b = $1.sessions.last?.startedAt ?? Instant(ms: 0)
          return a == b ? $0.exerciseId < $1.exerciseId : a > b
        }
      if !movements.isEmpty {
        Section {
          if let count = snapshot.consistency(now: log.moment.now, zone: log.moment.zone) {
            Text("Trained \(count) of the last 4 weeks").font(.caption.monospaced()).foregroundStyle(palette.dim)
          }
          ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 16) {
              ForEach(movements, id: \.exerciseId) { progress in
                NavigationLink { MovementRecordScreen(gym: gym, exerciseID: progress.exerciseId) } label: {
                  VStack(alignment: .leading, spacing: 8) {
                    Label(gym.catalogue.find(progress.exerciseId)?.name ?? "Movement", systemImage: "chevron.right").font(.headline)
                    if progress.hasChart(in: log.moment.zone), let first = progress.logPlotPoints.first {
                      LogDatedChart(points: progress.logPlotPoints, from: first.date, through: LogPresentation.date(log.moment.now), gapDays: 21, bestID: progress.best?.id.description, compact: true)
                    }
                    Text("Last 12 weeks · \(progress.sessions.count) sessions").font(.caption.monospaced()).foregroundStyle(palette.dim)
                    if let best = progress.best?.fact.estimate { Text("best \(Readout.estimate(best.e1rm))").font(.subheadline.monospaced()).foregroundStyle(palette.record) }
                    if let heavy = progress.heaviest?.fact.heaviest {
                      Text(heavy.weightKg == 0 ? "most reps \(heavy.reps) · bodyweight" : "heaviest \(Readout.effort(weightKg: heavy.weightKg, reps: heavy.reps))").font(.subheadline.monospaced()).foregroundStyle(palette.dim)
                    }
                  }.padding(12).containerRelativeFrame(.horizontal, alignment: .leading) { width, _ in
                    typeSize.isAccessibilitySize ? width : min(284, width)
                  }.background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
                }.buttonStyle(.plain).accessibilityIdentifier("gym-progress-movement")
              }
            }.scrollTargetLayout()
          }.scrollTargetBehavior(.viewAligned).scrollIndicators(.hidden).accessibilityLabel("Progress by movement")
        }.listRowBackground(palette.canvas).listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
      }
    }
  }

  @ViewBuilder var logFooter: some View {
      if !gym.finishedLogSessions.isEmpty {
        Section {
          if limit < gym.finishedLogSessions.count || olderFailed {
            Button(olderFailed ? "Retry" : loading ? "Loading…" : "Load older") { loadOlder() }
              .disabled(loading).accessibilityIdentifier("gym-log-older")
            if olderFailed { Text("That read failed.").font(.subheadline) }
          } else if let first = gym.finishedLogSessions.last {
            Text("First session · \(LogPresentation.brief(LogPresentation.date(first.startedAt)))").font(.caption.monospaced()).foregroundStyle(palette.dim)
          }
        }.listRowBackground(palette.surface)
      }
      if let shareMessage { Section { Text(shareMessage).font(.subheadline) }.listRowBackground(palette.surface) }
  }

  @ViewBuilder func timelineRow(_ entry: LogTimelineEntry, progress: StatsProgress?) -> some View {
            switch entry.kind {
            case .session(let session): sessionRow(session, progress: progress)
            case .best(let id, let point, let previous): bestMoment(entry, id: id, point: point, previous: previous, snapshot: progress)
            case .month(let day, let weeks):
              DisclosureGroup(isExpanded: Binding(get: { expanded == entry.id }, set: { expanded = $0 ? entry.id : nil })) {
                Text("A working-set workout in every week of \(LogPresentation.date(day).formatted(.dateTime.month(.wide))).")
                  .font(.subheadline).foregroundStyle(palette.dim)
              } label: { Label("Trained \(weeks) of \(weeks) weeks", systemImage: "calendar") }
              .accessibilityIdentifier("gym-month-moment")
            case .weight(let weight):
              NavigationLink { BodyweightScreen(gym: gym) } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Label("Weighed in · \(Readout.weight(weight.kg)) kg", systemImage: "scalemass")
                  Text(LogPresentation.dayLabel(weight.day, today: gym.log?.moment.today ?? weight.day)).font(.caption).foregroundStyle(palette.dim)
                }
              }.accessibilityIdentifier("gym-weight-moment")
            }
  }

  func sessionRow(_ session: Session, progress: StatsProgress?) -> some View {
    let readout = gym.log?.readout(session: session.id)
    let record = progress?.sessions.first { $0.sessionId == session.id }?.movements.first { fact in
      progress?.movement(fact.exerciseId).records.contains { $0.id == session.id } == true
    }
    let seconds = (readout?.durationMs ?? 0) / 60_000
    let fact = record?.estimate.map { "Record · \(gym.catalogue.find(record!.exerciseId)?.name ?? "Movement") \(Readout.effort(weightKg: $0.weightKg, reps: $0.reps))" } ?? (seconds == 0 ? "<1 min" : "\(seconds) min")
    return NavigationLink { SessionDetailScreen(gym: gym, sessionID: session.id) } label: {
      VStack(alignment: .leading, spacing: 5) {
        Text(session.name ?? Readout.noRoutine).font(.headline)
        Text(fact).font(.subheadline.monospaced()).foregroundStyle(record == nil ? palette.dim : palette.record)
        Text(LogPresentation.dayLabel(LogPresentation.day(LogPresentation.date(session.startedAt)), today: gym.log?.moment.today ?? LogPresentation.day(Date())))
          .font(.caption).foregroundStyle(palette.dim)
        if gym.logSessionIsDeviceOnly(session.id) { Label("On this device", systemImage: "iphone").font(.caption).foregroundStyle(palette.dim) }
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

  func bestMoment(_ entry: LogTimelineEntry, id: ID<Exercise>, point: MovementProgress.Point, previous: MovementProgress.Point?, snapshot: StatsProgress?) -> some View {
    let value = point.fact.estimate!.e1rm
    let name = gym.catalogue.find(id)?.name ?? "Movement"
    let change = previous.map { "up \(Readout.estimatedWeight(value - $0.fact.estimate!.e1rm)) kg since \(LogPresentation.date($0.startedAt).formatted(.dateTime.month(.wide)))" }
      ?? LogPresentation.brief(LogPresentation.date(point.startedAt))
    let progress = snapshot?.movement(id).window(now: point.startedAt, zone: gym.log!.moment.zone)
    return DisclosureGroup(isExpanded: Binding(get: { expanded == entry.id }, set: { expanded = $0 ? entry.id : nil })) {
      if let progress {
        if progress.hasChart(in: gym.log!.moment.zone), let first = progress.logPlotPoints.first {
          LogDatedChart(points: progress.logPlotPoints, from: first.date, through: LogPresentation.date(point.startedAt), gapDays: 21, bestID: progress.best?.id.description, compact: true)
        }
        Text("Last 12 weeks · \(progress.sessions.count) sessions").font(.caption.monospaced()).foregroundStyle(palette.dim)
        if let heaviest = progress.heaviest?.fact.heaviest { Text("heaviest \(Readout.effort(weightKg: heaviest.weightKg, reps: heaviest.reps))").font(.subheadline.monospaced()) }
        Text("best e1RM \(Readout.estimatedWeight(value))").font(.subheadline.monospaced()).foregroundStyle(palette.record)
      }
      NavigationLink("Open record") { MovementRecordScreen(gym: gym, exerciseID: id) }.accessibilityIdentifier("gym-open-record")
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        Label("\(name) · new best", systemImage: "circle.fill").foregroundStyle(palette.record).font(.subheadline.weight(.semibold))
        Text("\(Readout.estimatedWeight(value)) kg est · \(change)").font(.caption.monospaced()).foregroundStyle(palette.dim)
      }
    }.accessibilityIdentifier("gym-best-moment")
      .accessibilityValue(expanded == entry.id ? "Expanded" : "Collapsed")
  }

  func loadOlder() {
    loading = true
    Task { @MainActor in
      gym.refresh()
      olderFailed = gym.readFailed
      if !olderFailed { limit += 30 }
      loading = false
    }
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
