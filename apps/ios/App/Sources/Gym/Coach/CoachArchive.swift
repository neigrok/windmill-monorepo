import Foundation
import CryptoKit

// What this phone keeps of a conversation beside the engine's records: the composer's draft, the drafts a signed-out start
// left, the signed-out onboarding answers of earlier versions, and the owner-wide setup marks. The conversation's messages
// are engine records (Coach §9.1), found by `conversation`, the engine thread the room is on.
nonisolated struct CoachSaved: Codable, Equatable {
  var adoptedSources: [String]?
  var rejectedDrafts: [String]?
  var phoneDrafts: [CoachPhoneDraft]?
  var onboarding: [CoachOnboardingRecord]?
  var acceptedFirstMessage: Bool?
  var setupChoice: CoachSetupChoice?
  // The archive's key: the engine thread once a turn opened one, a local id before.
  var threadId = UUID().uuidString
  var conversation: String?
  var text = ""
  var photo: CoachAttachment?
  var photoData: Data?
  // Owner-wide setup and decision marks; each conversation keeps its own draft and onboarding answers.
  var carried: CoachSaved {
    var next = CoachSaved()
    next.acceptedFirstMessage = acceptedFirstMessage; next.adoptedSources = adoptedSources
    next.rejectedDrafts = rejectedDrafts; next.setupChoice = setupChoice
    return next
  }
  var hasContent: Bool { !text.isEmpty || photo != nil || conversation != nil || !(onboarding ?? []).isEmpty || !(phoneDrafts ?? []).isEmpty }
}

nonisolated struct CoachPhoneDraft: Codable, Equatable {
  let text: String
  let photo: CoachAttachment?
  let photoData: Data?
  var setupChoice: CoachSetupChoice?
}

// A question handed to Coach from elsewhere in the room, for the account it was asked under.
nonisolated struct CoachHandoff: Identifiable, Equatable {
  var id = UUID()
  let account: String?
  let question: String
  var send = false
}

nonisolated struct CoachArchive: Codable {
  struct Entry: Codable, Identifiable {
    var saved: CoachSaved
    var updatedAt: Int64
    var id: String { saved.threadId }
    var headline: String {
      let text = saved.onboarding?.first?.request.question ?? saved.text
      return text.isEmpty ? "Photo conversation" : String(text.prefix(160))
    }
    // What the row says of a conversation held on this phone alone: a draft, or what its signed-out answers created.
    var state: String {
      if let record = saved.onboarding?.last, !record.finished { return "Interrupted" }
      if !saved.text.isEmpty || saved.photo != nil { return "Draft" }
      let routines = (saved.onboarding ?? []).flatMap(\.results).filter { $0.kind == "routine-created" }.count
      return routines > 0 ? "Created \(routines) \(routines == 1 ? "routine" : "routines")" : "Conversation"
    }
  }
  var version = 1
  var selected: String?
  var shared = CoachSaved()
  var entries: [Entry] = []

  mutating func put(_ saved: CoachSaved, select: Bool, at: Int64) {
    shared.acceptedFirstMessage = shared.acceptedFirstMessage == true || saved.acceptedFirstMessage == true
    shared.adoptedSources = Array(Set((shared.adoptedSources ?? []) + (saved.adoptedSources ?? []))).sorted()
    shared.rejectedDrafts = Array(Set((shared.rejectedDrafts ?? []) + (saved.rejectedDrafts ?? []))).sorted()
    shared.setupChoice = saved.setupChoice ?? shared.setupChoice
    let previous = entries.first { $0.id == saved.threadId }
    var previousContent = previous?.saved
    previousContent?.acceptedFirstMessage = saved.acceptedFirstMessage
    previousContent?.adoptedSources = saved.adoptedSources
    previousContent?.rejectedDrafts = saved.rejectedDrafts
    let unchanged = previousContent == saved
    entries.removeAll { $0.id == saved.threadId }
    if saved.hasContent { entries.append(Entry(saved: saved, updatedAt: unchanged ? previous?.updatedAt ?? at : at)) }
    if select { selected = saved.hasContent ? saved.threadId : nil }
    entries.sort { $0.updatedAt == $1.updatedAt ? $0.id > $1.id : $0.updatedAt > $1.updatedAt }
  }
  func conversation(_ id: String? = nil) -> CoachSaved {
    guard var saved = entries.first(where: { $0.id == (id ?? selected) })?.saved else { return shared.carried }
    saved.acceptedFirstMessage = saved.acceptedFirstMessage == true || shared.acceptedFirstMessage == true
    saved.adoptedSources = shared.adoptedSources
    saved.rejectedDrafts = Array(Set((saved.rejectedDrafts ?? []) + (shared.rejectedDrafts ?? []))).sorted()
    return saved
  }
}

struct CoachDraftStore {
  let directory: URL
  init(directory: URL = URL.applicationSupportDirectory.appending(path: "GymCoach", directoryHint: .isDirectory)) { self.directory = directory }
  func file(_ account: String) -> URL {
    let key = SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined()
    return directory.appending(path: key + ".json")
  }
  func archive(_ account: String) throws -> CoachArchive {
    let url = file(account)
    guard FileManager.default.fileExists(atPath: url.path) else { return CoachArchive() }
    let data = try Data(contentsOf: url)
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    if object?["version"] != nil {
      let archive = try JSONDecoder().decode(CoachArchive.self, from: data)
      let ids = Set(archive.entries.map(\.id))
      guard archive.version == 1, ids.count == archive.entries.count, archive.selected.map(ids.contains) ?? true else { throw CocoaError(.fileReadCorruptFile) }
      return archive
    }
    let saved = try JSONDecoder().decode(CoachSaved.self, from: data)
    var archive = CoachArchive()
    archive.put(saved, select: true, at: 0)
    try writeArchive(archive, account: account)
    return archive
  }
  func read(_ account: String) throws -> CoachSaved { try archive(account).conversation() }
  func write(_ saved: CoachSaved, account: String, select: Bool = true) throws {
    var archive = try archive(account)
    archive.put(saved, select: select, at: Int64(Date().timeIntervalSince1970 * 1000))
    try writeArchive(archive, account: account)
  }
  func select(_ id: String?, account: String) throws {
    var archive = try archive(account)
    archive.selected = id
    try writeArchive(archive, account: account)
  }
  func remove(_ id: String, account: String, replacement: CoachSaved? = nil) throws {
    var archive = try archive(account)
    archive.entries.removeAll { $0.id == id }
    if archive.selected == id { archive.selected = nil }
    if let replacement { archive.put(replacement, select: true, at: Int64(Date().timeIntervalSince1970 * 1000)) }
    try writeArchive(archive, account: account)
  }
  func adopt(from source: String, account: String, discard: Bool) throws {
    let sourceURL = file(source)
    guard FileManager.default.fileExists(atPath: sourceURL.path) else { return }
    if !discard {
      let local = try archive(source)
      var target = try archive(account)
      if target.shared.adoptedSources?.contains(source) != true {
        let existing = Set(target.entries.map(\.id))
        target.entries += local.entries.filter { !existing.contains($0.id) }
        target.shared.acceptedFirstMessage = target.shared.acceptedFirstMessage == true || local.shared.acceptedFirstMessage == true
        target.shared.rejectedDrafts = Array(Set((target.shared.rejectedDrafts ?? []) + (local.shared.rejectedDrafts ?? []))).sorted()
        target.shared.adoptedSources = Array(Set((target.shared.adoptedSources ?? []) + [source])).sorted()
        target.shared.setupChoice = target.shared.setupChoice ?? local.shared.setupChoice
        if target.selected == nil { target.selected = local.selected }
        target.entries.sort { $0.updatedAt == $1.updatedAt ? $0.id > $1.id : $0.updatedAt > $1.updatedAt }
        try writeArchive(target, account: account)
      }
    }
    try FileManager.default.removeItem(at: sourceURL)
  }
  func delete(_ account: String) throws {
    let url = file(account)
    if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
  }
  func writeArchive(_ archive: CoachArchive, account: String) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var folder = directory, written = file(account), excluded = URLResourceValues()
    excluded.isExcludedFromBackup = true
    try folder.setResourceValues(excluded)
    try JSONEncoder().encode(archive).write(to: written, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    try written.setResourceValues(excluded)
  }
}
