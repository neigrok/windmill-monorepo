import Foundation
import Observation
import CryptoKit

nonisolated struct CoachSaved: Codable {
  struct Request: Codable, Equatable {
    let thread: String
    let question: String
    let requestId: String
    let attachmentIds: [String]
    let purpose: CoachPurpose
    var stream: Bool { true }
    enum CodingKeys: String, CodingKey { case thread, question, requestId, attachmentIds, stream, purpose, routineReview }
    init(thread: String, question: String, requestId: String, attachmentIds: [String], purpose: CoachPurpose = .conversation) {
      self.thread = thread; self.question = question; self.requestId = requestId; self.attachmentIds = attachmentIds; self.purpose = purpose
    }
    init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      thread = try c.decode(String.self, forKey: .thread); question = try c.decode(String.self, forKey: .question)
      requestId = try c.decode(String.self, forKey: .requestId); attachmentIds = try c.decode([String].self, forKey: .attachmentIds)
      purpose = try c.decodeIfPresent(CoachPurpose.self, forKey: .purpose) ?? .conversation
    }
    func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(thread, forKey: .thread); try c.encode(question, forKey: .question); try c.encode(requestId, forKey: .requestId)
      try c.encode(attachmentIds, forKey: .attachmentIds); try c.encode(true, forKey: .stream); try c.encode(purpose, forKey: .purpose)
      try c.encode(true, forKey: .routineReview)
    }
  }
  struct Choices: Codable, Equatable {
    let clarificationId: String
    let base: String
    var groups: [String: [String]]
  }
  var adoptedSources: [String]?
  var rejectedDrafts: [String]?
  var phoneDrafts: [CoachPhoneDraft]?
  var onboarding: [CoachOnboardingRecord]?
  var acceptedFirstMessage: Bool?
  var purpose: CoachPurpose?
  var setupChoice: CoachSetupChoice?
  var choices: Choices?
  var allowance: AiAllowance?
  var threadId = UUID().uuidString
  var text = ""
  var photo: CoachAttachment?
  var photoData: Data?
  var request: Request?
  var editedRequestId: String?
  var thread: CoachThread?
  var generation: CoachGeneration?
  var exchanges: [CoachGeneration] = []
}

nonisolated struct CoachPhoneDraft: Codable, Equatable {
  let text: String
  let photo: CoachAttachment?
  let photoData: Data?
  var setupChoice: CoachSetupChoice?
  var choices: CoachSaved.Choices?
}

// A question handed to Coach from elsewhere in the room, for the account it was asked under.
nonisolated struct CoachHandoff: Identifiable, Equatable {
  var id = UUID()
  let account: String?
  let question: String
  var send = false
  var purpose: CoachPurpose = .conversation
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
  func adopt(from source: String, account: String, discard: Bool) throws {
    let sourceURL = file(source)
    guard FileManager.default.fileExists(atPath: sourceURL.path) else { return }
    if !discard {
      let local = try read(source)
      var target = try read(account)
      if target.adoptedSources?.contains(source) == true { try FileManager.default.removeItem(at: sourceURL); return }
      if local.acceptedFirstMessage == true { target.acceptedFirstMessage = true }
      let existing = Set((target.onboarding ?? []).map(\.id))
      target.onboarding = (target.onboarding ?? []) + (local.onboarding ?? []).filter { !existing.contains($0.id) }
      if !local.text.isEmpty || local.photo != nil {
        if target.text.isEmpty, target.photo == nil {
          target.text = local.text; target.photo = local.photo; target.photoData = local.photoData; target.purpose = .routineSetup; target.setupChoice = local.setupChoice; target.choices = local.choices
        } else {
          target.phoneDrafts = (target.phoneDrafts ?? []) + [CoachPhoneDraft(text: local.text, photo: local.photo, photoData: local.photoData, setupChoice: local.setupChoice, choices: local.choices)]
        }
      }
      target.adoptedSources = (target.adoptedSources ?? []) + [source]
      try write(target, account: account)
    }
    try FileManager.default.removeItem(at: sourceURL)
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
  // What the log held as each question was sent, by request, so what Coach wrote while answering reads against it.
  @ObservationIgnored var heldAtSend: [String: CoachHeld] = [:]

  init(gym: GymModel, rest: GymRESTClient? = nil, store: CoachDraftStore = CoachDraftStore()) {
    self.gym = gym; self.rest = rest ?? gym.rest; self.store = store
  }
  var available: Bool { seat != nil }
  var allowed: Bool { available && owner == seat }
  var canCompose: Bool {
    guard allowed, draftReadable else { return false }
    switch refusal { case .daily, .ceiling, .fresh, .absent: return false; default: return true }
  }
  // The first-run greeting stands until Coach accepts a first message; it steps aside while one is on its way.
  var showsGreeting: Bool {
    !asking && saved.acceptedFirstMessage != true && saved.thread?.turns.isEmpty != false
      && saved.exchanges.allSatisfy { $0.allowanceRefusal != nil || $0.status == "failed" }
      && !(saved.onboarding ?? []).contains { $0.response?.status == "completed" }
  }
  // The refusal the conversation's last turn draws with its reason and recovery; the composer band then repeats neither.
  var transcriptAllowance: AiAllowance? {
    guard anonymous else { return activeGeneration?.allowanceRefusal }
    guard let response = anonymousRequest?.response, response.status == "failed", AiAllowance.refusalCodes.contains(response.errorCode ?? "") else { return nil }
    return response.allowance
  }
  var hasConversation: Bool {
    !saved.text.isEmpty || saved.photo != nil || saved.request != nil || saved.thread != nil || !saved.exchanges.isEmpty || !(saved.onboarding ?? []).isEmpty
  }
  var setupNeedsAttention: Bool {
    saved.purpose == .routineSetup && (!saved.text.isEmpty || saved.photo != nil || activeGeneration?.terminal == false || activeClarification != nil)
  }
  var activeClarification: CoachClarification? {
    guard !asking, saved.text.utf8.count <= 8000 else { return nil }
    let latest: CoachClarification?
    if let generation = activeGeneration { latest = generation.clarification }
    else if let turn = saved.thread?.turns.last { latest = turn.clarification }
    else { latest = saved.exchanges.last?.clarification }
    return latest?.valid == true ? latest : nil
  }
  var activeGeneration: CoachGeneration? { saved.generation ?? saved.thread?.generation }
  var visibleTurns: [CoachTurn] {
    guard let generation = activeGeneration else { return saved.thread?.turns ?? [] }
    return saved.thread?.turns.filter { $0.generationId != generation.id && $0.requestId != generation.requestId } ?? []
  }
  var offline: Bool { CoachFixture.offline || gym.runtime?.engine.status.online == false }
  // Why a send cannot go now; a dimmed Send says it in the band when tapped.
  var blockedReason: String? {
    if offline { return CoachCopy.offline }
    switch refusal { case .daily(let message), .ceiling(let message), .fresh(let message): return message; default: break }
    return draftReadable ? nil : CoachCopy.unreadableDraft
  }
  var retryable: Bool {
    if anonymous { return anonymousRetryable }
    guard saved.request != nil, !asking, saved.allowance == nil, activeGeneration?.allowanceRefusal == nil else { return false }
    if case .allowance = refusal { return false }
    if activeGeneration?.status == "stopped" || activeGeneration?.status == "completed" { return false }
    if case .retry = refusal { return true }
    return activeGeneration?.status == "failed" || (error != nil && refusal == nil)
  }

  func activate() async {
    let next = seat
    if next != owner {
      invalidateRead(); workGeneration += 1; stopGeneration += 1
      work?.cancel(); work = nil; stopWork?.cancel(); stopWork = nil; asking = false; uploading = false; stopping = false
      owner = next; saved = CoachSaved(); refusal = nil; error = nil; draftReadable = true
      guard let next else { return }
      do { saved = try store.read(next); if anonymous { saved.purpose = .routineSetup } }
      catch { draftReadable = false; self.error = CoachCopy.unreadableDraft; gym.report("gym_read", error); return }
    }
    guard let owner, draftReadable else { return }
    if anonymous {
      guard self.owner == owner, allowed, anonymous else { return }
      if let record = anonymousRequest, !record.finished, !record.stopped, !asking { launchOnboarding(owner: owner) }
      return
    }
    if let allowance = saved.allowance ?? activeGeneration?.allowanceRefusal { refusal = .allowance(allowance); error = allowance.message }
    if gym.coachUnavailable { refusal = .absent; error = CoachCopy.absent; return }
    if let request = saved.request, saved.allowance == nil, activeGeneration?.terminal != true, !asking {
      launch(request, owner: owner)
    }
  }

  @discardableResult func keep(_ next: CoachSaved, failure: String) -> Bool {
    guard let owner, allowed else { return false }
    do { try store.write(next, account: owner); saved = next; return true }
    catch { self.error = failure; gym.report("gym_action", error); return false }
  }
  func invalidateRead() { readGeneration += 1; reading = false }
  func edit(_ text: String) {
    guard text != saved.text else { return }
    invalidateRead()
    var next = saved; next.text = text; next.editedRequestId = next.request?.requestId; if !anonymous { next.choices = nil }
    if !keep(next, failure: "Your draft couldn’t be saved. Try again.") { saved.text = text; saved.editedRequestId = next.editedRequestId }
  }
  func addPhoto(_ data: Data) throws {
    let (attachment, bytes) = try CoachPhotoPreparation.prepare(data, maxBytes: anonymous ? 1_048_576 : CoachPhotoPreparation.maxBytes)
    invalidateRead()
    var next = saved; next.photo = attachment; next.photoData = bytes; next.editedRequestId = next.request?.requestId
    if keep(next, failure: "Your draft couldn’t be saved. Try again.") { gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "photo_selected"]) }
  }
  func removePhoto() {
    invalidateRead()
    var next = saved; next.photo = nil; next.photoData = nil; next.editedRequestId = next.request?.requestId
    if keep(next, failure: "Your draft couldn’t be saved. Try again.") { gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "photo_removed"]) }
  }
  @discardableResult func newChat(seed: String = "", purpose: CoachPurpose = .conversation) -> Bool {
    guard !asking, !anonymous else { return false }
    invalidateRead()
    var next = CoachSaved(); next.acceptedFirstMessage = saved.acceptedFirstMessage; next.adoptedSources = saved.adoptedSources; next.onboarding = saved.onboarding; next.phoneDrafts = saved.phoneDrafts; next.text = seed; next.purpose = purpose; next.setupChoice = saved.setupChoice
    guard keep(next, failure: "Your draft couldn’t be cleared. Try again.") else { return false }
    switch refusal { case .daily, .ceiling, .absent: break; default: refusal = nil; error = nil }
    return true
  }
  func begin(_ handoff: CoachHandoff) -> Bool {
    guard !asking else { error = "Coach is answering another message. Try again when it finishes."; return false }
    guard allowed, draftReadable, handoff.account == owner, newChat(seed: handoff.question, purpose: handoff.purpose) else { return false }
    if handoff.send { send() }
    return true
  }
  @discardableResult func chooseSetup(_ choice: CoachSetupChoice) -> Bool {
    guard allowed, draftReadable, !asking else { return false }
    var next = saved; next.setupChoice = choice
    next.purpose = choice.starter ? .routineSetup : .conversation
    guard keep(next, failure: "Your setup choice couldn’t be saved. Try again.") else { return false }
    gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": choice.rawValue])
    return true
  }
  @discardableResult func beginSetup() -> Bool {
    guard allowed, draftReadable, !asking else { return false }
    if saved.request != nil || saved.thread != nil || !saved.exchanges.isEmpty || !(saved.onboarding ?? []).isEmpty { return false }
    var next = saved; next.purpose = .routineSetup
    return keep(next, failure: "Your setup couldn’t be saved. Try again.")
  }
  func select(_ option: CoachClarification.Group.Option, in group: CoachClarification.Group, clarification: CoachClarification) {
    guard allowed, !asking, clarification.valid, activeClarification?.id == clarification.id else { return }
    var next = saved
    var choices = next.choices?.clarificationId == clarification.id ? next.choices! : CoachSaved.Choices(clarificationId: clarification.id, base: next.text, groups: [:])
    let selected = choices.groups[group.id] ?? []
    choices.groups[group.id] = selected.contains(option.id) ? selected.filter { $0 != option.id } : group.multiple ? selected + [option.id] : [option.id]
    let sentences = clarification.groups.compactMap { group -> String? in
      let labels = group.options.filter { choices.groups[group.id]?.contains($0.id) == true }.map(\.label)
      guard !labels.isEmpty else { return nil }
      return labels.joined(separator: ", ") + "."
    }
    if !anonymous { next.text = ([choices.base] + sentences).filter { !$0.isEmpty }.joined(separator: " ") }
    next.choices = choices; next.editedRequestId = next.request?.requestId
    if keep(next, failure: "Your draft couldn’t be saved. Try again.") {
      gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "clarify"])
    }
  }
  func noteOffline() {
    if offline, !asking, error == nil { error = CoachCopy.offline }
  }
  func send() {
    if anonymous { sendOnboarding(); return }
    guard allowed, !asking, CoachCopy.sendable(saved.text, photo: saved.photo != nil) else { return }
    if let reason = blockedReason {
      error = reason
      if offline { gym.telemetry.event("gym_ask_outcome", properties: ["screen": "coach", "outcome": "offline"]) }
      return
    }
    guard canCompose, let owner else { return }
    invalidateRead()
    let question = saved.text.trimmingCharacters(in: .whitespacesAndNewlines)
    let attachmentIds = saved.photo.map { [$0.id] } ?? []
    if retryable || saved.allowance != nil, let request = saved.request, request.thread == saved.threadId,
       request.question == question, request.attachmentIds == attachmentIds {
      if saved.editedRequestId != nil {
        var next = saved; next.editedRequestId = nil
        guard keep(next, failure: "Your message couldn’t be saved. Try again.") else { return }
      }
      launch(request, owner: owner); return
    }
    var next = saved
    if let generation = activeGeneration, generation.terminal,
       !(next.thread?.turns.contains { $0.generationId == generation.id } ?? false),
       !next.exchanges.contains(where: { $0.id == generation.id }) { next.exchanges.append(generation) }
    let request = CoachSaved.Request(thread: next.threadId, question: question,
                                    requestId: UUID().uuidString, attachmentIds: attachmentIds, purpose: next.purpose ?? .conversation)
    next.request = request; next.allowance = nil; next.choices = nil; next.editedRequestId = nil; next.generation = nil; next.thread?.generation = nil
    guard keep(next, failure: "Your message couldn’t be saved. Try again.") else { return }
    launch(request, owner: owner)
  }
  func reloadDraft() {
    guard let owner, allowed else { return }
    do { saved = try store.read(owner); invalidateRead(); draftReadable = true; error = nil; Task { await activate() } }
    catch { self.error = CoachCopy.unreadableDraft; gym.report("gym_read", error) }
  }
  func retry() {
    if anonymous { resumeOnboarding(); return }
    guard allowed, !asking, saved.allowance == nil, let owner, let request = saved.request else { return }
    launch(request, owner: owner)
  }
  func launch(_ request: CoachSaved.Request, owner: String) {
    invalidateRead()
    if heldAtSend[request.requestId] == nil { heldAtSend[request.requestId] = CoachHeld(catalogue: gym.catalogue, notes: Set(gym.notes.map(\.id))) }
    stopGeneration += 1; stopWork?.cancel(); stopWork = nil; stopping = false
    workGeneration += 1; let generation = workGeneration
    asking = true; uploading = false; refusal = nil; error = nil
    let started = ProcessInfo.processInfo.systemUptime
    gym.telemetry.event("gym_ask_started", properties: ["screen": "coach"])
    work = Task { [weak self] in
      guard let self else { return }
      defer { if self.owner == owner, self.saved.threadId == request.thread, self.workGeneration == generation { self.asking = false; self.uploading = false; self.work = nil } }
      do {
        if let runtime = gym.runtime, let token = runtime.tokens.token(for: owner) { try await runtime.installation.bind(account: owner, token: token) }
        guard self.owner == owner, self.allowed, self.workGeneration == generation else { throw CancellationError() }
        if !request.attachmentIds.isEmpty, activeGeneration == nil {
          guard let photo = saved.photo, request.attachmentIds == [photo.id], let bytes = saved.photoData else {
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
        var reconnects = 0, backoff = 1
        while true {
          do {
            let data = try await rest.coachRequest("/v1/gym/ask", method: "POST", body: body, expectedAccount: owner, reportsFailure: false, activity: CoachStreamActivity { [weak self] in
              guard let self, self.owner == owner, self.allowed, self.saved.threadId == request.thread, self.workGeneration == generation else { throw CancellationError() }
              if self.error == CoachCopy.reconnecting { self.error = nil }
            }) { [weak self] snapshot in
              guard let self, self.owner == owner, self.allowed, self.saved.threadId == request.thread, self.workGeneration == generation else { throw CancellationError() }
              try self.accept(snapshot, request: request)
            }
            guard self.owner == owner, self.allowed, self.saved.threadId == request.thread, self.workGeneration == generation else { throw CancellationError() }
            if !data.isEmpty { try accept(JSONDecoder().decode(CoachSnapshot.self, from: data), request: request) }
            if activeGeneration?.terminal == true { break }
            try await Task.sleep(for: .seconds(backoff)); backoff = min(16, backoff * 2)
          } catch {
            let code = (error as? URLError)?.code
            guard [.networkConnectionLost, .timedOut].contains(code), activeGeneration != nil, reconnects < 3 else {
              if !(error is DecodingError) { rest.reportCoachFailure(error, method: "POST") }
              throw error
            }
            guard self.owner == owner, self.allowed, self.workGeneration == generation else { throw CancellationError() }
            reconnects += 1
            self.error = CoachCopy.reconnecting
            try await Task.sleep(for: .seconds(min(8, 1 << reconnects)))
          }
        }
        guard self.owner == owner, self.saved.threadId == request.thread, self.workGeneration == generation else { return }
        gym.telemetry.event("gym_ask_outcome", properties: ["screen": "coach", "outcome": activeGeneration?.allowanceRefusal != nil ? "capped" : activeGeneration?.status == "completed" ? "answered" : activeGeneration?.status == "stopped" ? "cancelled" : "failed"], durationMs: Int64((ProcessInfo.processInfo.systemUptime - started) * 1000))
      } catch {
        guard self.owner == owner, self.saved.threadId == request.thread, self.workGeneration == generation else { return }
        if error is CancellationError || (error as? URLError)?.code == .cancelled {
          if uploading { self.error = "Upload cancelled." }
          else if activeGeneration?.terminal != true { self.error = CoachCopy.interrupted }
          gym.telemetry.event("gym_ask_outcome", properties: ["screen": "coach", "outcome": "cancelled"], durationMs: Int64((ProcessInfo.processInfo.systemUptime - started) * 1000))
          return
        }
        if error is DecodingError { gym.report("gym_rest", error) }
        if GymRESTClient.needsConnection(error) {
          let message = activeGeneration == nil ? CoachCopy.offline : CoachCopy.interrupted
          refusal = .retry(message); self.error = message
        } else if uploading {
          self.error = "Photo didn’t upload."
        } else if let failure = error as? GymRESTFailure {
          let object = (try? JSONSerialization.jsonObject(with: failure.body)) as? [String: Any] ?? [:]
          if let value = object["generation"], let data = try? JSONSerialization.data(withJSONObject: value),
             let generation = try? JSONDecoder().decode(CoachGeneration.self, from: data) {
            try? accept(CoachSnapshot(thread: request.thread, generation: generation), request: request)
          }
          if let value = object["allowance"], let data = try? JSONSerialization.data(withJSONObject: value),
             let allowance = try? JSONDecoder().decode(AiAllowance.self, from: data), AiAllowance.refusalCodes.contains(allowance.code) {
            var next = saved; next.allowance = allowance
            _ = keep(next, failure: "Your message couldn’t be saved. Try again.")
            refusal = .allowance(allowance)
          } else { refusal = CoachRefusal(status: failure.status, code: object["code"] as? String, message: failure.message) }
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
        case .allowance: properties["outcome"] = "capped"; properties["cap"] = "allowance"
        default: break
        }
        gym.telemetry.event("gym_ask_outcome", properties: properties, durationMs: Int64((ProcessInfo.processInfo.systemUptime - started) * 1000))
      }
    }
  }
  func accept(_ snapshot: CoachSnapshot, request: CoachSaved.Request) throws {
    guard snapshot.thread == request.thread, snapshot.generation.requestId == request.requestId else { throw URLError(.badServerResponse) }
    if let previous = activeGeneration, previous.id == snapshot.generation.id, snapshot.generation.revision <= previous.revision { return }
    CoachFixture.applySetupResults(snapshot.generation.results, gym: gym); CoachFixture.applyBoardWrites(gym)
    var next = saved; next.generation = snapshot.generation; next.allowance = snapshot.generation.allowanceRefusal
    if snapshot.generation.allowanceRefusal == nil, snapshot.generation.status != "failed" { next.acceptedFirstMessage = true }
    // Composer edits keep their request marker through Stop and recovery, even after an edit is reverted.
    let ownsDraft = next.editedRequestId != request.requestId && next.text.trimmingCharacters(in: .whitespacesAndNewlines) == request.question
      && (next.photo.map { [$0.id] } ?? []) == request.attachmentIds
    if ["completed", "stopped"].contains(snapshot.generation.status) && snapshot.generation.allowanceRefusal == nil && ownsDraft { next.text = ""; next.photo = nil; next.photoData = nil; next.editedRequestId = nil }
    guard keep(next, failure: "Your message couldn’t be saved. Try again.") else { throw AppFailure(message: "Your message couldn’t be saved. Try again.") }
    if let allowance = snapshot.generation.allowanceRefusal { refusal = .allowance(allowance); error = allowance.message; return }
    error = snapshot.generation.status == "failed" ? CoachCopy.interrupted : snapshot.generation.status == "stopped" ? CoachCopy.stopped : nil
  }
  func stopResponse() {
    if anonymous { stopOnboarding(); return }
    guard !stopping, let owner, let request = saved.request else { return }
    let wasAsking = asking, wasUploading = uploading
    workGeneration += 1; let generation = workGeneration
    work?.cancel(); work = nil; asking = false; uploading = false
    error = wasUploading ? "Upload cancelled." : CoachCopy.interrupted
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
      var next = CoachSaved(); next.acceptedFirstMessage = previous.acceptedFirstMessage; next.setupChoice = previous.setupChoice; next.text = previous.text; next.photo = previous.photo; next.photoData = previous.photoData
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
    guard allowed, !anonymous, !asking, let owner else { return }
    invalidateRead(); let generation = readGeneration
    reading = true; error = nil
    defer { if self.owner == owner, self.readGeneration == generation { reading = false } }
    do {
      let before = earlier ? saved.thread?.nextCursor.map { "&before=" + CoachCopy.escaped($0) } ?? "" : ""
      let data = try await rest.coachRequest("/v1/gym/threads/\(CoachCopy.escaped(id))?limit=50\(before)", expectedAccount: owner)
      guard self.owner == owner, allowed, self.readGeneration == generation else { return }
      let page = try JSONDecoder().decode(CoachThread.self, from: data)
      guard page.id == id else { throw URLError(.badServerResponse) }
      var next = earlier ? saved : CoachSaved(); next.threadId = id; next.setupChoice = saved.setupChoice
      if earlier { next.thread?.prepend(page) } else { next.thread = page; next.generation = page.generation }
      if next.generation == nil { next.purpose = page.turns.last?.purpose ?? .conversation }
      if let generation = next.generation {
        next.request = CoachSaved.Request(thread: id, question: generation.question, requestId: generation.requestId,
                                          attachmentIds: generation.attachments.map(\.id), purpose: generation.purpose)
        next.purpose = generation.purpose
      }
      if !earlier {
        if let generation = next.generation { next.allowance = generation.allowanceRefusal }
        else { next.allowance = next.thread?.turns.last?.allowanceRefusal }
      }
      guard keep(next, failure: "Your message couldn’t be saved. Try again.") else { return }
      if let allowance = next.allowance { refusal = .allowance(allowance); error = allowance.message }
      else if case .allowance = refusal { refusal = nil; error = nil }
      if let request = next.request, next.allowance == nil, next.generation?.terminal == false { launch(request, owner: owner) }
    } catch {
      guard self.owner == owner, allowed, self.readGeneration == generation, !(error is CancellationError) else { return }
      self.error = GymRESTClient.needsConnection(error) ? "Coach history needs a connection."
        : (error as? GymRESTFailure)?.message ?? "That conversation couldn’t be opened. Try again."
      if error is DecodingError || (error as? URLError)?.code == .badServerResponse { gym.report("gym_read", error) }
    }
  }
}
