import Foundation
import SwiftUI
import DomainKit
import GymDomain
import SyncAPI
import SyncSchema

nonisolated enum LogPresentation {
  static func progressEfforts(_ progress: MovementProgress) -> [PerformedFact] {
    let heaviest = progress.heaviest?.fact.heaviest
    return [heaviest.flatMap { $0.weightKg == 0 ? nil : $0 }, progress.bodyweightReps?.fact.bodyweightReps].compactMap { $0 }
  }
  static func date(_ instant: Instant) -> Date { Date(timeIntervalSince1970: Double(instant.ms) / 1000) }
  static func date(_ day: LocalDay) -> Date { Calendar(identifier: .gregorian).date(from: DateComponents(year: day.year, month: day.month, day: day.day))! }
  static func instant(_ day: LocalDay, in zone: any Zone) -> Instant {
    let utc = Int64(LocalDay("1970-01-01")!.days(until: day)) * 86_400_000
    let first = Instant(ms: utc - Int64(zone.offsetSeconds(at: Instant(ms: utc))) * 1000)
    let second = Instant(ms: utc - Int64(zone.offsetSeconds(at: first)) * 1000)
    return LocalDay(second, in: zone) == day ? second : first
  }
  static func day(_ date: Date) -> LocalDay {
    LocalDay(Instant(ms: Int64(date.timeIntervalSince1970 * 1000)), offsetSeconds: TimeZone.current.secondsFromGMT(for: date))
  }
  static func brief(_ date: Date) -> String { date.formatted(.dateTime.day().month(.abbreviated)) }
  static func dayLabel(_ day: LocalDay, today: LocalDay) -> String {
    if day == today { return "Today" }
    if day == today.adding(days: -1) { return "Yesterday" }
    return date(day).formatted(.dateTime.weekday(.abbreviated).day())
  }
  static func comparison(_ set: TrainingSet, preceding: [TrainingSet], plan: SessionPlan?) -> String? {
    guard set.kind == "working" else { return set.kind }
    guard let plan else { return nil }
    let entries = plan.entries.filter { $0.exerciseId == set.exerciseId }
    if entries.isEmpty { return preceding.contains { $0.kind == "working" } ? nil : "added today" }
    guard entries.count == 1, let targets = entries[0].sets else { return nil }
    let slot = preceding.filter { $0.kind == "working" }.count
    guard targets.indices.contains(slot) else { return nil }
    let target = targets[slot]
    if let kg = target.weightKg, kg != 0 {
      let delta = WeightLadder.round(set.weightKg - kg)
      if delta > 0 { return "+\(Readout.weight(delta)) over plan" }
      if delta < 0 { return "\(Readout.weight(-delta)) under plan" }
    }
    if let reps = target.reps, set.reps < reps {
      let difference = reps - set.reps
      let words = [1: "one", 2: "two", 3: "three", 4: "four", 5: "five"]
      return "\(words[difference] ?? String(difference)) short"
    }
    return "on plan"
  }
}

struct LogTimelineEntry: Identifiable {
  enum Kind { case session(Session), best(DomainKit.ID<Exercise>, MovementProgress.Point, MovementProgress.Point?), month(LocalDay, Int), weight(Bodyweight.Entry) }
  let id: String
  let at: Instant
  let kind: Kind
  var priority: Int {
    switch kind { case .session: -1; case .best: 0; case .month: 1; case .weight: 2 }
  }
}

struct LogMonth: Identifiable {
  let id: String
  let title: String
  var entries: [LogTimelineEntry]
}

extension GymModel {
  var finishedLogSessions: [Session] { sessions.filter { !$0.isOpen && $0.startedAt <= (log?.moment.now ?? Instant(ms: 0)) } }

  func logTimeline(limit: Int) -> [LogMonth] {
    guard let log else { return [] }
    let now = log.moment.now, today = log.moment.today, zone = log.moment.zone
    let progress = log.progress
    var moments: [LogTimelineEntry] = []
    let ids = Set(progress.sessions.flatMap { $0.movements.map(\.exerciseId) }).sorted()
    if progress.isComplete && !readFailed {
      for id in ids {
        let records = progress.movement(id).records.filter { $0.startedAt <= now }
        for (index, record) in records.enumerated() {
          moments.append(LogTimelineEntry(id: "best:\(id):\(record.id)", at: record.startedAt,
            kind: .best(id, record, index == 0 ? nil : records[index - 1])))
        }
      }
      let trainedDays = progress.sessions.filter { $0.startedAt <= now }.map { LocalDay($0.startedAt, in: zone) }
      let months = Dictionary(grouping: trainedDays) { String($0.text.prefix(7)) }
      for key in months.keys.sorted() {
        guard let first = LocalDay(key + "-01"), first.year < today.year || (first.year == today.year && first.month < today.month) else { continue }
        var end = first
        while end.adding(days: 1).month == first.month { end = end.adding(days: 1) }
        let firstMonday = first.adding(days: 1 - first.weekday), lastMonday = end.adding(days: 1 - end.weekday)
        var required: Set<LocalDay> = [], monday = firstMonday
        while monday <= lastMonday { required.insert(monday); monday = monday.adding(days: 7) }
        let actual = Set((months[key] ?? []).map { $0.adding(days: 1 - $0.weekday) })
        if actual == required {
          let at = LogPresentation.instant(end, in: zone)
          moments.append(LogTimelineEntry(id: "month:\(key)", at: at, kind: .month(first, required.count)))
        }
      }
    }
    for entry in bodyweight?.entries ?? [] where entry.day <= today {
      moments.append(LogTimelineEntry(id: "weight:\(entry.day)", at: LogPresentation.instant(entry.day, in: zone), kind: .weight(entry)))
    }
    let weeks = Dictionary(grouping: moments) { entry in
      let day = LocalDay(entry.at, in: zone); return day.adding(days: 1 - day.weekday)
    }
    let visible = Array(finishedLogSessions.prefix(limit))
    let oldest = limit < finishedLogSessions.count ? visible.last.map { LocalDay($0.startedAt, in: zone) } : nil
    let chosen = weeks.values.compactMap { week in
      week.sorted { a, b in a.priority == b.priority ? (a.at == b.at ? a.id < b.id : a.at > b.at) : a.priority < b.priority }.first
    }.filter { entry in oldest.map { LocalDay(entry.at, in: zone) >= $0 } ?? true }
    let rows = (visible.map { LogTimelineEntry(id: "session:\($0.id)", at: $0.startedAt, kind: .session($0)) } + chosen)
      .sorted { a, b in a.at == b.at ? (a.priority == b.priority ? a.id < b.id : a.priority < b.priority) : a.at > b.at }
    var result: [LogMonth] = []
    for row in rows {
      let day = LocalDay(row.at, in: zone), key = String(day.text.prefix(7))
      if result.last?.id == key { result[result.count - 1].entries.append(row); continue }
      let date = LogPresentation.date(day)
      let title = day.year == today.year ? date.formatted(.dateTime.month(.wide)) : date.formatted(.dateTime.month(.wide).year())
      result.append(LogMonth(id: key, title: title, entries: [row]))
    }
    return result
  }

  func logSessionIsDeviceOnly(_ id: ID<Session>) -> Bool {
    if isAnonymous { return true }
    return (try? runner.read(Gym.scope) { try $0.confirmed(Session.self, id) == nil }) ?? false
  }

  func correctLoggedSet(_ original: TrainingSet, to value: TrainingSet, account expectedAccount: String?) -> Bool {
    refresh()
    guard account == expectedAccount, !accountTransition, !readFailed else { error = "The workout changed. Check the current set"; return false }
    guard sets.contains(where: { $0.id == original.id }) else { error = "That set is no longer here."; return false }
    guard let outcome = run(CorrectSet(value, original: original)) else { return false }
    return outcome.refusal == nil
  }
}

struct LogNoticeBand: View {
  let gym: GymModel
  var body: some View {
    if gym.error != nil || !gym.undoOffers.isEmpty || !gym.notices.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        if let error = gym.error, !gym.notices.contains(where: { gym.message($0.refusal) == error }) {
          Text(error).font(.subheadline).accessibilityIdentifier("gym-log-error")
        }
        ForEach(gym.notices) { notice in
          VStack(alignment: .leading, spacing: 4) {
            Text(gym.message(notice.refusal)).font(.subheadline)
            Button("Dismiss message", systemImage: "xmark") { gym.dismissNotice(notice.id) }
          }
        }
        ForEach(gym.undoOffers.reversed()) { offer in
          Button("Undo", systemImage: "arrow.uturn.backward") { _ = gym.undo(offer.id) }.accessibilityIdentifier("gym-log-undo")
        }
      }.padding().frame(maxWidth: .infinity, alignment: .leading).background(.regularMaterial)
    }
  }
}
