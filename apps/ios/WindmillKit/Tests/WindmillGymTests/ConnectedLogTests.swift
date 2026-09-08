import Foundation
import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

final class ConnectedLogTests: XCTestCase {
    func testTheEmptyScopeIsTheAccountWideGrantAndNotAnEmptyOne() {
        let reach = LogReach(scope: "")

        XCTAssertTrue(reach.accountWide)
        XCTAssertEqual(reach.levels, Set(LogReach.Level.allCases))
        XCTAssertTrue(reach.reachesTheLog)
        XCTAssertEqual(reach.line, "whole account")
    }

    func testWhitespaceAloneIsStillTheAccountWideGrant() {
        XCTAssertTrue(LogReach(scope: "   \n ").accountWide)
    }

    func testALevelIsOnlyEverTheLevelThatWasGranted() {
        XCTAssertEqual(LogReach(scope: "gym:read").levels, [.read])
        XCTAssertEqual(LogReach(scope: "gym:write").levels, [.write])
        XCTAssertEqual(LogReach(scope: "gym:delete").levels, [.delete])
        XCTAssertEqual(LogReach(scope: "gym:read gym:write").levels, [.read, .write])
        XCTAssertFalse(LogReach(scope: "gym:read gym:write").accountWide)
    }

    func testAGrantOnAnotherProductDoesNotReachTheLog() {
        let reach = LogReach(scope: "roadmap:read roadmap:write journal:read")

        XCTAssertFalse(reach.accountWide)
        XCTAssertEqual(reach.levels, [])
        XCTAssertFalse(reach.reachesTheLog)
        XCTAssertEqual(reach.line, "")
    }

    func testAnUnreadableTokenConfersNothing() {
        XCTAssertFalse(LogReach(scope: "gym").reachesTheLog)
        XCTAssertFalse(LogReach(scope: "gym:").reachesTheLog)
        XCTAssertFalse(LogReach(scope: ":read").reachesTheLog)
        XCTAssertFalse(LogReach(scope: "gym:admin").reachesTheLog)
        XCTAssertFalse(LogReach(scope: "GYM:READ").reachesTheLog)
        XCTAssertEqual(LogReach(scope: "gym:admin gym:read").levels, [.read],
                       "one unreadable token narrows itself and nothing else")
    }

    func testTheProductIsReadUpToTheLastColonAsTheServerReadsIt() {
        XCTAssertEqual(LogReach(scope: "gym:extra:read").levels, [],
                       "the product here is `gym:extra`, which is not this log")
    }

    func testTheLevelsHeldAreNamedInTheLaddersOrder() {
        XCTAssertEqual(LogReach(scope: "gym:read").line, "read")
        XCTAssertEqual(LogReach(scope: "gym:delete gym:read").line, "read · delete")
        XCTAssertEqual(LogReach(scope: "gym:delete gym:read gym:write").line, "read · write · delete")
    }

    // Three rows of facts, worded off the tool catalog: read is the eight read tools, write the
    // seven, delete the three. `workouts` is the one word, and the weigh-ins are named.
    func testTheGrantIsThreeRowsOfFacts() {
        XCTAssertEqual(LogReach.Level.allCases.map(\.label), ["Read", "Write", "Delete"])
        XCTAssertEqual(LogReach.Level.read.meta, "sets, workouts, routines, records, notes, weigh-ins")
        XCTAssertEqual(LogReach.Level.write.meta, "logs sets · adds routines · shares workouts · proposes changes")
        XCTAssertEqual(LogReach.Level.delete.meta, "discards a workout · ends a share")
    }

    func testTheScreenSaysEveryPinnedStringByteForByte() {
        XCTAssertEqual(ConnectedLog.title, "Connected log")
        XCTAssertEqual(ConnectedLog.head, "Your log, read by Claude, Cursor or Codex.")
        XCTAssertEqual(ConnectedLog.caption, "A routine change waits for your Apply; the rest lands at once.")
        XCTAssertEqual(ConnectedLog.action, "Connect a tool")
        XCTAssertEqual(ConnectedLog.signInFirst, "Sign in first")
        XCTAssertEqual(ConnectedLog.opensInBrowser, "opens in your browser")
        XCTAssertEqual(ConnectedLog.disclosure, "How this works")
        XCTAssertEqual(ConnectedLog.how, [
            "One URL pasted into your tool. Your browser opens once to approve.",
            "A shared workout is public for 30 days, until you end it.",
            "No tool can apply a proposal or edit a logged set.",
            "Delete is approved on its own, and a discard is permanent.",
            "End a connection under Settings → Connected tools; a key under API keys.",
        ])
        XCTAssertEqual(ConnectedLog.connectedHead, "Connected")
        XCTAssertEqual(ConnectedLog.unnamedGrant, "A connected tool")
        XCTAssertEqual(ConnectedLog.unnamedKey, "A static key")
        XCTAssertEqual(ConnectedLog.unread, "Couldn’t read your connections.")
        XCTAssertEqual(ConnectedLog.manage, "Manage connections")
        XCTAssertEqual(ConnectedLog.settingsUnknown, "your AI tools")
        XCTAssertEqual(ConnectedLog.settingsNone, "nothing connected yet")
        XCTAssertEqual(ConnectedLog.settingsMany(2), "2 tools")
        XCTAssertEqual(ConnectedLog.pickerLine, "A written program? Your AI tool can build it.")
    }

    // A decision surface gets forty words of chrome on first paint (`text-budget.md`); the three
    // level rows are content. 52 with them drawn, 110 with the one disclosure open, and no third layer.
    func testFirstPaintIsFiftyTwoWordsAndTheOpenDisclosureOneHundredAndTen() {
        let firstPaint = [ConnectedLog.title, ConnectedLog.head]
            + LogReach.Level.allCases.flatMap { [$0.label, $0.meta] }
            + [ConnectedLog.caption, ConnectedLog.action, ConnectedLog.disclosure]

        XCTAssertEqual(Self.words(in: firstPaint), 52)
        XCTAssertEqual(Self.words(in: firstPaint + ConnectedLog.how), 110)
    }

    func testEveryLineKeepsItsBudget() {
        XCTAssertLessThanOrEqual(Self.words(in: [ConnectedLog.title]), 3)
        XCTAssertLessThanOrEqual(Self.words(in: [ConnectedLog.head]), 12)
        XCTAssertLessThanOrEqual(Self.words(in: [ConnectedLog.caption]), 12)
        XCTAssertLessThanOrEqual(Self.words(in: [ConnectedLog.action]), 3)
        XCTAssertLessThanOrEqual(Self.words(in: [ConnectedLog.signInFirst]), 3)
        XCTAssertLessThanOrEqual(Self.words(in: [ConnectedLog.disclosure]), 3)
        XCTAssertLessThanOrEqual(Self.words(in: [ConnectedLog.manage]), 3)
        XCTAssertLessThanOrEqual(Self.words(in: [ConnectedLog.unread]), 12)
        XCTAssertLessThanOrEqual(Self.words(in: [ConnectedLog.connectedHead]), 2)
        for level in LogReach.Level.allCases {
            XCTAssertLessThanOrEqual(Self.words(in: [level.meta]), 8, level.meta)
        }
        for line in ConnectedLog.how {
            XCTAssertLessThanOrEqual(Self.words(in: [line]), 12, line)
        }
        XCTAssertLessThanOrEqual(Self.words(in: [ConnectedLog.pickerLine, ConnectedLog.action]), 15)
    }

    // A consent screen states a duration the way a reader can check it against a calendar.
    func testTheShareWindowIsANumeral() {
        XCTAssertTrue(ConnectedLog.how[1].contains("for 30 days"))
        for line in Self.everyLine {
            XCTAssertFalse(line.lowercased().contains("thirty"), line)
            XCTAssertFalse(line.contains("until it expires"), line)
        }
    }

    func testOnlyTheGrantsThatReachTheLogBecomeRows() {
        let state = ConnectedLog.state(grants: [
            ConnectedLog.Grant(clientId: "c1", name: "Claude", grantedMs: 1_000, scope: "gym:read gym:write"),
            ConnectedLog.Grant(clientId: "c2", name: "A tree tool", grantedMs: 2_000, scope: "roadmap:write"),
            ConnectedLog.Grant(clientId: "c3", name: "An old client", grantedMs: 3_000, scope: ""),
        ], keys: [])

        XCTAssertEqual(state, .connected([
            ConnectedTool(id: "c1", name: "Claude", grantedAtMs: 1_000,
                          reach: LogReach(scope: "gym:read gym:write"), credential: .approved),
            ConnectedTool(id: "c3", name: "An old client", grantedAtMs: 3_000,
                          reach: LogReach(scope: ""), credential: .approved),
        ]))
    }

    func testAStaticKeyIsAToolThatReadsThisLog() {
        let state = ConnectedLog.state(grants: [], keys: [
            ConnectedLog.Key(id: "k1", name: "laptop", createdMs: 5_000),
        ])

        XCTAssertEqual(state, .connected([
            ConnectedTool(id: "k1", name: "laptop", grantedAtMs: 5_000,
                          reach: LogReach(scope: ""), credential: .pasted),
        ]))
        XCTAssertFalse(state.invites, "the invitation is withdrawn by either door")
        XCTAssertEqual(state.settingsMeta, "laptop · whole account")
    }

    func testBothDoorsAreCountedTogether() {
        let state = ConnectedLog.state(grants: [
            ConnectedLog.Grant(clientId: "c1", name: "Claude", grantedMs: 1_000, scope: "gym:read"),
        ], keys: [
            ConnectedLog.Key(id: "k1", name: "laptop", createdMs: 5_000),
        ])

        XCTAssertEqual(state.settingsMeta, "2 tools")
    }

    // The levels it holds, then the day it was made as a date — `since 12 Aug`, never today or
    // yesterday — and never a last read.
    func testARowsMetaIsTheLevelsHeldAndTheDateItWasMade() {
        // Noon instants, so the calendar day is the same in every zone the suite runs in.
        let day: Int64 = 86_400_000
        let now = 41 * day + day / 2
        let listed = ConnectedTool(id: "c1", name: "Claude Desktop", grantedAtMs: 40 * day + day / 2,
                                   reach: LogReach(scope: "gym:delete gym:read gym:write"), credential: .approved)
        let narrow = ConnectedTool(id: "c2", name: "Cursor", grantedAtMs: now,
                                   reach: LogReach(scope: "gym:read"), credential: .approved)
        let wide = ConnectedTool(id: "c3", name: "An old client", grantedAtMs: 40 * day + day / 2,
                                 reach: LogReach(scope: ""), credential: .approved)
        let key = ConnectedTool(id: "k1", name: "laptop", grantedAtMs: 40 * day + day / 2,
                                reach: LogReach(scope: ""), credential: .pasted)

        XCTAssertEqual(listed.meta(now: now), "read · write · delete · since 10 Feb")
        XCTAssertEqual(narrow.meta(now: now), "read · since 11 Feb")
        XCTAssertEqual(wide.meta(now: now), "whole account · since 10 Feb")
        XCTAssertEqual(key.meta(now: now), "API key · whole account · since 10 Feb")
        XCTAssertEqual(listed.meta(now: 400 * day + day / 2), "read · write · delete · since 10 Feb 1970",
                       "the year is named only once it is not this one")
    }

    func testACredentialWithNoNameIsStillNamed() {
        let state = ConnectedLog.state(grants: [
            ConnectedLog.Grant(clientId: "c1", name: "  ", grantedMs: 1_000, scope: "gym:read"),
        ], keys: [
            ConnectedLog.Key(id: "k1", name: "", createdMs: 2_000),
        ])

        XCTAssertEqual(state, .connected([
            ConnectedTool(id: "c1", name: "A connected tool", grantedAtMs: 1_000,
                          reach: LogReach(scope: "gym:read"), credential: .approved),
            ConnectedTool(id: "k1", name: "A static key", grantedAtMs: 2_000,
                          reach: LogReach(scope: ""), credential: .pasted),
        ]))
    }

    func testAnAccountWithNoToolOnTheLogIsNoneAndNotUnknown() {
        XCTAssertEqual(ConnectedLog.state(grants: [], keys: []), .none)
        XCTAssertEqual(
            ConnectedLog.state(grants: [
                ConnectedLog.Grant(clientId: "c2", name: "A tree tool", grantedMs: 2_000, scope: "roadmap:read"),
            ], keys: []),
            .none)
    }

    // The settings row prints the state only: no precondition, no caption, no pitch.
    func testTheSettingsRowPrintsTheStateAndNothingElse() {
        let claude = ConnectedTool(id: "c1", name: "Claude Desktop", grantedAtMs: 0,
                                   reach: LogReach(scope: "gym:read gym:write"), credential: .approved)
        let cursor = ConnectedTool(id: "c2", name: "Cursor", grantedAtMs: 0,
                                   reach: LogReach(scope: "gym:read"), credential: .approved)

        XCTAssertEqual(ConnectedLogState.unread.settingsMeta, "your AI tools")
        XCTAssertEqual(ConnectedLogState.unknown.settingsMeta, "your AI tools")
        XCTAssertEqual(ConnectedLogState.none.settingsMeta, "nothing connected yet")
        XCTAssertEqual(ConnectedLogState.connected([claude]).settingsMeta, "Claude Desktop · read · write")
        XCTAssertEqual(ConnectedLogState.connected([claude, cursor]).settingsMeta, "2 tools")
    }

    func testTheInvitationIsOfferedUntilSomethingActuallyReachesTheLog() {
        XCTAssertTrue(ConnectedLogState.unread.invites)
        XCTAssertTrue(ConnectedLogState.unknown.invites)
        XCTAssertTrue(ConnectedLogState.none.invites)
        XCTAssertFalse(ConnectedLogState.connected([
            ConnectedTool(id: "c1", name: "Claude", grantedAtMs: 0,
                          reach: LogReach(scope: "gym:read"), credential: .approved),
        ]).invites)
    }

    // Nothing in gym is for sale, nothing in gym exports, and a product screen does not pitch a
    // feature to someone standing on it.
    func testNoWordOnTheConnectedLogSellsAnythingOrPitches() {
        let gone = ["Windmill One", "upgrade", "Upgrade", "subscribe", "Subscribe", "plan", "Plan",
                    "trial", "Trial", "$", "€", "£", "per month", "/mo", "unlock", "Unlock",
                    "premium", "Premium", "founder", "limited time", "paid", "billing",
                    "free", "Free", "CSV", "csv", "export", "Sunday", "Monday", "MCP", "ChatGPT"]
        for line in Self.everyLine {
            for word in gone {
                XCTAssertFalse(line.contains(word), "“\(word)” is on: \(line)")
            }
        }
    }

    // The word coach names the room and nothing else.
    func testTheConnectedLogNeverSaysCoach() {
        for line in Self.everyLine {
            XCTAssertFalse(line.lowercased().contains("coach"), line)
        }
    }

    func testNothingClaimsAFreshnessThisSurfaceCannotObserve() {
        for line in Self.everyLine {
            XCTAssertFalse(line.lowercased().contains("last read"), line)
            XCTAssertFalse(line.lowercased().contains("last used"), line)
            XCTAssertFalse(line.lowercased().contains("last active"), line)
        }
    }

    // `get_preferences` does not exist at any grant level: the read row's enumeration is the
    // disclosure, and nothing needs to say what is not in it. The one mention of Settings is the
    // disclosure's fifth line naming where a connection ends.
    func testNoLineClaimsAConnectionReadsHowTheGymIsSetUp() {
        for line in Self.everyLine {
            XCTAssertFalse(line.contains("how your gym is set up"), line)
            XCTAssertFalse(line.lowercased().contains("preferences"), line)
        }
        XCTAssertEqual(Self.everyLine.filter { $0.lowercased().contains("settings") }, [ConnectedLog.how[4]])
    }

    // `unread` and `unknown` both say nothing about the log, and only the second is a read that
    // failed — the state a screen may draw as a refusal.
    func testOnlyARealAnswerIsAnswered() {
        XCTAssertFalse(ConnectedLogState.unread.answered)
        XCTAssertFalse(ConnectedLogState.unknown.answered)
        XCTAssertTrue(ConnectedLogState.none.answered)
        XCTAssertTrue(ConnectedLogState.connected([
            ConnectedTool(id: "c1", name: "Claude", grantedAtMs: 0,
                          reach: LogReach(scope: "gym:read"), credential: .approved),
        ]).answered)
    }

    // A seat is read once — the launch asks from two places within a frame — every return from the
    // background and every pull refreshes, a screen pushed or popped asks nothing, a new seat reads.
    @MainActor
    func testTheWireIsReadOncePerSeatAndOnEveryReturnFromTheBackground() async {
        ConnectionsWire.reset()
        let reader = ConnectedLogReader()
        let sam = Self.seat("u1")

        async let seatTask: () = reader.read(for: sam)
        async let sceneActive: () = reader.refresh(sam)
        _ = await (seatTask, sceneActive)
        XCTAssertEqual(ConnectionsWire.fetched.sorted(), ["/v1/mcp-keys", "/v1/oauth/grants"], "a cold open fetches once")
        XCTAssertEqual(reader.state, .connected([
            ConnectedTool(id: "k1", name: "laptop", grantedAtMs: 5_000, reach: LogReach(scope: ""), credential: .pasted),
        ]))

        await reader.refresh(sam)
        XCTAssertEqual(ConnectionsWire.fetched.count, 4, "back from the background fetches")

        await reader.read(for: sam)
        XCTAssertEqual(ConnectionsWire.fetched.count, 4, "a screen pushed or popped on the same seat fetches nothing")

        await reader.refresh(sam)
        XCTAssertEqual(ConnectionsWire.fetched.count, 6, "a pull-to-refresh fetches")

        await reader.read(for: Self.seat("u2"))
        XCTAssertEqual(ConnectionsWire.fetched.count, 8, "a new seat fetches")
    }

    @MainActor
    func testTheLaunchReadsOnceWhicheverCallerFiresFirst() async {
        ConnectionsWire.reset()
        let reader = ConnectedLogReader()
        let sam = Self.seat("u1")

        async let sceneActive: () = reader.refresh(sam)
        async let seatTask: () = reader.read(for: sam)
        _ = await (sceneActive, seatTask)

        XCTAssertEqual(ConnectionsWire.fetched.sorted(), ["/v1/mcp-keys", "/v1/oauth/grants"])
    }

    @MainActor
    func testAFailedReadIsUnknownAndTheNextForegroundTriesAgain() async {
        ConnectionsWire.reset()
        ConnectionsWire.refusing = true
        let reader = ConnectedLogReader()
        let sam = Self.seat("u1")

        await reader.read(for: sam)
        XCTAssertEqual(reader.state, .unknown)
        XCTAssertEqual(ConnectionsWire.fetched.count, 2)

        ConnectionsWire.refusing = false
        await reader.read(for: sam)
        XCTAssertEqual(ConnectionsWire.fetched.count, 4, "a failed read is not an answer, so the seat reads again")
        XCTAssertEqual(reader.state, .connected([
            ConnectedTool(id: "k1", name: "laptop", grantedAtMs: 5_000, reach: LogReach(scope: ""), credential: .pasted),
        ]))
    }

    @MainActor
    func testSignedOutThereIsNoReadToMake() async {
        ConnectionsWire.reset()
        let reader = ConnectedLogReader()

        await reader.read(for: Self.seat(nil))
        await reader.refresh(Self.seat(nil))

        XCTAssertEqual(reader.state, .none)
        XCTAssertEqual(ConnectionsWire.fetched, [])
    }

    private static func seat(_ userId: String?) -> Account {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConnectionsWire.self]
        let api = WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { "secret" },
                              session: URLSession(configuration: configuration))
        return Account(api: api, user: userId.map { User(id: $0, email: "\($0)@example.com", name: "Sam") })
    }

    func testTheScreenNamesNoHost() {
        for line in Self.everyLine {
            XCTAssertFalse(line.contains("windmill.works"), line)
        }
        XCTAssertEqual(ConnectedLog.connectPath, "/#/connect")
        XCTAssertEqual(ConnectedLog.settingsPath, "/#/settings")
    }

    // Words as the brief counts them: runs of letters and digits, so `weigh-ins` is two and `·` is none.
    private static func words(in lines: [String]) -> Int {
        lines.reduce(0) { count, line in
            count + line.split { !($0.isLetter || $0.isNumber) }.count
        }
    }

    private static var everyLine: [String] {
        let day: Int64 = 86_400_000
        let approved = ConnectedTool(id: "c1", name: "Claude", grantedAtMs: 40 * day,
                                     reach: LogReach(scope: ""), credential: .approved)
        let pasted = ConnectedTool(id: "k1", name: "laptop", grantedAtMs: 41 * day,
                                   reach: LogReach(scope: "gym:read"), credential: .pasted)
        let rendered = [ConnectedLogState.unread, .unknown, .none, .connected([approved]), .connected([approved, pasted])]
            .map(\.settingsMeta)

        return LogReach.Level.allCases.flatMap { [$0.label, $0.meta] }
            + ConnectedLog.how
            + rendered
            + [approved.meta(now: 41 * day), pasted.meta(now: 41 * day)]
            + [
                ConnectedLog.title, ConnectedLog.head, ConnectedLog.caption, ConnectedLog.action,
                ConnectedLog.signInFirst, ConnectedLog.opensInBrowser, ConnectedLog.disclosure,
                ConnectedLog.connectedHead, ConnectedLog.unnamedGrant, ConnectedLog.unnamedKey,
                ConnectedLog.unread, ConnectedLog.manage, ConnectedLog.pickerLine,
            ]
    }
}

// The two reads behind the connected log, answered from a script: no grants, one static key.
final class ConnectionsWire: URLProtocol {
    static var fetched: [String] = []
    static var refusing = false

    static func reset() {
        fetched = []
        refusing = false
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let path = request.url?.path ?? ""
        Self.fetched.append(path)
        let body = path == "/v1/oauth/grants"
            ? #"{"grants":[]}"#
            : #"{"keys":[{"id":"k1","name":"laptop","createdMs":5000}]}"#
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.refusing ? 500 : 200,
                                       httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
