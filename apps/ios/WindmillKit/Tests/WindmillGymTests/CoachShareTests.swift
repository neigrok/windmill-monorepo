import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// A link that leaves your phone is a thing you are owed the truth about, so what is pinned here is
// the COPY in every state the card can be in and the one transition that can lie: a revoke that did
// not happen. Three sentences have to survive every rewrite of this screen — anyone who has the link
// can read this one workout, it expires, it can be revoked.

final class CoachShareTests: XCTestCase {
    private let base = URL(string: "https://windmill.works")!
    private let share = SessionShare(token: "abc123", expiresAtMs: 1_756_992_000_000)

    // A share becomes a PAGE a coach opens, not a call into the JSON API — and those are two routes
    // on one host, which is how the wrong one shipped. A base URL with a trailing slash is the same
    // address; a debug build reading `WMApiBaseURL` can carry one.
    func testTheLinkIsTheReaderPageAndNotTheApiRoute() {
        XCTAssertEqual(Coach.link(SessionShare(token: "abc123", expiresAtMs: 0), base: base),
                       "https://windmill.works/#/gym/shared/abc123")
        XCTAssertEqual(Coach.link(SessionShare(token: "abc123", expiresAtMs: 0), base: URL(string: "http://127.0.0.1:8080/")!),
                       "http://127.0.0.1:8080/#/gym/shared/abc123")
    }

    // Before anything is minted the offer names no expiry DATE, because there is no share yet and
    // therefore no day to name — but it does say that one expires, which is the promise being made.
    func testTheClosedCardOffersTheLinkAndNamesTheThreeThingsThatAreTrueOfIt() {
        let card = Coach.card(.closed(), base: base)

        XCTAssertEqual(card.title, "Share with a coach")
        XCTAssertEqual(card.body, Coach.offer)
        XCTAssertNil(card.link)
        XCTAssertEqual(card.action, "Get a link")
        XCTAssertNil(card.revoke)
        XCTAssertNil(card.note)
        XCTAssertTrue(Coach.offer.contains("Anyone who has the link can read it"))
        XCTAssertTrue(Coach.offer.contains("It expires"))
        XCTAssertTrue(Coach.offer.contains("revoke it whenever you like"))
        XCTAssertTrue(Coach.offer.contains("nothing else about your account"))
    }

    // A mint that failed says why, in the log's own words, and offers the door again — a card that
    // fell silent would leave a lifter unsure whether a link is out there.
    func testAMintThatFailedKeepsTheOfferAndRepeatsWhatTheLogSaid() {
        let card = Coach.card(.closed(note: "no such session"), base: base)

        XCTAssertEqual(card.title, "Share with a coach")
        XCTAssertEqual(card.body, Coach.offer)
        XCTAssertEqual(card.action, "Try again")
        XCTAssertEqual(card.note, "no such session")
        XCTAssertNil(card.link)
    }

    // The link is the SERVER's. This shipped composing `/#/gym/shared/…` from the API base, so a
    // coach tapping a share sent from a phone was handed a page of JSON — the one thing a share is
    // for, broken. The fallback exists for a backend older than the field and is the READER's route,
    // never the API's, so the worst case is a wrong host rather than the wrong kind of page.
    func testTheLinkIsTheOneTheServerSentAndTheFallbackIsNeverTheJsonRoute() {
        let sent = SessionShare(token: "abc123", expiresAtMs: 0,
                                url: "https://windmill.works/#/gym/shared/abc123")
        XCTAssertEqual(Coach.link(sent, base: URL(string: "https://api.example.com")!),
                       "https://windmill.works/#/gym/shared/abc123")

        let old = SessionShare(token: "abc123", expiresAtMs: 0)
        let fallback = Coach.link(old, base: base)
        XCTAssertFalse(fallback.contains("/v1/"))
        XCTAssertTrue(fallback.hasSuffix("/#/gym/shared/abc123"))
    }

    // The live card prints the ADDRESS in full and the expiry the server decided — never a day
    // counted off this device's clock, which can support an omission but never an assertion.
    func testTheLiveCardShowsTheAddressAndTheServersOwnExpiry() {
        let card = Coach.card(.live(share: share), base: base)

        XCTAssertEqual(card.title, "The link is live")
        XCTAssertEqual(card.body, "Anyone who has this link can read this one workout. It stops "
                       + "working on \(Readout.day(share.expiresAtMs)), and revoking it kills it immediately.")
        XCTAssertEqual(card.link, "https://windmill.works/#/gym/shared/abc123")
        XCTAssertEqual(card.action, "Copy link")
        XCTAssertEqual(card.revoke, "Revoke the link")
        XCTAssertNil(card.note)
    }

    func testCopyingSaysSoAndChangesNothingElseAboutTheCard() {
        let copied = Coach.State.live(share: share).after(.copied)
        let card = Coach.card(copied, base: base)

        XCTAssertEqual(copied, .live(share: share, copied: true))
        XCTAssertEqual(card.action, "Copied")
        XCTAssertEqual(card.link, "https://windmill.works/#/gym/shared/abc123")
        XCTAssertEqual(card.revoke, "Revoke the link")
    }

    func testARevokedLinkIsDeadInPlainWordsAndTheDoorReopens() {
        let card = Coach.card(.revoked, base: base)

        XCTAssertEqual(card.title, "The link is dead")
        XCTAssertEqual(card.body,
                       "Anyone still holding it gets nothing. You can make a new one whenever you like.")
        XCTAssertNil(card.link)
        XCTAssertEqual(card.action, "Get a new link")
        XCTAssertNil(card.revoke)
    }

    func testWaitingOnTheLogOffersNothingToTapTwice() {
        let card = Coach.card(.working, base: base)

        XCTAssertEqual(card.action, "…")
        XCTAssertNil(card.link)
        XCTAssertNil(card.revoke)
    }

    // THE ONE THAT MATTERS. A revoke that did not happen leaves the capability live, and the card has
    // to keep saying so: drawing it as dead would tell a lifter their coach can no longer read the
    // session on the strength of a request that failed.
    func testARevokeThatFailedLeavesTheLinkLiveAndSaysWhy() {
        let live = Coach.State.live(share: share, copied: true)
        let after = live.after(.revokeFailed("the log didn’t answer — the link is still live"))
        let card = Coach.card(after, base: base)

        XCTAssertEqual(after, .live(share: share, copied: false,
                                    note: "the log didn’t answer — the link is still live"))
        XCTAssertEqual(card.title, "The link is live")
        XCTAssertEqual(card.link, "https://windmill.works/#/gym/shared/abc123")
        XCTAssertEqual(card.note, "the log didn’t answer — the link is still live")
        XCTAssertEqual(card.revoke, "Revoke the link", "the door stays open — it is still revocable")
        XCTAssertEqual(card.action, "Copy link", "the note is the news, so the clipboard claim goes")
    }

    // The rest of the machine, in one pass: nothing claims a link exists until the log has said so.
    func testTheStateMachineOnlyGoesLiveOnTheLogsOwnAnswer() {
        XCTAssertEqual(Coach.State.closed().after(.asked), .working)
        XCTAssertEqual(Coach.State.working.after(.minted(share)),
                       .live(share: share))
        XCTAssertEqual(Coach.State.working.after(.mintFailed("no such session")),
                       .closed(note: "no such session"))
        XCTAssertEqual(Coach.State.working.after(.revoked), .revoked)
        XCTAssertEqual(Coach.State.closed().after(.copied), .closed(),
                       "there is nothing to copy before a link exists")
        XCTAssertEqual(Coach.State.revoked.after(.revokeFailed("gone")), .revoked,
                       "a revoke cannot fail on a link that is already dead")
    }

    // `expiresAt` is the server's field and the token is opaque — decoded exactly as the wire spells
    // them, with no key strategy anywhere in this app to guess at.
    func testTheMintedShareDecodesOffTheWire() throws {
        let decoded = try JSONDecoder().decode(
            SessionShare.self, from: Data(#"{"token":"abc123","expiresAt":1756992000000}"#.utf8))

        XCTAssertEqual(decoded, share)
    }
}

// The store's half: the two doors, and what each says when the log refuses. The room hands these to
// the card already bound to one session, so what is checked here is that a refusal arrives as words
// somebody can act on rather than as a bool nobody can.
@MainActor
final class CoachShareStoreTests: XCTestCase {
    private var queueURL: URL!

    override func setUp() async throws {
        queueURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-share-\(UUID().uuidString).json")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: queueURL)
    }

    // `sync` answers with the fake or with nothing at all, which is exactly what the real one does
    // for a signed-out account: there is no log to reach, and that is a state rather than a failure.
    private func store(_ server: FakeTraining?) -> TrainingStore {
        var ms: Int64 = 1_000
        return TrainingStore(queue: SetQueue(url: queueURL),
                             deviceCatalog: DeviceCatalog(url: queueURL.appendingPathExtension("cat")),
                             now: { ms += 1; return ms },
                             undoWindowMs: 0,
                             sync: { _ in server })
    }

    private var signedIn: Account {
        Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
                user: User(id: "u1", email: "sam@example.com", name: "Sam"))
    }

    // Idempotent on the session: tapping Share twice hands back the link that is already live, so a
    // lifter never sends two capabilities they would then have to revoke separately.
    func testMintingTwiceHandsBackTheSameLink() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 2_000))
        let store = store(server)
        await store.connect(to: signedIn)

        let first = await store.share("ses_1")
        let again = await store.share("ses_1")

        XCTAssertEqual(try? first.get(), SessionShare(token: "tok_ses_1", expiresAtMs: 2_592_000_000))
        XCTAssertEqual(try? again.get(), try? first.get())
    }

    // A refusal is repeated in the LOG'S OWN WORDS, and a log that went quiet is a different fact
    // from a log that answered — the lifter can act on the first and can only wait out the second.
    func testARefusedMintSpeaksTheLogsSentenceAndSilenceSpeaksTheRoomsOwn() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 2_000))
        let store = store(server)
        await store.connect(to: signedIn)

        server.refuseShare = .refused(404, Refusal(Data(#"{"error":"no such session"}"#.utf8)))
        guard case .failure(let refused) = await store.share("ses_1") else {
            return XCTFail("a 404 is not a share")
        }
        XCTAssertEqual(refused, .refused("no such session"))
        XCTAssertEqual(refused.line("the link wasn’t made"), "no such session")

        server.refuseShare = nil
        server.online = false
        guard case .failure(let quiet) = await store.share("ses_1") else {
            return XCTFail("an unreachable log is not a share")
        }
        XCTAssertEqual(quiet, .noAnswer)
        XCTAssertEqual(quiet.line("the link wasn’t made"),
                       "the log didn’t answer — the link wasn’t made")
    }

    // Revoked is deleted: the row IS the capability. A revoke that lands answers with nothing to
    // say, and one that does not answers with what stops the card claiming the link is dead.
    func testRevokingAnswersWithNothingAndAFailedRevokeAnswersWithWhy() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 2_000))
        let store = store(server)
        await store.connect(to: signedIn)
        _ = await store.share("ses_1")

        let revoked = await store.revokeShare("ses_1")
        XCTAssertNil(revoked)
        XCTAssertNil(server.shares["ses_1"])

        server.online = false
        let quiet = await store.revokeShare("ses_1")
        XCTAssertEqual(quiet, .noAnswer)
    }

    // Signed out there is no log to reach and no session to share, so the doors answer without
    // inventing a request — the same shape every other write in this store takes.
    func testSignedOutThereIsNothingToShare() async {
        let store = store(nil)
        await store.connect(to: Account(
            api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
            user: nil))

        guard case .failure(let why) = await store.share("ses_1") else {
            return XCTFail("there is no log to answer")
        }
        XCTAssertEqual(why, .noAnswer)
        let revoked = await store.revokeShare("ses_1")
        XCTAssertEqual(revoked, .noAnswer)
        guard case .failure(let quiet) = await store.statistics() else {
            return XCTFail("there is no log to answer")
        }
        XCTAssertEqual(quiet, .noAnswer)
    }
}
