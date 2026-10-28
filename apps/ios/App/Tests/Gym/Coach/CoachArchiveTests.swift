import Foundation
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
