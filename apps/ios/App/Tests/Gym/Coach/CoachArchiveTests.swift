import DomainKitTesting
import Foundation
import GymDomain
import Testing
import UIKit
@testable import Windmill

extension CoachTests {
  // An archive written before conversations were engine records still reads: its draft, photo and setup marks stand, and
  // the request, thread and generation it carried are gone with the REST Coach.
  @Test func archiveMigrationKeepsLegacyConversationPhotoAndSetupWithoutEmptyRows() throws {
    let cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    var saved = CoachSaved()
    saved.threadId = "legacy"; saved.text = "An unsent question"
    saved.photo = CoachAttachment(id: "photo", mediaType: "image/png", width: 1, height: 1, bytes: 3)
    saved.photoData = Data([1, 2, 3]); saved.acceptedFirstMessage = true; saved.setupChoice = .describe
    saved.rejectedDrafts = ["declined"]
    try FileManager.default.createDirectory(at: cache.directory, withIntermediateDirectories: true)
    var legacy = try JSONSerialization.jsonObject(with: JSONEncoder().encode(saved)) as? [String: Any] ?? [:]
    legacy["request"] = ["thread": "legacy", "question": "An unsent question", "requestId": "r", "attachmentIds": []]
    legacy["thread"] = ["id": "legacy", "turns": [["position": 1, "from": "lifter", "text": "Old"]]]
    legacy["exchanges"] = []
    try JSONSerialization.data(withJSONObject: legacy).write(to: cache.file("owner"))
    let archive = try cache.archive("owner")
    #expect(archive.version == 1 && archive.selected == "legacy")
    #expect(archive.entries.map(\.id) == ["legacy"])
    let migrated = try #require(archive.entries.first?.saved)
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    #expect(try encoder.encode(migrated) == encoder.encode(saved))
    #expect(try cache.read("owner").photoData == Data([1, 2, 3]) && migrated.conversation == nil)
    #expect(try cache.file("owner").resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    try cache.write(saved.carried, account: "owner")
    #expect(try cache.archive("owner").entries.map(\.id) == ["legacy"])
    #expect(try cache.read("owner").acceptedFirstMessage == true)
  }

  // A fresh canvas keeps the conversation it leaves in the archive, with its draft, and never writes an empty row.
  @Test func freshEntriesKeepDraftsInHistoryWithoutEmptyRows() async throws {
    let (gym, _, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, store: cache)
    await coach.activate()
    #expect(coach.fresh(door: "tab")); #expect(coach.fresh(door: "tab"))
    let owner = try #require(coach.owner)
    #expect(try cache.archive(owner).entries.isEmpty)
    coach.edit("My first draft")
    let first = coach.saved.threadId
    #expect(coach.fresh(door: "tab"))
    #expect(coach.saved.text.isEmpty && coach.saved.threadId != first)
    #expect(try cache.archive(owner).entries.map { [$0.id, $0.state, $0.headline] } == [[first, "Draft", "My first draft"]])
    #expect(coach.open(first) && coach.saved.text == "My first draft")
    #expect(coach.delete(first) && coach.saved.text == "My first draft" && coach.saved.threadId != first)
    #expect(try cache.archive(owner).entries.map(\.id) == [coach.saved.threadId])
  }

  @Test func adoptionKeepsSeparateConversationsThenDeleteClearsTheWholeOwner() throws {
    let cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    var first = CoachSaved(); first.threadId = "first"; first.text = "First draft"
    first.rejectedDrafts = ["rejected"]
    first.onboarding = [CoachOnboardingRecord(request: CoachOnboardingIn(requestId: "original-request", mode: "conversation", text: "First question"))]
    var second = CoachSaved(); second.threadId = "second"; second.text = "Second draft"
    second.photo = CoachAttachment(id: "photo", mediaType: "image/png", width: 1, height: 1, bytes: 1); second.photoData = Data([9])
    try cache.write(first, account: "anonymous:phone"); try cache.write(second, account: "anonymous:phone")
    var existing = CoachSaved(); existing.threadId = "account-draft"; existing.text = "Account draft"
    try cache.write(existing, account: "account")
    try cache.adopt(from: "anonymous:phone", account: "account", discard: false)
    let archive = try cache.archive("account")
    #expect(Set(archive.entries.map(\.id)) == ["first", "second", "account-draft"])
    #expect(archive.selected == "account-draft")
    #expect(archive.conversation("first").onboarding?.first?.id == "original-request")
    #expect(archive.conversation("second").photoData == Data([9]))
    #expect(archive.conversation("account-draft").rejectedDrafts == ["rejected"])
    #expect(!FileManager.default.fileExists(atPath: cache.file("anonymous:phone").path))
    try cache.write(second, account: "anonymous:discard")
    try cache.adopt(from: "anonymous:discard", account: "other-account", discard: true)
    #expect(try cache.archive("other-account").entries.isEmpty)
    try cache.delete("account")
    #expect(!FileManager.default.fileExists(atPath: cache.file("account").path))
  }

  @Test func unreadableArchiveBlocksComposingUntilReloaded() async throws {
    let (gym, _, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let owner = try #require(gym.account)
    try FileManager.default.createDirectory(at: cache.directory, withIntermediateDirectories: true)
    try Data("corrupt".utf8).write(to: cache.file(owner))
    let coach = CoachConversation(gym: gym, store: cache); await coach.activate()
    #expect(!coach.draftReadable && !coach.canCompose && coach.error == CoachCopy.unreadableDraft)
    #expect(!coach.fresh(door: "tab") && !coach.open("anything"))
    try FileManager.default.removeItem(at: cache.file(owner)); coach.reloadDraft()
    #expect(coach.draftReadable && coach.canCompose && coach.error == nil)
  }

  // Another phone's conversation has nothing of this phone's beside it: opening it makes its entry, so the selection names
  // one, and New chat and every later read go on. Reading it gives the entry no date of its own.
  @Test func openingAnotherPhonesConversationSelectsAnEntryAndNewChatGoesOn() async throws {
    let (gym, _, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, store: cache)
    await coach.activate()
    let owner = try #require(coach.owner)
    let turn = try #require(committed(try gym.runner.run(OpenTurn(question: "Started on the other phone"))))
    let id = turn.thread.description
    #expect(try cache.archive(owner).entries.isEmpty)

    #expect(coach.open(id))
    #expect(coach.saved.threadId == id && coach.saved.conversation == id && coach.saved.text.isEmpty && coach.error == nil)
    var archive = try cache.archive(owner)
    #expect(archive.selected == id)
    #expect(archive.entries.map { [$0.id, $0.saved.conversation ?? "none", $0.saved.text, String($0.updatedAt)] } == [[id, id, "", "0"]])

    let relaunched = CoachConversation(gym: gym, store: cache)
    await relaunched.activate()
    #expect(relaunched.draftReadable && relaunched.error == nil && relaunched.saved.conversation == id)

    #expect(coach.fresh(door: "history"))
    #expect(coach.saved.threadId != id && coach.saved.conversation == nil && coach.draftReadable && coach.error == nil)
    archive = try cache.archive(owner)
    #expect(archive.selected == nil)
    #expect(archive.entries.map { [$0.id, $0.saved.conversation ?? "none", $0.saved.text, String($0.updatedAt)] } == [[id, id, "", "0"]])

    coach.edit("The next question")
    archive = try cache.archive(owner)
    #expect(archive.selected == coach.saved.threadId)
    #expect(archive.entries.map(\.id) == [coach.saved.threadId, id])
  }

  // A conversation the engine holds nothing of and this phone keeps nothing of has no entry to select.
  @Test func openingAnIdNothingHoldsSelectsNothing() async throws {
    let (gym, _, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, store: cache)
    await coach.activate()
    let owner = try #require(coach.owner)

    #expect(coach.open("nothing-holds-this"))

    let archive = try cache.archive(owner)
    #expect(archive.selected == nil && archive.entries.isEmpty)
    #expect(coach.saved.threadId == "nothing-holds-this" && coach.saved.conversation == nil)
  }

  @Test func theArchiveSelectsOnlyAnEntry() {
    var archive = CoachArchive(), saved = CoachSaved()
    saved.threadId = "kept"; saved.text = "A draft"
    archive.put(saved, select: false, at: 100)
    archive.select("no-such-entry")
    #expect(archive.selected == nil)
    archive.select("kept")
    #expect(archive.selected == "kept")
    archive.select("no-such-entry")
    #expect(archive.selected == nil)
  }

  // The file a phone holds when it selected a conversation with no entry. It reads as nothing selected, the file stays
  // byte for byte until the next write, and that write keeps all it holds.
  @Test func aSelectionNamingNoEntryReadsAsNothingSelectedAndTheFileStandsUntilTheNextWrite() async throws {
    let (gym, _, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let owner = try #require(gym.account)
    let bytes = Data(#"{"version":1,"selected":"from-the-other-phone","shared":{"threadId":"shared-id","acceptedFirstMessage":true,"adoptedSources":["anonymous:phone"],"rejectedDrafts":["declined"],"setupChoice":"describe","text":""},"entries":[{"updatedAt":200,"saved":{"threadId":"local-draft","text":"Kept draft"}},{"updatedAt":100,"saved":{"threadId":"my-thread","conversation":"my-thread","acceptedFirstMessage":true,"text":""}}]}"#.utf8)
    try FileManager.default.createDirectory(at: cache.directory, withIntermediateDirectories: true)
    try bytes.write(to: cache.file(owner))

    let archive = try cache.archive(owner)
    #expect(archive.selected == nil)
    #expect(archive.version == 1)
    #expect(archive.entries.map { [$0.id, $0.saved.conversation ?? "none", $0.saved.text, String($0.updatedAt)] } == [["local-draft", "none", "Kept draft", "200"], ["my-thread", "my-thread", "", "100"]])
    #expect(archive.shared.threadId == "shared-id" && archive.shared.acceptedFirstMessage == true && archive.shared.adoptedSources == ["anonymous:phone"])
    #expect(archive.shared.rejectedDrafts == ["declined"] && archive.shared.setupChoice == .describe)
    var read = try cache.read(owner), carried = archive.shared.carried
    read.threadId = "same"; carried.threadId = "same"
    #expect(read == carried)
    #expect(try Data(contentsOf: cache.file(owner)) == bytes)

    let coach = CoachConversation(gym: gym, store: cache)
    await coach.activate()
    #expect(coach.draftReadable && coach.canCompose && coach.error == nil && coach.saved.conversation == nil)
    #expect(try Data(contentsOf: cache.file(owner)) == bytes)

    #expect(coach.fresh(door: "history"))
    var written = try cache.archive(owner)
    #expect(written.selected == nil)
    #expect(written.entries.map { [$0.id, $0.saved.conversation ?? "none", $0.saved.text, String($0.updatedAt)] } == [["local-draft", "none", "Kept draft", "200"], ["my-thread", "my-thread", "", "100"]])
    #expect(written.shared.threadId == "shared-id" && written.shared.acceptedFirstMessage == true && written.shared.adoptedSources == ["anonymous:phone"])
    #expect(written.shared.rejectedDrafts == ["declined"] && written.shared.setupChoice == .describe)

    coach.edit("The next question")
    written = try cache.archive(owner)
    #expect(written.selected == coach.saved.threadId)
    #expect(Set(written.entries.map(\.id)) == ["local-draft", "my-thread", coach.saved.threadId])
    #expect(written.conversation("local-draft").text == "Kept draft" && written.conversation("my-thread").conversation == "my-thread")
    #expect(written.shared.threadId == "shared-id" && written.shared.setupChoice == .describe)
  }

  // Only the selection recovers: every other malformed file is refused as it was, and stays as it is.
  @Test func everyOtherMalformedArchiveIsRefusedAndLeftAlone() throws {
    let cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    try FileManager.default.createDirectory(at: cache.directory, withIntermediateDirectories: true)
    let files = [
      #"{"version":2,"selected":"gone","shared":{"threadId":"s","text":""},"entries":[]}"#,
      #"{"version":1,"shared":{"threadId":"s","text":""},"entries":[{"updatedAt":1,"saved":{"threadId":"twice","text":"a"}},{"updatedAt":2,"saved":{"threadId":"twice","text":"b"}}]}"#,
      #"{"version":1,"selected":"gone","shared":{"threadId":"s","text":""},"entries":[{"updatedAt":1,"saved":{"threadId":"twice","text":"a"}},{"updatedAt":2,"saved":{"threadId":"twice","text":"b"}}]}"#,
      #"{"version":1,"selected":"gone","shared":{"threadId":"s","text":""},"entries":[{"saved":{"threadId":"undated","text":"a"}}]}"#,
      #"{"version":1,"selected":7,"shared":{"threadId":"s","text":""},"entries":[]}"#,
      "corrupt"
    ]
    for file in files {
      let bytes = Data(file.utf8)
      try bytes.write(to: cache.file("owner"))
      #expect(throws: (any Error).self) { try cache.archive("owner") }
      #expect(try Data(contentsOf: cache.file("owner")) == bytes)
    }
  }

  @Test func keepingOrOpeningAnUnchangedConversationDoesNotMoveItsHistoryDate() throws {
    var archive = CoachArchive(), saved = CoachSaved()
    saved.threadId = "conversation"; saved.text = "Original draft"
    archive.put(saved, select: true, at: 100)
    archive.put(saved, select: false, at: 200)
    #expect(archive.entries.map(\.updatedAt) == [100])
    saved.acceptedFirstMessage = true; saved.rejectedDrafts = ["decision-from-another-chat"]
    archive.put(saved, select: true, at: 300)
    #expect(archive.entries.map(\.updatedAt) == [100])
    saved.text = "Edited draft"
    archive.put(saved, select: true, at: 400)
    #expect(archive.entries.map(\.updatedAt) == [400])
  }
}
