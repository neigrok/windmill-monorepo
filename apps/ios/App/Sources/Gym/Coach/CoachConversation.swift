import Foundation
import Observation
import CryptoKit

nonisolated struct CoachSaved: Codable {
  struct Request: Codable, Equatable {
    let thread: String
    let question: String
    let requestId: String
    let attachmentIds: [String]
    var stream: Bool { true }
    enum CodingKeys: String, CodingKey { case thread, question, requestId, attachmentIds, stream }
    init(thread: String, question: String, requestId: String, attachmentIds: [String]) {
      self.thread = thread; self.question = question; self.requestId = requestId; self.attachmentIds = attachmentIds
    }
    init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      thread = try c.decode(String.self, forKey: .thread); question = try c.decode(String.self, forKey: .question)
      requestId = try c.decode(String.self, forKey: .requestId); attachmentIds = try c.decode([String].self, forKey: .attachmentIds)
    }
    func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(thread, forKey: .thread); try c.encode(question, forKey: .question); try c.encode(requestId, forKey: .requestId)
      try c.encode(attachmentIds, forKey: .attachmentIds); try c.encode(true, forKey: .stream)
    }
  }
  var threadId = UUID().uuidString
  var text = ""
  var photo: CoachAttachment?
  var photoData: Data?
  var request: Request?
  var thread: CoachThread?
  var generation: CoachGeneration?
  var exchanges: [CoachGeneration] = []
}

nonisolated struct CoachHandoff: Identifiable, Equatable {
  var id = UUID()
  let question: String
  var send = false
}

struct CoachDraftStore {
  let directory: URL
  init(directory: URL = URL.applicationSupportDirectory.appending(path: "GymCoach", directoryHint: .isDirectory)) { self.directory = directory }
  func file(_ account: String) -> URL {
    let key = SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined()
    return directory.appending(path: key + ".json")
  }
  func read(_ account: String) throws -> CoachSaved {
    let url = file(account)
    if !FileManager.default.fileExists(atPath: url.path) { return CoachSaved() }
    return try JSONDecoder().decode(CoachSaved.self, from: Data(contentsOf: url))
  }
  func write(_ saved: CoachSaved, account: String) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try JSONEncoder().encode(saved).write(to: file(account), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
}

@Observable @MainActor final class CoachConversation {
  let gym: GymModel
  let rest: GymRESTClient
  let store: CoachDraftStore
  var owner: String?
  var saved = CoachSaved()
  var refusal: CoachRefusal?
  var error: String?
  var asking = false
  var uploading = false
  var stopping = false
  var reading = false
  var draftReadable = true
  @ObservationIgnored var work: Task<Void, Never>?
  @ObservationIgnored var workGeneration = 0
  @ObservationIgnored var stopWork: Task<Void, Never>?
  @ObservationIgnored var stopGeneration = 0
  @ObservationIgnored var readGeneration = 0

  init(gym: GymModel, rest: GymRESTClient? = nil, store: CoachDraftStore = CoachDraftStore()) {
    self.gym = gym; self.rest = rest ?? gym.rest; self.store = store
  }
  var available: Bool { !gym.isAnonymous && gym.account != nil && !gym.authPaused && !gym.accountTransition }
  var allowed: Bool { available && owner == gym.account }
  var canCompose: Bool {
    guard allowed, draftReadable else { return false }
    switch refusal { case .daily, .ceiling, .fresh, .absent: return false; default: return true }
  }
  var activeGeneration: CoachGeneration? { saved.generation ?? saved.thread?.generation }
  var visibleTurns: [CoachTurn] {
    guard let generation = activeGeneration else { return saved.thread?.turns ?? [] }
    return saved.thread?.turns.filter { $0.generationId != generation.id && $0.requestId != generation.requestId } ?? []
  }
  var retryable: Bool {
    guard saved.request != nil, !asking else { return false }
    if activeGeneration?.status == "stopped" || activeGeneration?.status == "completed" { return false }
    if case .retry = refusal { return true }
    return activeGeneration?.status == "failed" || (error != nil && refusal == nil)
  }

  func activate() async {
    let next = available ? gym.account : nil
    if next != owner {
      invalidateRead(); workGeneration += 1; stopGeneration += 1
      work?.cancel(); work = nil; stopWork?.cancel(); stopWork = nil; asking = false; uploading = false; stopping = false
      owner = next; saved = CoachSaved(); refusal = nil; error = nil; draftReadable = true
      guard let next else { return }
      do { saved = try store.read(next) }
      catch { draftReadable = false; self.error = "Your draft couldn’t be read. Try again."; gym.report("gym_read", error); return }
    }
    guard let owner, draftReadable else { return }
    if gym.coachUnavailable { refusal = .absent; error = CoachCopy.absent; return }
    if let request = saved.request, activeGeneration?.terminal != true, !asking {
      launch(request, owner: owner)
    }
  }

  @discardableResult func keep(_ next: CoachSaved, failure: String) -> Bool {
    guard let owner, allowed, gym.account == owner else { return false }
    do { try store.write(next, account: owner); saved = next; return true }
    catch { self.error = failure; gym.report("gym_action", error); return false }
  }
  func invalidateRead() { readGeneration += 1; reading = false }
  func edit(_ text: String) {
    guard text != saved.text else { return }
    invalidateRead()
    var next = saved; next.text = text
    if !keep(next, failure: "Your draft couldn’t be saved. Try again.") { saved.text = text }
  }
  func addPhoto(_ data: Data) throws {
    let (attachment, bytes) = try CoachPhotoPreparation.prepare(data)
    invalidateRead()
    var next = saved; next.photo = attachment; next.photoData = bytes
    _ = keep(next, failure: "Your draft couldn’t be saved. Try again.")
  }
  func removePhoto() {
    invalidateRead()
    var next = saved; next.photo = nil; next.photoData = nil; _ = keep(next, failure: "Your draft couldn’t be saved. Try again.")
  }
  @discardableResult func newChat(seed: String = "") -> Bool {
    guard !asking else { return false }
    invalidateRead()
    var next = CoachSaved(); next.text = seed
    guard keep(next, failure: "Your draft couldn’t be cleared. Try again.") else { return false }
    switch refusal { case .daily, .ceiling, .absent: break; default: refusal = nil; error = nil }
    return true
  }
  func begin(_ handoff: CoachHandoff) -> Bool {
    guard !asking else { error = "Coach is answering another message. Try again when it finishes."; return false }
    guard allowed, draftReadable, newChat(seed: handoff.question) else { return false }
    if handoff.send { send() }
    return true
  }
  func send() {
    guard canCompose, !asking, let owner, CoachCopy.sendable(saved.text, photo: saved.photo != nil) else { return }
    invalidateRead()
    let question = saved.text.trimmingCharacters(in: .whitespacesAndNewlines)
    let attachmentIds = saved.photo.map { [$0.id] } ?? []
    if retryable, let request = saved.request, request.thread == saved.threadId,
       request.question == question, request.attachmentIds == attachmentIds {
      launch(request, owner: owner); return
    }
    var next = saved
    if let generation = activeGeneration, generation.terminal,
       !(next.thread?.turns.contains { $0.generationId == generation.id } ?? false),
       !next.exchanges.contains(where: { $0.id == generation.id }) { next.exchanges.append(generation) }
    let request = CoachSaved.Request(thread: next.threadId, question: question,
                                    requestId: UUID().uuidString, attachmentIds: attachmentIds)
    next.request = request; next.generation = nil; next.thread?.generation = nil
    guard keep(next, failure: "Your message couldn’t be saved. Try again.") else { return }
    launch(request, owner: owner)
  }
  func reloadDraft() {
    guard let owner, allowed else { return }
    do { saved = try store.read(owner); invalidateRead(); draftReadable = true; error = nil; Task { await activate() } }
    catch { self.error = "Your draft couldn’t be read. Try again."; gym.report("gym_read", error) }
  }
  func retry() {
    guard allowed, !asking, let owner, let request = saved.request else { return }
    launch(request, owner: owner)
  }
  func launch(_ request: CoachSaved.Request, owner: String) {
    invalidateRead()
    stopGeneration += 1; stopWork?.cancel(); stopWork = nil; stopping = false
    workGeneration += 1; let generation = workGeneration
    asking = true; uploading = false; refusal = nil; error = nil
    let started = ProcessInfo.processInfo.systemUptime
    gym.telemetry.event("gym_ask_started", properties: ["screen": "coach"])
    work = Task { [weak self] in
      guard let self else { return }
      defer { if self.owner == owner, self.saved.threadId == request.thread, self.workGeneration == generation { self.asking = false; self.uploading = false; self.work = nil } }
      do {
        if !request.attachmentIds.isEmpty, activeGeneration == nil {
          guard let photo = saved.photo, let bytes = saved.photoData else {
            throw AppFailure(message: "That photo is unavailable. Remove it and choose it again.")
          }
          uploading = true
          let uploaded = try await rest.coachRequest("/v1/gym/threads/\(CoachCopy.escaped(request.thread))/attachments/\(CoachCopy.escaped(photo.id))", method: "PUT", body: bytes, mediaType: photo.mediaType, expectedAccount: owner)
          struct Upload: Decodable { let attachment: CoachAttachment }
          let metadata = try JSONDecoder().decode(Upload.self, from: uploaded).attachment
          guard metadata == photo else { throw URLError(.badServerResponse) }
          uploading = false
        }
        let body = try JSONEncoder().encode(request)
        var backoff = 1
        while true {
          let data = try await rest.coachRequest("/v1/gym/ask", method: "POST", body: body, expectedAccount: owner) { [weak self] snapshot in
            guard let self, self.owner == owner, self.allowed, self.saved.threadId == request.thread, self.workGeneration == generation else { throw CancellationError() }
            try self.accept(snapshot, request: request)
          }
          guard self.owner == owner, self.allowed, self.saved.threadId == request.thread, self.workGeneration == generation else { throw CancellationError() }
          if !data.isEmpty { try accept(JSONDecoder().decode(CoachSnapshot.self, from: data), request: request) }
          if activeGeneration?.terminal == true { break }
          try await Task.sleep(for: .seconds(backoff)); backoff = min(16, backoff * 2)
        }
        guard self.owner == owner, self.saved.threadId == request.thread, self.workGeneration == generation else { return }
        gym.telemetry.event("gym_ask_outcome", properties: ["screen": "coach", "outcome": activeGeneration?.status == "completed" ? "answered" : activeGeneration?.status == "stopped" ? "cancelled" : "failed"], durationMs: Int64((ProcessInfo.processInfo.systemUptime - started) * 1000))
      } catch {
        guard self.owner == owner, self.saved.threadId == request.thread, self.workGeneration == generation else { return }
        if error is CancellationError || (error as? URLError)?.code == .cancelled {
          if uploading { self.error = "Upload cancelled. Retry to send this photo." }
          else if activeGeneration?.terminal != true { self.error = CoachCopy.interrupted }
          gym.telemetry.event("gym_ask_outcome", properties: ["screen": "coach", "outcome": "cancelled"], durationMs: Int64((ProcessInfo.processInfo.systemUptime - started) * 1000))
          return
        }
        if error is DecodingError { gym.report("gym_rest", error) }
        if GymRESTClient.needsConnection(error) {
          refusal = .retry(CoachCopy.connectionRequired); self.error = CoachCopy.connectionRequired
        } else if uploading {
          self.error = "Photo didn’t upload. Retry to send this photo."
        } else if let failure = error as? GymRESTFailure {
          let object = (try? JSONSerialization.jsonObject(with: failure.body)) as? [String: Any] ?? [:]
          if let value = object["generation"], let data = try? JSONSerialization.data(withJSONObject: value),
             let generation = try? JSONDecoder().decode(CoachGeneration.self, from: data) {
            try? accept(CoachSnapshot(thread: request.thread, generation: generation), request: request)
          }
          refusal = CoachRefusal(status: failure.status, code: object["code"] as? String, message: failure.message)
          if refusal == .absent { gym.coachUnavailable = true }
          self.error = refusal?.message
        } else if let failure = error as? AppFailure { self.error = failure.message }
        else { refusal = .retry(CoachCopy.noAnswer); self.error = CoachCopy.noAnswer }
        var properties = ["screen": "coach", "outcome": "failed"]
        switch refusal {
        case .daily: properties["outcome"] = "capped"; properties["cap"] = "daily"
        case .ceiling: properties["outcome"] = "capped"; properties["cap"] = "ceiling"
        case .fresh: properties["outcome"] = "fresh"
        case .absent: properties["outcome"] = "absent"
        case .said: properties["outcome"] = "refused"
        default: break
        }
        gym.telemetry.event("gym_ask_outcome", properties: properties, durationMs: Int64((ProcessInfo.processInfo.systemUptime - started) * 1000))
      }
    }
  }
  func accept(_ snapshot: CoachSnapshot, request: CoachSaved.Request) throws {
    guard snapshot.thread == request.thread, snapshot.generation.requestId == request.requestId else { throw URLError(.badServerResponse) }
    if let previous = activeGeneration, previous.id == snapshot.generation.id, snapshot.generation.revision <= previous.revision { return }
    var next = saved; next.generation = snapshot.generation
    if snapshot.generation.terminal { next.text = ""; next.photo = nil; next.photoData = nil }
    guard keep(next, failure: "Your message couldn’t be saved. Try again.") else { throw AppFailure(message: "Your message couldn’t be saved. Try again.") }
    error = snapshot.generation.status == "failed" ? CoachCopy.interrupted : snapshot.generation.status == "stopped" ? CoachCopy.stopped : nil
  }
  func stopResponse() {
    guard !stopping, let owner, let request = saved.request else { return }
    let wasAsking = asking, wasUploading = uploading
    workGeneration += 1; let generation = workGeneration
    work?.cancel(); work = nil; asking = false; uploading = false
    error = wasUploading ? "Upload cancelled. Retry to send this photo." : CoachCopy.interrupted
    if wasAsking { gym.telemetry.event("gym_ask_outcome", properties: ["screen": "coach", "outcome": "cancelled"]) }
    if wasUploading { return }
    stopGeneration += 1; let stop = stopGeneration
    stopping = true
    stopWork = Task { [weak self] in
      guard let self else { return }
      defer { if self.owner == owner, self.stopGeneration == stop { self.stopping = false; self.stopWork = nil } }
      do {
        let data = try await rest.coachRequest("/v1/gym/threads/\(CoachCopy.escaped(request.thread))/generations/\(CoachCopy.escaped(request.requestId))/stop", method: "POST", expectedAccount: owner)
        guard self.owner == owner, self.allowed, self.saved.threadId == request.thread,
              self.saved.request?.requestId == request.requestId, self.workGeneration == generation else { return }
        let snapshot = try JSONDecoder().decode(CoachSnapshot.self, from: data)
        try accept(snapshot, request: request)
        if snapshot.generation.terminal { asking = false }
      } catch {
        guard self.owner == owner, self.allowed, self.saved.threadId == request.thread,
              self.saved.request?.requestId == request.requestId, self.workGeneration == generation,
              !(error is CancellationError) else { return }
        self.error = GymRESTClient.needsConnection(error)
          ? "Coach is stopped on this phone. Stopping it on the server needs a connection."
          : "The stop request didn’t reach Coach. Try again."
      }
    }
  }
  @discardableResult func deletedConversation(_ id: String, account: String) -> Bool {
    do {
      let previous = owner == account ? saved : try store.read(account)
      guard previous.threadId == id else { return true }
      var next = CoachSaved(); next.text = previous.text; next.photo = previous.photo; next.photoData = previous.photoData
      try store.write(next, account: account)
      guard owner == account, saved.threadId == id else { return true }
      saved = next
      invalidateRead(); workGeneration += 1; stopGeneration += 1
      work?.cancel(); work = nil; stopWork?.cancel(); stopWork = nil
      asking = false; uploading = false; stopping = false
      switch refusal { case .daily, .ceiling, .absent: break; default: refusal = nil; error = nil }
      return true
    } catch {
      if owner == account { self.error = "Your deleted conversation couldn’t be cleared. Try again." }
      gym.report("gym_action", error); return false
    }
  }
  func open(_ id: String, earlier: Bool = false) async {
    guard allowed, !asking, let owner else { return }
    invalidateRead(); let generation = readGeneration
    reading = true; error = nil
    defer { if self.owner == owner, self.readGeneration == generation { reading = false } }
    do {
      let before = earlier ? saved.thread?.nextCursor.map { "&before=" + CoachCopy.escaped($0) } ?? "" : ""
      let data = try await rest.coachRequest("/v1/gym/threads/\(CoachCopy.escaped(id))?limit=50\(before)", expectedAccount: owner)
      guard self.owner == owner, allowed, self.readGeneration == generation else { return }
      let page = try JSONDecoder().decode(CoachThread.self, from: data)
      guard page.id == id else { throw URLError(.badServerResponse) }
      var next = earlier ? saved : CoachSaved(); next.threadId = id
      if earlier { next.thread?.prepend(page) } else { next.thread = page; next.generation = page.generation }
      if let generation = next.generation {
        next.request = CoachSaved.Request(thread: id, question: generation.question, requestId: generation.requestId,
                                          attachmentIds: generation.attachments.map(\.id))
      }
      guard keep(next, failure: "Your message couldn’t be saved. Try again.") else { return }
      if let request = next.request, next.generation?.terminal == false { launch(request, owner: owner) }
    } catch {
      guard self.owner == owner, allowed, self.readGeneration == generation, !(error is CancellationError) else { return }
      self.error = GymRESTClient.needsConnection(error) ? "Coach history needs a connection."
        : (error as? GymRESTFailure)?.message ?? "That conversation couldn’t be opened. Try again."
      if error is DecodingError || (error as? URLError)?.code == .badServerResponse { gym.report("gym_read", error) }
    }
  }
}
