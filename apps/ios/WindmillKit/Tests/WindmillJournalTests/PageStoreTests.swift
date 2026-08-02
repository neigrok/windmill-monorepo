import XCTest
@testable import WindmillJournal
@testable import WindmillPlatform

// What has to be true for someone's writing to survive: it is on the device before the network is
// consulted, it stays there when the network refuses, and signing in claims it rather than asking
// for it again. These are the paths that lose words if they are wrong.

@MainActor
final class PageStoreTests: XCTestCase {
    private var cacheURL: URL!

    override func setUp() async throws {
        cacheURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("journal-\(UUID().uuidString).json")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: cacheURL)
    }

    private func makeStore(today: String = "2026-07-20", sync: FakeSync? = nil) -> PageStore {
        PageStore(
            cache: PageCache(url: cacheURL),
            clock: HlcClock(actor: "d-test", now: { 1_000 }),
            today: LocalDay(iso: today)!,
            sync: { _ in sync }
        )
    }

    private func account(signedIn: Bool) -> Account {
        Account(
            api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
            user: signedIn ? User(id: "u1", email: "sam@example.com", name: "Sam") : nil
        )
    }

    // Signed out is a supported state, not a degraded one (auth canon §2 — no walls). Writing works
    // and the page is on the device the moment it is typed.
    func testWritingSignedOutLandsOnTheDeviceAndSaysSo() async {
        let store = makeStore()
        await store.connect(to: account(signedIn: false))

        store.type("the house is quiet")
        await store.flushPendingWrite()

        XCTAssertEqual(store.saveState, .onThisDevice)
        XCTAssertEqual(store.saveState.line, "saved on this device")
        XCTAssertEqual(PageCache(url: cacheURL).page(on: LocalDay(iso: "2026-07-20")!)?.body,
                       "the house is quiet")
    }

    // The claim (auth canon §4): everything written before there was an account goes up on sign-in,
    // additively, without anyone being asked to choose between local and cloud.
    func testSigningInClaimsWhatWasWrittenBeforeThereWasAnAccount() async {
        let store = makeStore()
        await store.connect(to: account(signedIn: false))
        store.type("written before I signed in")
        await store.flushPendingWrite()

        let server = FakeSync()
        let claimed = makeStore(sync: server)
        await claimed.connect(to: account(signedIn: true))

        XCTAssertEqual(server.stored["2026-07-20"]?.body, "written before I signed in")
        XCTAssertTrue(PageCache(url: cacheURL).pending.isEmpty, "nothing is still owed once it lands")
    }

    // A write that cannot reach the server is not a lost write. It stays on the device, still owed,
    // and the surface says exactly that rather than showing an error.
    func testAWriteThatCannotLandStaysOwedAndSaysOffline() async {
        let server = FakeSync()
        server.online = false
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        store.type("no signal here")
        await store.flushPendingWrite()

        XCTAssertEqual(store.saveState, .offline)
        XCTAssertEqual(store.saveState.line, "offline · saved here")
        XCTAssertEqual(PageCache(url: cacheURL).pending.map(\.body), ["no signal here"])
    }

    // ...and the moment it can reach the server, the same words go up. Nothing needs retyping.
    func testTheOwedWriteGoesUpOnceTheNetworkReturns() async {
        let server = FakeSync()
        server.online = false
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        store.type("written on a train")
        await store.flushPendingWrite()

        server.online = true
        let reconnected = makeStore(sync: server)
        await reconnected.connect(to: account(signedIn: true))

        XCTAssertEqual(server.stored["2026-07-20"]?.body, "written on a train")
        XCTAssertEqual(reconnected.body, "written on a train")
    }

    func testASuccessfulWriteIsNoLongerOwed() async {
        let server = FakeSync()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        store.type("this one lands")
        await store.flushPendingWrite()

        XCTAssertEqual(store.saveState, .saved)
        XCTAssertTrue(PageCache(url: cacheURL).pending.isEmpty)
    }

    // The canvas draws every day from the earliest written one up to yesterday, gaps included —
    // and a gap is drawn as a gap, never skipped and never coloured as a failure.
    func testTheCanvasDrawsGapsBetweenTheDaysThatWereWritten() async {
        let server = FakeSync()
        server.seed(day: "2026-07-16", body: "monday")
        server.seed(day: "2026-07-19", body: "thursday")

        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.days.map(\.day.iso),
                       ["2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19"])
        XCTAssertEqual(store.days.map(\.written), [true, false, false, true])
        XCTAssertFalse(store.days.contains { $0.day.iso == "2026-07-20" }, "today is the draft, never history")
    }

    // Today's page comes down into the draft so a second device continues the same page rather than
    // opening a blank one over it.
    func testTodaysPageFromTheAccountBecomesTheDraft() async {
        let server = FakeSync()
        server.seed(day: "2026-07-20", body: "started on my other phone", mood: .m4)

        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.body, "started on my other phone")
        XCTAssertEqual(store.mood, .m4)
    }

    // The race the adopt rule exists for: a reply must never overwrite a field the writer has moved
    // since the write went out.
    func testAServerReplyDoesNotOverwriteWhatIsStillBeingTyped() async {
        let server = FakeSync()
        server.rewriteBodyOnPut = "what the server had"
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        store.type("first sentence")
        await store.flushPendingWrite()
        XCTAssertEqual(store.body, "what the server had", "unmoved, so the winner is adopted")

        store.type("second sentence")           // the writer moved on before the next reply
        server.rewriteBodyOnPut = "stale reply"
        await store.flushPendingWrite()
        XCTAssertEqual(store.body, "stale reply", "the write it answers is the one just sent")
    }

    func testTappingTheStepYouAreOnClearsIt() async {
        let store = makeStore()
        await store.connect(to: account(signedIn: false))

        store.tap(mood: .m3)
        XCTAssertEqual(store.mood, .m3)
        store.tap(mood: .m3)
        XCTAssertEqual(store.mood, .none, "a scale must always have a way back to unset")

        store.tap(energy: .e2)
        store.tap(energy: .e2)
        XCTAssertEqual(store.energy, .none)
    }

    func testAnUntouchedCanvasIsTheFirstRun() async {
        let store = makeStore()
        await store.connect(to: account(signedIn: false))
        XCTAssertTrue(store.isFirstRun)

        store.type("anything at all")
        XCTAssertFalse(store.isFirstRun)
    }
}

final class PageCacheTests: XCTestCase {
    private func makeCache() -> (PageCache, URL) {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("journal-\(UUID().uuidString).json")
        return (PageCache(url: url), url)
    }

    func testWhatWasWrittenSurvivesBeingReadBackFromDisk() {
        let (cache, url) = makeCache()
        defer { try? FileManager.default.removeItem(at: url) }

        cache.store(Page(day: LocalDay(iso: "2026-07-20")!, body: "kept", stamp: Hlc("5:0:d-a")), needsPush: true)
        cache.flush()

        let reopened = PageCache(url: url)
        XCTAssertEqual(reopened.page(on: LocalDay(iso: "2026-07-20")!)?.body, "kept")
        XCTAssertEqual(reopened.pending.count, 1, "an unsent page is still owed after a relaunch")
    }

    // A remote page arriving settles the debt only if it BEATS what we were holding. If our unsent
    // page still wins, it is still unsent — losing this flag would silently drop the write.
    func testAnOlderRemotePageDoesNotSettleAnUnsentWrite() {
        let (cache, url) = makeCache()
        defer { try? FileManager.default.removeItem(at: url) }
        let day = LocalDay(iso: "2026-07-20")!

        cache.store(Page(day: day, body: "mine, unsent", stamp: Hlc("500:0:d-a")), needsPush: true)
        cache.store(Page(day: day, body: "older, from the server", stamp: Hlc("100:0:d-b")), needsPush: false)

        XCTAssertEqual(cache.page(on: day)?.body, "mine, unsent")
        XCTAssertEqual(cache.pending.count, 1)
    }

    func testANewerRemotePageWinsAndEndsTheDebt() {
        let (cache, url) = makeCache()
        defer { try? FileManager.default.removeItem(at: url) }
        let day = LocalDay(iso: "2026-07-20")!

        cache.store(Page(day: day, body: "mine, unsent", stamp: Hlc("100:0:d-a")), needsPush: true)
        cache.store(Page(day: day, body: "newer, from the server", stamp: Hlc("500:0:d-b")), needsPush: false)

        XCTAssertEqual(cache.page(on: day)?.body, "newer, from the server")
        XCTAssertTrue(cache.pending.isEmpty, "a superseded write is not still owed")
    }

    // The reply to a write is not a receipt for every write. If the writer typed again while the
    // first PUT was in flight, the second page is still owed when the first one's answer lands —
    // clearing it there would drop the newest words on the floor if the app died next.
    func testAReplyToAnEarlierWriteLeavesANewerOneOwed() {
        let (cache, url) = makeCache()
        defer { try? FileManager.default.removeItem(at: url) }
        let day = LocalDay(iso: "2026-07-20")!

        cache.store(Page(day: day, body: "first", stamp: Hlc("100:0:d-a")), needsPush: true)
        cache.store(Page(day: day, body: "second, typed while the first was in flight",
                         stamp: Hlc("200:0:d-a")), needsPush: true)

        cache.markPushed(day, winner: Page(day: day, body: "first", stamp: Hlc("100:0:d-a")))

        XCTAssertEqual(cache.page(on: day)?.body, "second, typed while the first was in flight")
        XCTAssertEqual(cache.pending.count, 1, "the newer write is still owed")
    }

    func testAReplyCarryingTheWriteWeSentSettlesIt() {
        let (cache, url) = makeCache()
        defer { try? FileManager.default.removeItem(at: url) }
        let day = LocalDay(iso: "2026-07-20")!

        cache.store(Page(day: day, body: "only write", stamp: Hlc("100:0:d-a")), needsPush: true)
        cache.markPushed(day, winner: Page(day: day, body: "only write", stamp: Hlc("100:0:d-a")))

        XCTAssertTrue(cache.pending.isEmpty)
    }

    func testPendingWritesComeBackOldestFirst() {
        let (cache, url) = makeCache()
        defer { try? FileManager.default.removeItem(at: url) }

        for day in ["2026-07-19", "2026-07-17", "2026-07-18"] {
            cache.store(Page(day: LocalDay(iso: day)!, body: day, stamp: Hlc("1:0:d-a")), needsPush: true)
        }
        XCTAssertEqual(cache.pending.map(\.day.iso), ["2026-07-17", "2026-07-18", "2026-07-19"],
                       "a claim replays in the order it was lived")
    }

    func testAnUnreadableCacheFileOpensEmptyRatherThanCrashing() {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("journal-\(UUID().uuidString).json")
        try? Data("not json at all".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        XCTAssertTrue(PageCache(url: url).pages.isEmpty)
    }
}

// A server that is entirely under the test's control: it can be offline, it can already hold pages,
// and it can hand back a different winner than it was sent.
final class FakeSync: PageSyncing, @unchecked Sendable {
    var online = true
    var stored: [String: Page] = [:]
    var rewriteBodyOnPut: String?
    private(set) var puts: [Page] = []

    func seed(day: String, body: String, mood: Mood = .none, stamp: String = "1:0:d-server") {
        let page = Page(day: LocalDay(iso: day)!, body: body, mood: mood, stamp: Hlc(stamp))
        stored[day] = page
    }

    func put(_ page: Page) async throws -> Page {
        guard online else { throw WindmillApiError.offline }
        puts.append(page)
        var winner = Page.winner(of: page, and: stored[page.day.iso])
        if let rewritten = rewriteBodyOnPut { winner.body = rewritten }
        stored[page.day.iso] = winner
        return winner
    }

    func range(from: LocalDay, to: LocalDay) async throws -> [Page] {
        guard online else { throw WindmillApiError.offline }
        return stored.values.filter { $0.day >= from && $0.day <= to }.sorted { $0.day < $1.day }
    }
}
