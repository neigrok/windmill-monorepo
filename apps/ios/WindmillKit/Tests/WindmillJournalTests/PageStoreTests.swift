import XCTest
@testable import WindmillJournal
@testable import WindmillPlatform

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

    func testADayWithOnlyAMoodIsStillDrawn() async {
        let server = FakeSync()
        server.seed(day: "2026-07-18", body: "", mood: 3)

        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.days.map(\.day.iso), ["2026-07-18"])
    }

    func testTodaysPageFromTheAccountBecomesTheDraft() async {
        let server = FakeSync()
        server.seed(day: "2026-07-20", body: "started on my other phone", mood: 4)

        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.body, "started on my other phone")
        XCTAssertEqual(store.mood, 4)
    }

    func testAServerReplyDoesNotOverwriteWhatIsStillBeingTyped() async {
        let server = FakeSync()
        server.rewriteBodyOnPut = "what the server had"
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        store.type("first sentence")
        await store.flushPendingWrite()
        XCTAssertEqual(store.body, "what the server had", "unmoved, so the winner is adopted")

        store.type("second sentence")
        server.rewriteBodyOnPut = "stale reply"
        await store.flushPendingWrite()
        XCTAssertEqual(store.body, "stale reply", "the write it answers is the one just sent")
    }

    func testSettingTheValueYouAreOnIsNotAWayToClearIt() async {
        let store = makeStore()
        await store.connect(to: account(signedIn: false))

        store.set(mood: 3)
        XCTAssertEqual(store.mood, 3)
        store.set(mood: 3)
        XCTAssertEqual(store.mood, 3, "on a scrubber, landing where the head already is is how a drag ends")

        store.set(mood: 0)
        XCTAssertEqual(store.mood, 0, "zero is an answer, not an erasure")

        store.set(mood: nil)
        XCTAssertEqual(store.mood, nil, "clearing is explicit, from the numeral")

        store.set(energy: 0)
        XCTAssertEqual(store.energy, 0)
        store.set(energy: nil)
        XCTAssertEqual(store.energy, nil)
    }

    func testAScaleOutOfRangeNarrowsRatherThanLanding() async {
        let store = makeStore()
        await store.connect(to: account(signedIn: false))

        store.set(mood: 11)
        XCTAssertEqual(store.mood, nil)
        store.set(energy: -1)
        XCTAssertEqual(store.energy, nil)
    }

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

    func testAnUnconfirmedSeatReadsItsOwnFileButAdoptsNothing() async {
        let log = FakeSync()
        let asA = makeStore(servers: ["u-a": log])
        await asA.connect(to: account(userId: "u-a"))
        asA.type("A's own words")
        await asA.flushPendingWrite()

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

    func testARefusedFlushDoesNotDestroyTheAnonymousPages() async {
        let ghost = makeStore()
        await ghost.connect(to: account(userId: nil))
        ghost.type("the only copy of this sentence")
        await ghost.flushPendingWrite()

        try? FileManager.default.createDirectory(
            at: directory.appendingPathComponent(PageCache.fileName(forSeat: "u-a")),
            withIntermediateDirectories: true)

        let log = FakeSync()
        let arriving = makeStore(servers: ["u-a": log])
        await arriving.connect(to: account(userId: "u-a"))

        XCTAssertEqual(device(of: nil).pending.map(\.body), ["the only copy of this sentence"],
                       "the device that refused the bytes is still holding them")
    }

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

    func testASeatNameCannotReachOutOfItsOwnDirectoryOrIntoAReservedFile() {
        XCTAssertEqual(PageCache.fileName(forSeat: nil), "windmill-journal-pages-v2-anon.json")
        XCTAssertEqual(PageCache.fileName(forSeat: "0f8e-4b2a"), "windmill-journal-pages-v2-u.0f8e-4b2a.json")
        XCTAssertEqual(PageCache.fileName(forSeat: "../../windmill-journal-pages"),
                       "windmill-journal-pages-v2-u.windmill-journal-pages.json")
        XCTAssertEqual(PageCache.fileName(forSeat: "anon"), "windmill-journal-pages-v2-u.anon.json")
        XCTAssertEqual(PageCache.fileName(forSeat: "unclaimed"), "windmill-journal-pages-v2-u.unclaimed.json")
    }

    // A v1 file read as v2 would report every unanswered scale as a recorded zero.
    func testAVersion1SeatFileIsMigratedOntoTheElevenStepScalesAndRemoved() {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("journal-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let held = [
            "2026-07-18": PageCache.Entry(page: Page(day: LocalDay(iso: "2026-07-18")!, body: "unanswered",
                                                     mood: 0, energy: 0, stamp: Hlc("100:0:d-a")),
                                          needsPush: true),
            "2026-07-19": PageCache.Entry(page: Page(day: LocalDay(iso: "2026-07-19")!, body: "hard, low",
                                                     mood: 1, energy: 1, stamp: Hlc("100:0:d-a")),
                                          needsPush: true),
            "2026-07-20": PageCache.Entry(page: Page(day: LocalDay(iso: "2026-07-20")!, body: "clear, high",
                                                     mood: 5, energy: 3, stamp: Hlc("100:0:d-a")),
                                          needsPush: true),
        ]
        let version1 = directory.appendingPathComponent("windmill-journal-pages-u.u1.json")
        try? JSONEncoder().encode(held).write(to: version1)

        let opened = PageCache(seat: "u1", in: directory, deviceHolds: nil)

        XCTAssertEqual(opened.pages.map(\.mood), [nil, 1, 9],
                       "v1's five steps land on the odd positions, and its 0 sentinel on unset")
        XCTAssertEqual(opened.pages.map(\.energy), [nil, 2, 8])
        XCTAssertEqual(opened.pending.count, 3, "and nothing unsent is dropped on the way")
        XCTAssertFalse(FileManager.default.fileExists(atPath: version1.path))
    }

    // Quarantine is the one store designed never to lose a page, so the version bump has to carry it —
    // an orphaned v1 quarantine is a diary in a file nothing reads.
    func testTheVersion1QuarantineIsCarriedOntoTheNewScalesAndRetired() {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("journal-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let waiting = [
            "2026-07-19": PageCache.Entry(page: Page(day: LocalDay(iso: "2026-07-19")!, body: "unanswered",
                                                     mood: 0, energy: 0), needsPush: true),
            "2026-07-20": PageCache.Entry(page: Page(day: LocalDay(iso: "2026-07-20")!, body: "clear, high",
                                                     mood: 5, energy: 3), needsPush: true),
        ]
        let version1 = directory.appendingPathComponent("windmill-journal-pages-unclaimed.json")
        try? JSONEncoder().encode(waiting).write(to: version1)

        _ = PageCache(seat: nil, in: directory, deviceHolds: nil)

        let carried = PageCache.quarantinedPages(in: directory)
        XCTAssertEqual(carried.map(\.body), ["unanswered", "clear, high"], "nothing waiting was orphaned")
        XCTAssertEqual(carried.map(\.mood), [nil, 9], "and a v1 zero is unanswered, not a recorded zero")
        XCTAssertEqual(carried.map(\.energy), [nil, 8])
        XCTAssertFalse(FileManager.default.fileExists(atPath: version1.path), "the v1 name is retired")
    }

    // A throw inside one entry fails the whole `[String: Entry]` document, so the cache would open empty
    // and the owed page beside the bad one would be gone with no trace.
    func testOneBadScaleInACacheFileCostsThatScaleAndNothingElse() {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("journal-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        try? Data("""
        {"2026-07-19":{"page":{"day":"2026-07-19","body":"owed","mood":3.5,"energy":2,
                               "source":"typed","stamp":"0:0:","updatedAt":0},"needsPush":true},
         "2026-07-20":{"page":{"day":"2026-07-20","body":"read back","mood":7,"energy":4,
                               "source":"typed","stamp":"100:0:d-a","updatedAt":0},"needsPush":false}}
        """.utf8).write(to: url)

        let opened = PageCache(url: url)

        XCTAssertEqual(opened.pages.map(\.body), ["owed", "read back"], "the owed page is not silently lost")
        XCTAssertEqual(opened.pages.map(\.mood), [nil, 7])
        XCTAssertEqual(opened.pending.map(\.body), ["owed"])
    }

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

extension PageStoreTests {
    func testMidnightDropsYesterdayIntoTheHistoryAndOpensTonightBlank() async {
        let server = FakeSync()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        store.type("written before midnight")
        await store.flushPendingWrite()

        await store.rollOver(to: LocalDay(iso: "2026-07-21")!)

        XCTAssertEqual(store.today, LocalDay(iso: "2026-07-21")!)
        XCTAssertEqual(store.body, "")
        XCTAssertEqual(store.mood, nil)
        XCTAssertEqual(store.energy, nil)
        XCTAssertEqual(store.days.map(\.day.iso), ["2026-07-20"])
        XCTAssertEqual(store.days.map(\.body), ["written before midnight"])
    }

    func testTheUnsavedBeatIsKeptUnderTheDayItWasTypedOn() async {
        let server = FakeSync()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        store.type("the last sentence of the night")

        await store.rollOver(to: LocalDay(iso: "2026-07-21")!)

        XCTAssertEqual(server.stored["2026-07-20"]?.body, "the last sentence of the night")
        XCTAssertNil(server.stored["2026-07-21"])
        XCTAssertEqual(store.body, "")
    }

    func testTheTurnOverReadsTheWindowAroundTheNewToday() async {
        let server = FakeSync()
        server.seed(day: "2026-07-21", body: "already written on the laptop")
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        await store.rollOver(to: LocalDay(iso: "2026-07-21")!)

        XCTAssertEqual(store.body, "already written on the laptop")
    }

    func testTheSameDayAgainIsNothingAtAll() async {
        let server = FakeSync()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        store.type("still today")
        await store.flushPendingWrite()

        await store.rollOver(to: LocalDay(iso: "2026-07-20")!)

        XCTAssertEqual(store.today, LocalDay(iso: "2026-07-20")!)
        XCTAssertEqual(store.body, "still today")
        XCTAssertTrue(store.days.isEmpty)
    }

    func testUntilTomorrowIsTheWritersOwnMidnight() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Lisbon")!
        let elevenPM = calendar.date(from: DateComponents(year: 2026, month: 7, day: 20, hour: 23))!

        XCTAssertEqual(LocalDay.untilTomorrow(now: elevenPM, calendar: calendar), 3_600, accuracy: 0.5)
        XCTAssertEqual(LocalDay.untilTomorrow(now: elevenPM.addingTimeInterval(3_600), calendar: calendar),
                       86_400, accuracy: 0.5)
    }
}

final class FakeSync: PageSyncing, @unchecked Sendable {
    var online = true
    var stored: [String: Page] = [:]
    var rewriteBodyOnPut: String?
    private(set) var puts: [Page] = []

    func seed(day: String, body: String, mood: Int? = nil, stamp: String = "1:0:d-server") {
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

        XCTAssertEqual(module.hubLine(account("u-a")).headline, "You’ve written today.")
        XCTAssertEqual(module.hubLine(account("u-a")).meta, "3 words so far")
        XCTAssertEqual(module.holdings(account("u-a")).count, 1)

        XCTAssertEqual(module.hubLine(account(nil)).headline, "The cursor’s waiting.")
        XCTAssertNil(module.hubLine(account(nil)).meta)
        XCTAssertEqual(module.holdings(account(nil)).count, 0)

        XCTAssertEqual(module.hubLine(account("u-b")).headline, "The cursor’s waiting.")
        XCTAssertEqual(module.holdings(account("u-b")).count, 0)
    }

    func testASeatTheLogCouldNotConfirmStillCountsItsOwnPages() {
        let module = JournalModule(device: directory)

        XCTAssertEqual(module.hubLine(account("u-a", verified: false)).headline, "You’ve written today.")
        XCTAssertEqual(module.holdings(account("u-a", verified: false)).count, 1)
        XCTAssertEqual(module.holdings(account("u-b", verified: false)).count, 0, "and only their own")
    }
}
