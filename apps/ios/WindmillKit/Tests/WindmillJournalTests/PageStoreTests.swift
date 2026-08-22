import XCTest
@testable import WindmillJournal
@testable import WindmillPlatform

// What has to be true for someone's writing to survive: it is on the device before the network is
// consulted, it stays there when the network refuses, and signing in claims it rather than asking
// for it again. These are the paths that lose words if they are wrong.

@MainActor
final class PageStoreTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("journal-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeStore(today: String = "2026-07-20", sync: FakeSync? = nil,
                           servers: [String: FakeSync] = [:]) -> PageStore {
        PageStore(
            open: { [directory] seat in PageCache(seat: seat, in: directory!) },
            clock: HlcClock(actor: "d-test", now: { 1_000 }),
            today: LocalDay(iso: today)!,
            sync: { account in
                guard let id = account.user?.id else { return nil }
                return servers[id] ?? sync
            }
        )
    }

    private func device(of seat: String?) -> PageCache {
        PageCache(seat: seat, in: directory)
    }

    private func account(signedIn: Bool) -> Account {
        account(userId: signedIn ? "u1" : nil)
    }

    private func account(userId: String?, verified: Bool = true) -> Account {
        Account(
            api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
            user: userId.map { User(id: $0, email: "\($0)@example.com", name: $0) },
            verified: verified
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
        XCTAssertEqual(device(of: nil).page(on: LocalDay(iso: "2026-07-20")!)?.body,
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
        XCTAssertTrue(device(of: "u1").pending.isEmpty, "nothing is still owed once it lands")
        XCTAssertTrue(device(of: nil).pages.isEmpty, "and the anonymous file is emptied once it has")
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
        XCTAssertEqual(device(of: "u1").pending.map(\.body), ["no signal here"])
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
        XCTAssertTrue(device(of: "u1").pending.isEmpty)
    }

    // The canvas is what you wrote, not a calendar with holes in it: a day nobody wrote is not
    // drawn at all. Unwritten days used to appear as a marker and the words "nothing written".
    func testOnlyTheDaysThatWereWrittenAreDrawn() async {
        let server = FakeSync()
        server.seed(day: "2026-07-16", body: "monday")
        server.seed(day: "2026-07-19", body: "thursday")

        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.days.map(\.day.iso), ["2026-07-16", "2026-07-19"],
                       "the three days between them were never written and are not the canvas's business")
        XCTAssertFalse(store.days.contains { $0.day.iso == "2026-07-20" }, "today is the draft, never history")
    }

    // A page carrying only a mood is still a day someone showed up for, so it is still drawn.
    func testADayWithOnlyAMoodIsStillDrawn() async {
        let server = FakeSync()
        server.seed(day: "2026-07-18", body: "", mood: .m3)

        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.days.map(\.day.iso), ["2026-07-18"])
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


    // MOBILE-1, and it is the whole of why this store carries a seat. A handed-over phone: A signs
    // in and writes, signs out, and the next person signs in with their own account. Every line of
    // this used to fail — the canvas kept A's days, the composer kept A's sentence, and B's first
    // keystroke PUT A's prose into B's account on the log.
    func testTheNextAccountSeesNoneOfThePreviousOnesPagesAndSendsNoneOfThem() async {
        let logOfA = FakeSync()
        logOfA.seed(day: "2026-07-19", body: "A's private page from yesterday")
        let logOfB = FakeSync()
        let phone = makeStore(servers: ["u-a": logOfA, "u-b": logOfB])

        await phone.connect(to: account(userId: "u-a"))
        phone.type("A's private words for today")
        await phone.flushPendingWrite()
        XCTAssertEqual(phone.days.map(\.body), ["A's private page from yesterday"])

        await phone.connect(to: account(userId: nil))
        XCTAssertEqual(phone.days, [], "a signed-out screen holds nothing of the account that left")
        XCTAssertEqual(phone.body, "")

        await phone.connect(to: account(userId: "u-b"))
        XCTAssertEqual(phone.days, [], "B's canvas is B's")
        XCTAssertEqual(phone.body, "")
        phone.type("B's own words")
        await phone.flushPendingWrite()

        XCTAssertEqual(logOfB.stored.values.map(\.body), ["B's own words"])
        XCTAssertEqual(logOfA.stored.values.map(\.body).sorted(),
                       ["A's private page from yesterday", "A's private words for today"],
                       "and nothing of B's was written into A's account either")
    }

    // The path no hook covers: the app is killed rather than signed out, and the next launch opens
    // for somebody else. A cold launch runs no cleanup at all, which is exactly why the seat is in
    // the file name rather than in a sign-out that has to remember to run.
    func testAColdLaunchUnderANewSeatDrawsNothingOfTheOldOne() async {
        let logOfA = FakeSync()
        let asA = makeStore(servers: ["u-a": logOfA])
        await asA.connect(to: account(userId: "u-a"))
        asA.type("A's private words for today")
        await asA.flushPendingWrite()

        let relaunched = makeStore(servers: ["u-a": logOfA, "u-b": FakeSync()])
        await relaunched.connect(to: account(userId: "u-b"))

        XCTAssertEqual(relaunched.days, [])
        XCTAssertEqual(relaunched.body, "")
    }

    // A seat the log has not confirmed THIS launch reads its OWN file — a basement is not a
    // sign-out, and a signed-in writer opening the canvas on a plane to a blank page would be the
    // product breaking its own promise. What it may not do is ADOPT: taking the anonymous pages is
    // irreversible, so it waits until the log says who is holding the phone.
    func testAnUnconfirmedSeatReadsItsOwnFileButAdoptsNothing() async {
        let log = FakeSync()
        let asA = makeStore(servers: ["u-a": log])
        await asA.connect(to: account(userId: "u-a"))
        asA.type("A's own words")
        await asA.flushPendingWrite()

        // A page written on this device before anybody signed in, waiting for whoever does.
        let anonymous = device(of: nil)
        anonymous.store(Page(day: LocalDay(iso: "2026-07-19")!, body: "written before anybody signed in",
                             stamp: Hlc("50:0:d-test")), needsPush: true)
        anonymous.flush()

        let basement = makeStore(servers: ["u-a": log])
        await basement.connect(to: account(userId: "u-a", verified: false))
        XCTAssertEqual(basement.body, "A's own words", "A reads A's own file with no signal")
        XCTAssertEqual(device(of: nil).pending.map(\.body), ["written before anybody signed in"],
                       "and the anonymous page is still nobody's, waiting for a confirmed seat")

        await basement.connect(to: account(userId: "u-a"))
        XCTAssertTrue(device(of: nil).pages.isEmpty, "which is when it is claimed")
        XCTAssertEqual(log.stored.values.map(\.body).sorted(),
                       ["A's own words", "written before anybody signed in"])
    }

    // A security fix that loses somebody's words is a worse bug than the one it closes. The seat
    // changes with the debounce still armed — the sentence has been typed and not yet saved — and
    // it has to land in the file of the person who typed it, unsent.
    func testWhatTheDepartingWriterTypedIsKeptInTheirOwnFile() async {
        let logOfA = FakeSync()
        logOfA.online = false
        let phone = makeStore(servers: ["u-a": logOfA, "u-b": FakeSync()])

        await phone.connect(to: account(userId: "u-a"))
        phone.type("half a sentence, never saved")
        await phone.connect(to: account(userId: "u-b"))

        XCTAssertEqual(phone.body, "", "B is not handed the sentence A was mid-way through")
        XCTAssertEqual(device(of: "u-a").pending.map(\.body), ["half a sentence, never saved"],
                       "it waits in A's own file, still owed")

        logOfA.online = true
        await phone.connect(to: account(userId: "u-a"))
        XCTAssertEqual(logOfA.stored.values.map(\.body), ["half a sentence, never saved"],
                       "and goes up when A comes back")
    }

    // A CLAIM THAT COULD NOT LAND MUST NOT DESTROY WHAT IT WAS CARRYING. The arriving seat's file
    // is the only other copy of an anonymous page, so the anonymous one is emptied only once that
    // file has taken the bytes AND SAID SO — a full disk or a refused write leaves the writing
    // exactly where it was, for the next attempt.
    func testARefusedFlushDoesNotDestroyTheAnonymousPages() async {
        let ghost = makeStore()
        await ghost.connect(to: account(userId: nil))
        ghost.type("the only copy of this sentence")
        await ghost.flushPendingWrite()

        // A directory where the arriving seat's file belongs: every write to it is refused.
        try? FileManager.default.createDirectory(
            at: directory.appendingPathComponent(PageCache.fileName(forSeat: "u-a")),
            withIntermediateDirectories: true)

        let log = FakeSync()
        let arriving = makeStore(servers: ["u-a": log])
        await arriving.connect(to: account(userId: "u-a"))

        XCTAssertEqual(device(of: nil).pending.map(\.body), ["the only copy of this sentence"],
                       "the device that refused the bytes is still holding them")
    }

    // The reply to a write that was in the air when the seat changed. It carries the departing
    // person's page, and the file it would be filed into is now somebody else's.
    func testAReplyThatOutlivedItsSeatSettlesNothing() async {
        let logOfA = FakeSync()
        let phone = makeStore(servers: ["u-a": logOfA, "u-b": FakeSync()])
        await phone.connect(to: account(userId: "u-a"))
        phone.type("A's words")
        await phone.flushPendingWrite()

        await phone.connect(to: account(userId: "u-b"))
        XCTAssertTrue(device(of: "u-b").pages.isEmpty, "nothing of A's is in B's file")
        XCTAssertEqual(device(of: "u-a").pages.map(\.body), ["A's words"])
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


    // THE UNKEYED FILE every build before 2026-08-22 wrote, retired on a phone that STILL HOLDS a
    // session. The device knows who was writing when it upgraded — the Keychain says so — and the
    // unsent pages are theirs: they land in their file, still owed, and the next connect sends them.
    // Nobody is asked anything, and nobody loses the page they wrote on a plane.
    func testTheLegacyStoreGoesToTheAccountTheDeviceIsHolding() {
        let directory = legacyDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let opened = PageCache(seat: "u-a", in: directory, deviceHolds: "u-a")

        XCTAssertEqual(opened.pending.map(\.body), ["written on a plane, never sent"])
        XCTAssertEqual(opened.pages.map(\.body), ["written on a plane, never sent"],
                       "and the cached copy of somebody's window is not kept — it is one read away")
        XCTAssertEqual(PageCache.quarantinedPages(in: directory), [], "nothing had to be quarantined")
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("windmill-journal-pages.json").path))
    }

    // And on a phone holding NO session, where the same bytes cannot be attributed to anybody:
    // "nobody is signed in now" is not "nobody wrote this", and handing them to the next account is
    // the leak itself. They go to a name no seat opens.
    func testTheLegacyStoreIsQuarantinedWhenTheDeviceHoldsNobody() {
        let directory = legacyDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let anonymous = PageCache(seat: nil, in: directory, deviceHolds: nil)
        let account = PageCache(seat: "u1", in: directory, deviceHolds: nil)

        XCTAssertTrue(anonymous.pages.isEmpty, "no seat is handed the unkeyed file's pages")
        XCTAssertTrue(account.pages.isEmpty)
        XCTAssertEqual(PageCache.quarantinedPages(in: directory).map(\.body),
                       ["written on a plane, never sent"],
                       "the unsent page waits where nobody's canvas reaches it")
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("windmill-journal-pages.json").path),
                       "and it is retired for good")
    }

    // One unkeyed file: a page read back from somebody's account, and a page never sent.
    private func legacyDirectory() -> URL {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("journal-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let held = [
            "2026-07-19": PageCache.Entry(page: Page(day: LocalDay(iso: "2026-07-19")!,
                                                     body: "read back from somebody's account",
                                                     stamp: Hlc("100:0:d-a")), needsPush: false),
            "2026-07-20": PageCache.Entry(page: Page(day: LocalDay(iso: "2026-07-20")!,
                                                     body: "written on a plane, never sent",
                                                     stamp: Hlc("200:0:d-a")), needsPush: true),
        ]
        try? JSONEncoder().encode(held).write(to: directory.appendingPathComponent("windmill-journal-pages.json"))
        return directory
    }

    // The seat's id is a path component, so it may only ever name a file in this directory — and an
    // account's id is written under `u.`, so it cannot name a RESERVED one either. Without the
    // prefix, a seat called `anon` or `unclaimed` opened the anonymous file or the quarantine, and
    // the only thing stopping it was that account ids happen to be uuids.
    func testASeatNameCannotReachOutOfItsOwnDirectoryOrIntoAReservedFile() {
        XCTAssertEqual(PageCache.fileName(forSeat: nil), "windmill-journal-pages-anon.json")
        XCTAssertEqual(PageCache.fileName(forSeat: "0f8e-4b2a"), "windmill-journal-pages-u.0f8e-4b2a.json")
        XCTAssertEqual(PageCache.fileName(forSeat: "../../windmill-journal-pages"),
                       "windmill-journal-pages-u.windmill-journal-pages.json")
        XCTAssertEqual(PageCache.fileName(forSeat: "anon"), "windmill-journal-pages-u.anon.json")
        XCTAssertEqual(PageCache.fileName(forSeat: "unclaimed"), "windmill-journal-pages-u.unclaimed.json")
    }

    // The un-prefixed per-seat file, written by builds from inside this wave: carried over rather
    // than orphaned, because a file nothing opens is somebody's pages that nothing opens.
    func testTheUnprefixedPerSeatFileIsCarriedOver() {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("journal-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let held = ["2026-07-20": PageCache.Entry(page: Page(day: LocalDay(iso: "2026-07-20")!,
                                                             body: "written under the old name",
                                                             stamp: Hlc("100:0:d-a")), needsPush: true)]
        let unprefixed = directory.appendingPathComponent("windmill-journal-pages-u1.json")
        try? JSONEncoder().encode(held).write(to: unprefixed)

        let opened = PageCache(seat: "u1", in: directory, deviceHolds: nil)

        XCTAssertEqual(opened.pending.map(\.body), ["written under the old name"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: unprefixed.path))
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

// The hub reads the device too — and used to read it unscoped, so a signed-out front door reported
// the previous account's word count before anybody had opened a room.
@MainActor
final class JournalModuleTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("journal-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let mine = PageCache(seat: "u-a", in: directory)
        mine.store(Page(day: .today(), body: "three private words", stamp: Hlc("100:0:d-a")), needsPush: false)
        mine.flush()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func account(_ id: String?, verified: Bool = true) -> Account {
        Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
                user: id.map { User(id: $0, email: "\($0)@example.com", name: $0) },
                verified: verified)
    }

    func testTheHubCountsThePagesOfWhoeverIsSittingHere() {
        let module = JournalModule(device: directory)

        XCTAssertEqual(module.hubLine(account("u-a")).headline, "You've written today.")
        XCTAssertEqual(module.hubLine(account("u-a")).meta, "3 words so far")
        XCTAssertEqual(module.holdings(account("u-a")).count, 1)

        XCTAssertEqual(module.hubLine(account(nil)).headline, "The cursor's waiting.")
        XCTAssertNil(module.hubLine(account(nil)).meta)
        XCTAssertEqual(module.holdings(account(nil)).count, 0)

        XCTAssertEqual(module.hubLine(account("u-b")).headline, "The cursor's waiting.")
        XCTAssertEqual(module.holdings(account("u-b")).count, 0)
    }

    // The hub of a phone with no signal is still that person's hub: it reads their own file.
    func testASeatTheLogCouldNotConfirmStillCountsItsOwnPages() {
        let module = JournalModule(device: directory)

        XCTAssertEqual(module.hubLine(account("u-a", verified: false)).headline, "You've written today.")
        XCTAssertEqual(module.holdings(account("u-a", verified: false)).count, 1)
        XCTAssertEqual(module.holdings(account("u-b", verified: false)).count, 0, "and only their own")
    }
}
