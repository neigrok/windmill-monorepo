import Foundation
import Observation
import DomainKit
import JournalDomain
import SyncEngine

nonisolated struct JournalEchoAccess: Equatable {
  let account: String?
  let today: String
  let available: Bool
}

nonisolated struct JournalEchoDestination: Equatable {
  let id = UUID()
  let day: String
  var text: String? = nil
  var occurrenceHint: Int? = nil
}

extension JournalEchoMatch {
  nonisolated func range(in body: String) -> NSRange? {
    guard let range = EchoQuote.locate(body: body, text: text, occurrenceHint: occurrenceHint) else { return nil }
    return NSRange(location: range.lowerBound, length: range.count)
  }

  nonisolated var provenance: String? {
    if isSelf == false { return "something you copied down" }
    return source == "spoken" ? "from your voice note" : nil
  }
}

@Observable @MainActor final class JournalEchoes {
  let service: any JournalEchoServing
  let telemetry: any Telemetry
  let preferences: UserDefaults
  private(set) var access = JournalEchoAccess(account: nil, today: "", available: false)
  private(set) var pages: [String: JournalEchoPage] = [:]
  var openDay: String?
  private(set) var hops: [String] = []
  private(set) var destination: JournalEchoDestination?
  private(set) var pendingDays: Set<String> = []
  private(set) var firstEchoDay: String?
  private(set) var arrivalDay: String?
  @ObservationIgnored private var raw: [JournalEchoPage] = []
  @ObservationIgnored private var bodies: [String: String] = [:]
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var revision = 0
  @ObservationIgnored private var readID: UUID?
  @ObservationIgnored private var readTask: Task<JournalEchoResponse, any Error>?
  @ObservationIgnored private var signals: [UUID: Task<Void, any Error>] = [:]
  @ObservationIgnored private var presented: Set<Passage> = []
  @ObservationIgnored private var knownPassages: Set<Passage> = []
  @ObservationIgnored private var arrivalAnnounced = false
  @ObservationIgnored private var readOnce = false
  @ObservationIgnored private var firstEver = false
  private struct Passage: Hashable { let trigger: String; let day: String; let text: String }

  init(service: any JournalEchoServing, preferences: UserDefaults, telemetry: any Telemetry = NoopTelemetry()) {
    self.service = service; self.preferences = preferences; self.telemetry = telemetry
  }

  func activate(_ next: JournalEchoAccess) {
    guard access != next else { return }
    reset()
    access = next
  }

  func suspend() {
    reset()
    access = JournalEchoAccess(account: access.account, today: access.today, available: false)
  }

  func reset() {
    generation += 1; revision += 1
    readTask?.cancel(); readTask = nil; readID = nil
    for task in signals.values { task.cancel() }
    signals = [:]; pendingDays = []
    raw = []; pages = [:]; openDay = nil; hops = []; destination = nil
    firstEchoDay = nil; arrivalDay = nil; presented = []; knownPassages = []
    arrivalAnnounced = false; readOnce = false; firstEver = false
  }

  func updateBodies(_ value: [String: String]) {
    bodies = value
    validate()
  }

  func validate() {
    guard access.available, access.account != nil else { pages = [:]; return }
    var verified: [String: JournalEchoPage] = [:]
    for page in raw {
      guard let trigger = LocalDay(page.day), page.day <= access.today,
            let body = bodies[page.day], !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
      var sourceDays: Set<String> = []
      let matches = page.matches.filter { match in
        guard let source = LocalDay(match.day), source < trigger, !sourceDays.contains(match.day),
              let body = bodies[match.day], match.range(in: body) != nil else { return false }
        sourceDays.insert(match.day)
        return true
      }.sorted { $0.day > $1.day }
      if !matches.isEmpty { verified[page.day] = JournalEchoPage(day: page.day, matches: matches) }
    }
    pages = verified
    hops.removeAll { $0 != access.today && bodies[$0] == nil }
    if let openDay, pages[openDay] == nil { self.openDay = nil }
    if let arrivalDay, pages[arrivalDay] == nil { self.arrivalDay = nil }
    firstEchoDay = firstEver && !preferences.bool(forKey: "journalFirstEchoSeen") ? pages.keys.max() : nil
    if let destination, let text = destination.text,
       JournalEchoMatch(day: destination.day, text: text, occurrenceHint: destination.occurrenceHint)
        .range(in: bodies[destination.day] ?? "") == nil { self.destination = nil }
  }

  func poll() async {
    while !Task.isCancelled, access.available, access.account != nil {
      await reload()
      do { try await Task.sleep(for: .seconds(15)) } catch { return }
    }
  }

  func reload() async {
    guard access.available, access.account != nil, !bodies.isEmpty, readTask == nil, pendingDays.isEmpty else { return }
    let mine = generation, version = revision, id = UUID(), day = access.today
    let task = Task { try await service.list(through: day) }
    readTask = task; readID = id
    defer { if readID == id { readTask = nil; readID = nil } }
    do {
      let response = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
      guard !Task.isCancelled, generation == mine, revision == version else { return }
      guard response.floorWaived == true || (response.pagesWritten.map { $0 >= 20 } ?? true) else {
        raw = []; firstEver = false; validate(); return
      }
      raw = response.pages
      firstEver = response.firstEchoEver == true
      validate()
      if readOnce {
        let arrived = pages.keys.sorted(by: >).first { day in
          day != openDay && pages[day]!.matches.contains { !knownPassages.contains(Passage(trigger: day, day: $0.day, text: $0.text)) }
        }
        if arrivalDay == nil { arrivalDay = arrived; arrivalAnnounced = false }
      }
      knownPassages.formUnion(pages.values.flatMap { page in page.matches.map { Passage(trigger: page.day, day: $0.day, text: $0.text) } })
      readOnce = true
    } catch {
      guard generation == mine, revision == version, !Task.isCancelled else { return }
      if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
      // A failed read has no extra surface. Writing and its saved state belong to JournalModel.
      raw = []; firstEver = false; clearWalk(); validate()
    }
  }

  func shown(_ day: String) {
    guard let page = pages[day] else { return }
    for match in page.matches {
      if presented.insert(Passage(trigger: day, day: match.day, text: match.text)).inserted {
        telemetry.event("journal_echo_shown")
      }
    }
  }

  func open(_ day: String) {
    guard pages[day] != nil else { return }
    openDay = day; arrivalDay = nil
  }

  func claimFirstEcho() {
    guard firstEchoDay == access.today else { return }
    preferences.set(true, forKey: "journalFirstEchoSeen")
  }

  func clearWalk() { openDay = nil; hops = []; destination = nil; arrivalDay = nil }

  func settleArrival(_ day: String) { if arrivalDay == day { arrivalDay = nil } }

  func claimArrivalAnnouncement(_ day: String) -> Bool {
    guard arrivalDay == day, !arrivalAnnounced else { return false }
    arrivalAnnounced = true
    return true
  }

  func walk(from trigger: String, to match: JournalEchoMatch) {
    guard pages[trigger]?.matches.contains(match) == true,
          match.range(in: bodies[match.day] ?? "") != nil else { return }
    var trail = hops.isEmpty ? [access.today] : hops
    if let seen = trail.firstIndex(of: match.day) { trail = Array(trail.prefix(through: seen)) }
    else { trail.append(match.day) }
    hops = trail; openDay = nil; arrivalDay = nil
    destination = JournalEchoDestination(day: match.day, text: match.text, occurrenceHint: match.occurrenceHint)
    telemetry.event("journal_echo_opened")
    let id = UUID(), mine = generation, service = service
    signals[id] = Task { [weak self] in
      defer { self?.signals[id] = nil }
      // The source is already on this phone; a lost signal never costs the walk.
      do { try await service.signal(.opened, triggerDay: trigger, matchDay: match.day) }
      catch {
        if let self, self.generation == mine, Self.offline(error) {
          self.raw = []; self.openDay = nil; self.hops = []; self.arrivalDay = nil; self.validate()
        }
      }
    }
  }

  func stand(on day: String) {
    guard day == access.today || bodies[day] != nil else { return }
    if let index = hops.firstIndex(of: day), index > 0 { hops = Array(hops.prefix(through: index)) }
    else { hops = [] }
    openDay = nil; destination = JournalEchoDestination(day: day)
  }

  func answer(_ signal: JournalEchoSignal, day: String, matchDay: String? = nil) async {
    guard signal != .opened, access.available, let previous = raw.first(where: { $0.day == day }),
          let page = pages[day], !pendingDays.contains(day),
          matchDay == nil || page.matches.contains(where: { $0.day == matchDay }),
          signal != .useful || matchDay != nil else { return }
    if signal == .useful, page.matches.first(where: { $0.day == matchDay })?.useful == true { return }
    let mine = generation, id = UUID()
    revision += 1; readTask?.cancel(); readTask = nil; readID = nil
    pendingDays.insert(day)
    raw = raw.compactMap { page in
      guard page.day == day else { return page }
      if signal == .dismiss && matchDay == nil { return nil }
      let matches = page.matches.compactMap { match -> JournalEchoMatch? in
        guard match.day == matchDay else { return match }
        if signal == .dismiss { return nil }
        var useful = match; useful.useful = true; return useful
      }
      return JournalEchoPage(day: page.day, matches: matches)
    }
    validate()
    telemetry.event(signal == .dismiss ? "journal_echo_dismissed" : "journal_echo_useful")
    let task = Task { try await service.signal(signal, triggerDay: day, matchDay: matchDay) }
    signals[id] = task
    defer { if generation == mine { pendingDays.remove(day) }; signals[id] = nil }
    do {
      try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    } catch {
      guard generation == mine else { return }
      if Self.offline(error) { raw = []; clearWalk() }
      else { raw.removeAll { $0.day == day }; raw.append(previous) }
      validate()
    }
  }

  nonisolated static func offline(_ error: any Error) -> Bool {
    [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed]
      .contains((error as? URLError)?.code)
  }
}

extension JournalModel {
  var echoBodies: [String: String] {
    var bodies = Dictionary(uniqueKeysWithValues: (room?.days ?? []).map { ($0.day.text, $0.document.body) })
    if document.isWritten { bodies[editorDay.text] = document.body }
    else { bodies.removeValue(forKey: editorDay.text) }
    return bodies
  }
}
