import Foundation
import Testing
import DomainKit
import DomainKitTesting
import GymDomain
import SyncSchema
import SyncModelServer
@testable import Windmill

@Suite(.serialized) @MainActor struct SessionShareLogTests {
  let share = SessionPublicLink(token: "public-token", expiresAt: 1_756_992_000_000)

  @Test func shareDecodesMillisecondsAndPrefersTheServerURL() throws {
    let data = Data(#"{"token":"public-token","url":"https://reader.example/#/gym/shared/public-token","expiresAt":1756992000000}"#.utf8)
    let decoded = try JSONDecoder().decode(SessionPublicLink.self, from: data)
    #expect(decoded == SessionPublicLink(token: "public-token", url: "https://reader.example/#/gym/shared/public-token", expiresAt: 1_756_992_000_000))
    #expect(decoded.link(base: "https://api.example") == "https://reader.example/#/gym/shared/public-token")
    #expect(try JSONDecoder().decode(SessionPublicLink.self, from: JSONEncoder().encode(decoded)) == decoded)
  }

  @Test func legacyShareFallbackOpensThePublicWorkoutPage() throws {
    let decoded = try JSONDecoder().decode(SessionPublicLink.self, from: Data(#"{"token":"public-token","expiresAt":1756992000000}"#.utf8))
    #expect(decoded == share)
    #expect(decoded.link(base: "https://windmill.works/") == "https://windmill.works/#/gym/shared/public-token")
    #expect(SessionPublicLink(token: "public-token", url: "", expiresAt: 0).link(base: "http://127.0.0.1:8080") == "http://127.0.0.1:8080/#/gym/shared/public-token")
  }

  @Test func invalidExpiryIsAReadFailure() {
    #expect(throws: DecodingError.self) {
      try JSONDecoder().decode(SessionPublicLink.self, from: Data(#"{"token":"public-token","expiresAt":"tomorrow"}"#.utf8))
    }
  }

  @Test func offerAndExpiryNameExactlyWhatIsShared() {
    #expect(SessionShareState.closed().title == "Share this workout")
    #expect(SessionShareState.closed().body() == "Anyone with the link can read this workout.\nIncludes set notes and effort.\nLinks last 30 days. End sharing anytime.")
    #expect(SessionShareState.closed().action == "Get a link")
    #expect(SessionShareState.working.action == "…")
    #expect(SessionShareState.live(share).body(expiry: "4 Sep") == "Anyone who has this link can read this one workout. It stops working on 4 Sep, and revoking it kills it immediately.")
  }

  @Test func mintCopyRevokeAndRegenerateFollowTheAnswers() async throws {
    var mints = 0, revokes = 0
    let model = SessionShareModel(mint: {
      mints += 1
      return SessionPublicLink(token: "link-\(mints)", expiresAt: 1_756_992_000_000)
    }, revoke: { revokes += 1 })
    model.copied(); #expect(model.state == .closed())
    let mint = try #require(model.getLink())
    #expect(model.state == .working)
    await mint.value
    let first = SessionPublicLink(token: "link-1", expiresAt: share.expiresAt)
    #expect(model.state == .live(first) && model.state.action == "Copy link")
    model.copied()
    #expect(model.state == .live(first, copied: true) && model.state.action == "Copied")
    let revoke = try #require(model.revokeLink())
    #expect(model.state == .working)
    await revoke.value
    #expect(model.state == .revoked && model.state.title == "The link is dead" && model.state.action == "Get a link")
    #expect(model.state.body() == "Anyone still holding it gets nothing. You can make a new one whenever you like.")
    #expect(model.revokeLink() == nil)
    await model.getLink()?.value
    #expect(model.state == .live(SessionPublicLink(token: "link-2", expiresAt: share.expiresAt)))
    #expect(mints == 2 && revokes == 1)
  }

  @Test func failedMintKeepsTheOfferAndAllowsRetry() async {
    var tries = 0
    let model = SessionShareModel(mint: {
      tries += 1
      if tries == 1 { throw GymRESTFailure(status: 404, body: Data(), message: "no such session") }
      return self.share
    }, revoke: {})
    await model.getLink()?.value
    #expect(model.state == .closed(note: "no such session"))
    #expect(model.state.action == "Try again" && model.state.title == "Share this workout")
    await model.getLink()?.value
    #expect(model.state == .live(share) && tries == 2)
  }

  @Test func offlineMintDoesNotClaimThatALinkExists() async {
    let model = SessionShareModel(mint: { throw URLError(.notConnectedToInternet) }, revoke: {})
    await model.getLink()?.value
    #expect(model.state == .closed(note: "Sharing needs a connection. The link wasn’t made."))
    #expect(model.state.action == "Try again")
  }

  @Test func failedRevokeRetainsTheSameLiveLinkAndClearsCopied() async {
    let model = SessionShareModel(mint: { self.share }, revoke: { throw URLError(.timedOut) })
    await model.getLink()?.value
    model.copied()
    await model.revokeLink()?.value
    #expect(model.state == .live(share, note: "Sharing needs a connection. The link is still live."))
    #expect(model.state.title == "The link is live" && model.state.action == "Copy link")
  }

  @Test func serverRevokeRefusalIsShownWithoutClaimingRevocation() async {
    let model = SessionShareModel(mint: { self.share }, revoke: { throw GymRESTFailure(status: 403, body: Data(), message: "sharing is unavailable") })
    await model.getLink()?.value
    await model.revokeLink()?.value
    #expect(model.state == .live(share, note: "sharing is unavailable"))
  }

  @Test func closeCancelsStalledMintAndRejectsItsLateSuccess() async throws {
    var reply: CheckedContinuation<SessionPublicLink, Never>?
    let model = SessionShareModel(mint: { await withCheckedContinuation { reply = $0 } }, revoke: {})
    let pending = try #require(model.getLink())
    for _ in 0..<100 where reply == nil { await Task.yield() }
    let continuation = try #require(reply)
    #expect(model.getLink() == nil && model.state == .working)
    model.cancel()
    #expect(model.state == .closed() && model.task == nil)
    continuation.resume(returning: share)
    await pending.value
    #expect(model.state == .closed())
  }

  @Test func accountChangeDropsTheOldLinkAndRejectsLateRevoke() async throws {
    var reply: CheckedContinuation<Void, Never>?
    let model = SessionShareModel(mint: { self.share }, revoke: { await withCheckedContinuation { reply = $0 } })
    await model.getLink()?.value
    let pending = try #require(model.revokeLink())
    for _ in 0..<100 where reply == nil { await Task.yield() }
    let continuation = try #require(reply)
    model.accountChanged()
    #expect(model.state == .closed(note: "sharing needs your account — sign in first") && model.task == nil)
    continuation.resume()
    await pending.value
    #expect(model.state == .closed(note: "sharing needs your account — sign in first"))
  }

  @Test func transportCancellationRestoresTheLiveLinkWithoutAFailureNote() async {
    let model = SessionShareModel(mint: { self.share }, revoke: { throw URLError(.cancelled) })
    await model.getLink()?.value
    model.copied()
    await model.revokeLink()?.value
    #expect(model.state == .live(share, copied: true) && model.task == nil)
  }

  @Test func anonymousAndPausedAccountsAreRefusedBeforeNetworking() async {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let gym = GymModel(runner: harness.runner), id = gym.runner.mint(Session.self)
    do { _ = try await gym.mintSessionShare(id); Issue.record("Expected account refusal") }
    catch { #expect((error as? AppFailure)?.message == "sharing needs your account — sign in first") }
    do { try await gym.revokeSessionShare(id); Issue.record("Expected account refusal") }
    catch { #expect((error as? AppFailure)?.message == "sharing needs your account — sign in first") }
    gym.isAnonymous = false; gym.account = "account"; gym.authPaused = true
    do { _ = try await gym.mintSessionShare(id); Issue.record("Expected paused-account refusal") }
    catch { #expect((error as? AppFailure)?.message == "sharing needs your account — sign in first") }
    #expect(gym.rest.tasks.isEmpty)
    gym.accountChanging = true
    do { try await gym.revokeSessionShare(id); Issue.record("Expected transition refusal") }
    catch { #expect((error as? AppFailure)?.message == "Wait for the account change to finish.") }
    #expect(gym.rest.tasks.isEmpty)
  }
}
