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
  static func date(_ day: LocalDay) -> Date { Calendar(identifier: .gregorian).date(from: DateComponents(year: day.year, month: day.month, day: day.day))! }
  static func instant(_ day: LocalDay, in zone: any Zone) -> Instant {
    let utc = Int64(LocalDay("1970-01-01")!.days(until: day)) * 86_400_000
    let first = Instant(ms: utc - Int64(zone.offsetSeconds(at: Instant(ms: utc))) * 1000)
    let second = Instant(ms: utc - Int64(zone.offsetSeconds(at: first)) * 1000)
    return LocalDay(second, in: zone) == day ? second : first
  }
  static func day(_ date: Date) -> LocalDay {
    LocalDay(Instant(date), offsetSeconds: TimeZone.current.secondsFromGMT(for: date))
  }
  // A new best's line under its name: the estimate, and what it beat since when, or its day when it beat no estimate.
  static func newBest(_ record: ProgressRecords.Record, dates: GymDate) -> String {
    let value = record.point.fact.estimate!.e1rm
    let change = record.previous.map {
      "up \(Readout.estimatedWeight(value - $0.fact.estimate!.e1rm)) kg since \(dates.day($0.startedAt, inSentence: true))"
    } ?? dates.day(record.point.startedAt)
    return "\(Readout.estimatedWeight(value)) kg est · \(change)"
  }
  // The weeks trained, the head's of the last four and a month moment's of its own: *Trained 3 of the last 4 weeks*.
  static func trained(_ weeks: Int, of last: Int) -> String { "Trained \(weeks) of the last \(last) weeks" }
  static func sessionFacts(_ readout: SessionReadout) -> String {
    [GymCount.of(readout.workingSetCount, "working set"), readout.durationMs.map(Readout.duration)].compactMap { $0 }.joined(separator: " · ")
  }
  // A movement's line under its name on a finished session: what the plan held for it, or that the plan did not.
  static func planLine(_ exercise: ID<Exercise>, plan: SessionPlan?) -> String? {
    guard let plan else { return nil }
    let entries = plan.entries.filter { $0.exerciseId == exercise }
    if entries.isEmpty { return "not in plan" }
    return entries.count == 1 ? "plan \(Readout.target(entries[0].sets))" : nil
  }
  // A working set against its slot in the plan; any other kind carries none, since its letter is its kind.
  static func comparison(_ set: TrainingSet, preceding: [TrainingSet], plan: SessionPlan?) -> String? {
    guard set.kind == "working", let plan else { return nil }
    let entries = plan.entries.filter { $0.exerciseId == set.exerciseId }
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
  // A session row carries the record dot when it set a new best that no woven moment states.
  enum Kind { case session(Session, recordDot: Bool), best(DomainKit.ID<Exercise>, ProgressRecords.Record), month(LocalDay, Int), weight(Bodyweight.Entry) }
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

  // The head's footer, the weeks trained of the last four, read only from a whole log.
  var logConsistency: String? {
    guard let log, !readFailed, let weeks = logRecords?.progress.consistency(now: log.moment.now, zone: log.moment.zone) else { return nil }
    return LogPresentation.trained(weeks, of: 4)
  }

  // The log's records, worked out once per change of the log rather than per row per render.
  var logRecords: ProgressRecords? {
    if logRecordsRead == nil, let log { logRecordsRead = ProgressRecords(log.progress) }
    return logRecordsRead
  }

  func logTimeline(limit: Int) -> [LogMonth] {
    guard let log, let records = logRecords else { return [] }
    let now = log.moment.now, today = log.moment.today, zone = log.moment.zone
    let progress = records.progress
    var moments: [LogTimelineEntry] = []
    if progress.isComplete && !readFailed {
      for id in records.movements.keys.sorted() {
        for record in records.movements[id] ?? [] where record.point.startedAt <= now {
          moments.append(LogTimelineEntry(id: "best:\(id):\(record.point.id)", at: record.point.startedAt, kind: .best(id, record)))
        }
      }
      let trainedDays = progress.sessions.filter { $0.startedAt <= now }.map { LocalDay($0.startedAt, in: zone) }
      let months = Dictionary(grouping: trainedDays) { String($0.text.prefix(7)) }, head = logConsistency
      for key in months.keys.sorted() {
        guard let first = LocalDay(key + "-01"), first.year < today.year || (first.year == today.year && first.month < today.month) else { continue }
        var end = first
        while end.adding(days: 1).month == first.month { end = end.adding(days: 1) }
        let firstMonday = first.adding(days: 1 - first.weekday), lastMonday = end.adding(days: 1 - end.weekday)
        var required: Set<LocalDay> = [], monday = firstMonday
        while monday <= lastMonday { required.insert(monday); monday = monday.adding(days: 7) }
        let actual = Set((months[key] ?? []).map { $0.adding(days: 1 - $0.weekday) })
        // A month the head's footer already words the same way is not woven: The log says each line once.
        if actual == required && LogPresentation.trained(required.count, of: required.count) != head {
          let at = LogPresentation.instant(end, in: zone)
          moments.append(LogTimelineEntry(id: "month:\(key)", at: at, kind: .month(first, required.count)))
        }
      }
    }
    // The newest weigh-in is the head's Bodyweight row, so a weigh-in is woven only once a newer one exists.
    for entry in (bodyweight?.entries ?? []).dropLast() where entry.day <= today {
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
    let stated = Set(chosen.compactMap { entry -> ID<Session>? in if case .best(_, let record) = entry.kind { record.point.id } else { nil } })
    let sessionRows = visible.map { session in
      LogTimelineEntry(id: "session:\(session.id)", at: session.startedAt,
                       kind: .session(session, recordDot: records.sessions.contains(session.id) && !stated.contains(session.id)))
    }
    let rows = (sessionRows + chosen)
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
}
