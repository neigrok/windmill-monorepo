import Foundation
import Testing
import UIKit
@testable import Windmill

extension CoachTests {
  @Test func archiveMigrationKeepsLegacyConversationPhotoAndSetupWithoutEmptyRows() throws {
    let cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    var saved = CoachSaved()
    saved.threadId = "legacy"; saved.text = "An unsent question"
    saved.photo = CoachAttachment(id: "photo", mediaType: "image/png", width: 1, height: 1, bytes: 3)
    saved.photoData = Data([1, 2, 3]); saved.acceptedFirstMessage = true; saved.setupChoice = .describe
    saved.rejectedDrafts = ["declined"]
    try FileManager.default.createDirectory(at: cache.directory, withIntermediateDirectories: true)
    try JSONEncoder().encode(saved).write(to: cache.file("owner"))
    let archive = try cache.archive("owner")
    #expect(archive.version == 1 && archive.selected == "legacy" && archive.pending == nil)
    #expect(archive.entries.map(\.id) == ["legacy"])
    let migrated = try #require(archive.entries.first?.saved)
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    #expect(try encoder.encode(migrated) == encoder.encode(saved))
    #expect(try cache.read("owner").photoData == Data([1, 2, 3]))
    #expect(try cache.file("owner").resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    try cache.write(saved.carried, account: "owner")
    #expect(try cache.archive("owner").entries.map(\.id) == ["legacy"])
    #expect(try cache.read("owner").acceptedFirstMessage == true)
  }

  @Test func freshEntriesKeepDraftsInHistoryWithoutCreatingRequestsOrEmptyRows() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let workspace = CoachWorkspace(coach: CoachConversation(gym: gym, rest: rest, store: cache))
    await workspace.activate()
    #expect(workspace.fresh(door: "tab")); #expect(workspace.fresh(door: "tab"))
    let owner = try #require(workspace.current.owner)
    #expect(try cache.archive(owner).entries.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: cache.file(owner).path))
    let first = workspace.current
    first.edit("My first draft")
    var saved = first.saved
    saved.photo = CoachAttachment(id: "photo", mediaType: "image/png", width: 1, height: 1, bytes: 2)
    saved.photoData = Data([4, 5]); #expect(first.keep(saved, failure: "x"))
    #expect(workspace.fresh(door: "tab"))
    let second = workspace.current
    #expect(second !== first && second.saved.text == "" && second.saved.photo == nil)
    second.edit("My second draft")
    await workspace.activate()
    #expect(workspace.current === second && workspace.current.saved.text == "My second draft")
    #expect(workspace.openLocal(first.saved.threadId))
    #expect(workspace.current.saved.text == "My first draft" && workspace.current.saved.photoData == Data([4, 5]))
    #expect(try cache.archive(owner).entries.count == 2)
    #expect(CoachTestProtocol.state.withLock { $0.requests.isEmpty })
  }

  @Test func freshCanvasCannotStealAnActiveAnswersDraftOrStartASecondRequest() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let workspace = CoachWorkspace(coach: CoachConversation(gym: gym, rest: rest, store: cache))
    await workspace.activate()
    let original = workspace.current
    defer { original.work?.cancel() }
    original.edit("Original question"); original.send()
    try await settle { CoachTestProtocol.state.withLock { $0.activeByPath["/v1/gym/ask"] != nil } }
    let request = try #require(original.saved.request)
    let call = try #require(CoachTestProtocol.state.withLock { $0.activeByPath["/v1/gym/ask"] })
    #expect(workspace.fresh(door: "tab"))
    let fresh = workspace.current
    fresh.edit("Next question"); fresh.send()
    #expect(workspace.answeringElsewhere && !fresh.mayRequest)
    #expect(CoachTestProtocol.state.withLock { $0.requests.count } == 1)
    #expect(workspace.viewAnswer() && workspace.current === original)
    #expect(workspace.openLocal(fresh.saved.threadId))
    let selected = workspace.current
    let reply: [String: Any] = ["thread": request.thread, "generation": ["id": "answer", "requestId": request.requestId,
      "question": request.question, "status": "completed", "revision": 1, "answer": "Original answer"]]
    call.respond(200, String(decoding: try JSONSerialization.data(withJSONObject: reply), as: UTF8.self))
    await original.work?.value
    #expect(workspace.pending == nil && selected.mayRequest)
    #expect(workspace.current === selected && selected.saved.text == "Next question" && selected.saved.generation == nil)
    let owner = try #require(fresh.owner), archive = try cache.archive(owner)
    #expect(archive.selected == fresh.saved.threadId && archive.pending == nil)
    #expect(archive.entries.first { $0.id == original.saved.threadId }?.saved.generation?.answer == "Original answer")
    #expect(archive.entries.first { $0.id == fresh.saved.threadId }?.saved.text == "Next question")
  }

  @Test func relaunchResumesOnlyThePendingConversationWhileAnotherDraftRemainsSelected() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let owner = try #require(gym.account)
    var pending = CoachSaved(); pending.threadId = "pending-thread"; pending.text = "Pending question"
    pending.request = .init(thread: pending.threadId, question: pending.text, requestId: "same-request", attachmentIds: [])
    try cache.write(pending, account: owner)
    var draft = pending.carried; draft.text = "A separate draft"
    try cache.write(draft, account: owner)
    let workspace = CoachWorkspace(coach: CoachConversation(gym: gym, rest: rest, store: cache))
    await workspace.activate()
    defer { workspace.suspend() }
    try await settle { CoachTestProtocol.state.withLock { $0.requests.count == 1 } }
    await workspace.activate()
    #expect(workspace.current.saved.threadId == draft.threadId && workspace.current.saved.text == "A separate draft")
    #expect(workspace.answeringElsewhere && workspace.pending?.saved.request == pending.request)
    let requests = CoachTestProtocol.state.withLock { $0.requests }
    #expect(requests.count == 1)
    #expect(try JSONDecoder().decode(CoachSaved.Request.self, from: #require(requests.first?.body)) == pending.request)
  }

  @Test func ownerTransitionHidesEveryConversationAndCancelsThePreviousRequest() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let workspace = CoachWorkspace(coach: CoachConversation(gym: gym, rest: rest, store: cache))
    await workspace.activate()
    let previous = workspace.current, account = try #require(gym.account)
    previous.edit("Private question"); previous.send()
    try await settle { CoachTestProtocol.state.withLock { $0.requests.count == 1 } }
    #expect(workspace.fresh()); workspace.current.edit("Private draft")
    gym.accountChanging = true
    await workspace.activate()
    #expect(!workspace.current.allowed && workspace.current.saved.text == "" && workspace.current.saved.request == nil)
    #expect(workspace.entries.isEmpty && workspace.pending == nil && previous.owner == nil)
    #expect(try cache.archive(account).entries.count == 2)
    gym.account = "another-owner"; gym.accountChanging = false
    await workspace.activate()
    workspace.current.edit("Other account draft")
    #expect(workspace.current.owner == "another-owner" && workspace.current.saved.text == "Other account draft")
    #expect(try cache.archive(account).entries.allSatisfy { $0.saved.text != "Other account draft" })
  }

  @Test func unreadableArchiveBlocksNavigationAndCannotOverwriteTheKeptDraft() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let workspace = CoachWorkspace(coach: CoachConversation(gym: gym, rest: rest, store: cache))
    await workspace.activate(); workspace.current.edit("Kept in memory")
    let before = workspace.current, owner = try #require(before.owner)
    let invalid = Data("unreadable".utf8)
    try invalid.write(to: cache.file(owner))
    #expect(!workspace.fresh() && workspace.current === before)
    #expect(workspace.current.saved.text == "Kept in memory")
    #expect(try Data(contentsOf: cache.file(owner)) == invalid)
    #expect(CoachTestProtocol.state.withLock { $0.requests.isEmpty })
  }

  @Test func adoptionKeepsSeparateConversationsAndInterruptedIdentityThenDeleteClearsTheWholeOwner() throws {
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
    #expect(archive.selected == "account-draft" && archive.pending == nil)
    #expect(archive.conversation("first").onboarding?.first?.id == "original-request")
    #expect(archive.conversation("first").onboarding?.first?.stopped == true)
    #expect(archive.conversation("second").photoData == Data([9]))
    #expect(archive.conversation("account-draft").rejectedDrafts == ["rejected"])
    #expect(!FileManager.default.fileExists(atPath: cache.file("anonymous:phone").path))
    try cache.write(second, account: "anonymous:discard")
    try cache.adopt(from: "anonymous:discard", account: "other-account", discard: true)
    #expect(try cache.archive("other-account").entries.isEmpty)
    try cache.delete("account")
    #expect(!FileManager.default.fileExists(atPath: cache.file("account").path))
  }
  @Test func historyCannotRenderAnotherOwnersServerRowsDuringActivation() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let workspace = CoachWorkspace(coach: CoachConversation(gym: gym, rest: rest, store: cache))
    await workspace.activate()
    let history = CoachHistory(gym: gym, rest: rest)
    history.resetOwner()
    history.rows = [try JSONDecoder().decode(CoachThread.self, from: Data(#"{"id":"private-thread","title":"Private title","askedAt":1}"#.utf8))]
    let screen = CoachHistoryScreen(gym: gym, workspace: workspace, history: history)
    #expect(screen.rows.map(\.id) == ["private-thread"])
    gym.account = "new-owner"
    await workspace.activate()
    #expect(workspace.current.allowed && screen.rows.isEmpty)
    #expect(history.rows.map(\.id) == ["private-thread"], "Owner filtering protects even before the history task resets")
    workspace.current.edit("New owner draft")
    workspace.refreshHistory()
    #expect(screen.rows.map(\.id) == [workspace.current.saved.threadId])
  }

  @Test func emptyFreshSelectionSurvivesRelaunchAndHistoryDoesNotResumeAnInterruptedAnswer() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let workspace = CoachWorkspace(coach: CoachConversation(gym: gym, rest: rest, store: cache))
    await workspace.activate()
    let owner = try #require(workspace.current.owner)
    workspace.current.edit("Prior draft")
    let id = workspace.current.saved.threadId
    #expect(workspace.fresh(door: "tab"))
    #expect(try cache.archive(owner).selected == nil)
    let relaunched = CoachWorkspace(coach: CoachConversation(gym: gym, rest: rest, store: cache))
    await relaunched.activate(resume: false)
    #expect(relaunched.current.saved.text == "" && relaunched.current.saved.threadId != id)
    #expect(relaunched.openLocal(id))
    var interrupted = relaunched.current.saved
    interrupted.request = .init(thread: id, question: "Prior draft", requestId: "interrupted", attachmentIds: [])
    #expect(relaunched.current.keep(interrupted, failure: "x"))
    #expect(relaunched.fresh())
    #expect(relaunched.viewAnswer())
    await relaunched.activate(resume: false)
    #expect(relaunched.current.saved.request?.requestId == "interrupted" && !relaunched.current.asking)
    #expect(CoachTestProtocol.state.withLock { $0.requests.isEmpty })
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

  @Test func historyRefreshReadsNewRemoteTurnsAndRetainsLocalDraftWithoutDispatching() async throws {
    let (gym, rest, _) = try await authed(.http(200, #"{"id":"remote-thread","title":"Original question","turns":[{"position":1,"from":"coach","text":"New answer from another surface"}]}"#)), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let workspace = CoachWorkspace(coach: CoachConversation(gym: gym, rest: rest, store: cache))
    await workspace.activate()
    var cached = workspace.current.saved; cached.threadId = "remote-thread"; cached.text = "Unsent draft on this phone"
    cached.thread = try JSONDecoder().decode(CoachThread.self, from: Data(#"{"id":"remote-thread","title":"Original question","turns":[{"position":1,"from":"coach","text":"Old cached answer"}]}"#.utf8))
    #expect(workspace.current.keep(cached, failure: "x"))
    #expect(workspace.fresh())
    #expect(await workspace.openRemote("remote-thread"))
    #expect(workspace.current.saved.thread?.turns.map(\.text) == ["New answer from another surface"])
    #expect(workspace.current.saved.text == "Unsent draft on this phone" && !workspace.current.asking)
    #expect(CoachTestProtocol.state.withLock { $0.requests.map(\.method) } == ["GET"])
    #expect(try cache.read(#require(gym.account)).text == "Unsent draft on this phone")
    CoachTestProtocol.state.withLock { $0.reply = .failure(.notConnectedToInternet) }
    #expect(workspace.fresh())
    #expect(await workspace.openRemote("remote-thread"))
    #expect(workspace.current.saved.thread?.turns.map(\.text) == ["New answer from another surface"])
    #expect(workspace.current.saved.text == "Unsent draft on this phone" && workspace.current.error == "Coach history needs a connection.")
    #expect(CoachTestProtocol.state.withLock { $0.requests.map(\.method) } == ["GET", "GET"])
  }

}
