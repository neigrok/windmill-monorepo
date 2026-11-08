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
  private(set) var sheetDay: String?
  private(set) var introducing: String?
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
    raw = []; pages = [:]; sheetDay = nil; introducing = nil; hops = []; destination = nil
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
    if let sheetDay, pages[sheetDay] == nil { self.sheetDay = nil; introducing = nil }
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
          day != sheetDay && pages[day]!.matches.contains { !knownPassages.contains(Passage(trigger: day, day: $0.day, text: $0.text)) }
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

  // A passage is shown once per foreground session, when its row draws in the sheet; the count shows none.
  func shown(_ match: JournalEchoMatch, on day: String) {
    guard pages[day] != nil, presented.insert(Passage(trigger: day, day: match.day, text: match.text)).inserted else { return }
    telemetry.event("journal_echo_shown")
  }

  // A day's count opens its sheet; the sheet keeps the `journal_echo_ink` events the inline ink it replaced recorded.
  func open(_ day: String) {
    guard pages[day] != nil else { return }
    sheetDay = day; arrivalDay = nil; hops = []
    if day == firstEchoDay { introducing = day; claimFirstEcho() }
    telemetry.event("journal_echo_ink", properties: ["action": "open"])
  }

  func toggle(_ day: String) {
    if sheetDay == day { close() } else { open(day) }
  }

  // The person closes the sheet: its Close, a swipe down, its count again, or the keyboard. The room's own closes record nothing.
  func close() {
    guard sheetDay != nil else { return }
    sheetDay = nil; introducing = nil; hops = []
    telemetry.event("journal_echo_ink", properties: ["action": "close"])
  }

  func dismissIntroduction() {
    guard introducing != nil else { return }
    introducing = nil
    telemetry.event("journal_echo_intro_dismissed")
  }

  // The person raises the sheet to every passage, by year, where the reader once stood.
  func expand() {
    guard sheetDay != nil else { return }
    telemetry.event("journal_echo_reader_opened")
  }

  func claimFirstEcho() {
    guard firstEchoDay == access.today else { return }
    preferences.set(true, forKey: "journalFirstEchoSeen"); firstEchoDay = nil
  }

  func clearWalk() { sheetDay = nil; introducing = nil; hops = []; destination = nil; arrivalDay = nil }

  func settleArrival(_ day: String) { if arrivalDay == day { arrivalDay = nil } }

  func claimArrivalAnnouncement(_ day: String) -> Bool {
    guard arrivalDay == day, !arrivalAnnounced else { return false }
    arrivalAnnounced = true
    return true
  }

  // Following a passage keeps its sheet, lowered; the trail runs from tonight through the count's day to the passage's page.
  @discardableResult func walk(from trigger: String, to match: JournalEchoMatch) -> Bool {
    guard pages[trigger]?.matches.contains(match) == true,
          match.range(in: bodies[match.day] ?? "") != nil else { return false }
    introducing = nil; arrivalDay = nil
    hops = trigger == access.today ? [trigger, match.day] : [access.today, trigger, match.day]
    destination = JournalEchoDestination(day: match.day, text: match.text, occurrenceHint: match.occurrenceHint)
    telemetry.event("journal_echo_opened")
    let id = UUID(), mine = generation, service = service
    signals[id] = Task { [weak self] in
      defer { self?.signals[id] = nil }
      // The source is already on this phone; a lost signal never costs the walk.
      do { try await service.signal(.opened, triggerDay: trigger, matchDay: match.day) }
      catch {
        if let self, self.generation == mine, Self.offline(error) {
          let kept = self.destination
          self.raw = []; self.clearWalk(); self.destination = kept; self.validate()
        }
      }
    }
    return true
  }

  // Standing on an earlier hop keeps the sheet lowered; back at tonight the walk is over and the sheet goes with it.
  func stand(on day: String) {
    guard day == access.today || bodies[day] != nil else { return }
    if let index = hops.firstIndex(of: day), index > 0 { hops = Array(hops.prefix(through: index)) }
    else { hops = []; sheetDay = nil; introducing = nil }
    destination = JournalEchoDestination(day: day)
  }

  // One verdict, one event: Useful marks every passage the sheet holds, Not useful retires the page; a failure rolls back.
  func answer(_ signal: JournalEchoSignal, day: String) async {
    let marking = (pages[day]?.matches ?? []).filter { $0.useful != true }.map(\.day)
    guard signal != .opened, access.available, let previous = raw.first(where: { $0.day == day }), pages[day] != nil,
          !pendingDays.contains(day), signal == .dismiss || !marking.isEmpty else { return }
    let mine = generation, id = UUID(), service = service
    revision += 1; readTask?.cancel(); readTask = nil; readID = nil
    pendingDays.insert(day)
    raw = raw.compactMap { page in
      guard page.day == day else { return page }
      guard signal == .useful else { return nil }
      return JournalEchoPage(day: day, matches: page.matches.map { match in
        var marked = match
        if marking.contains(match.day) { marked.useful = true }
        return marked
      })
    }
    validate()
    telemetry.event(signal == .dismiss ? "journal_echo_dismissed" : "journal_echo_useful")
    let requests: [String?] = signal == .dismiss ? [nil] : marking.map { $0 }
    let task = Task { for matchDay in requests { try await service.signal(signal, triggerDay: day, matchDay: matchDay) } }
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
