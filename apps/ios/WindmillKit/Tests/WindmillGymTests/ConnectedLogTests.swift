import XCTest
@testable import WindmillGym

final class ConnectedLogTests: XCTestCase {
    func testTheEmptyScopeIsTheAccountWideGrantAndNotAnEmptyOne() {
        let reach = LogReach(scope: "")

        XCTAssertTrue(reach.accountWide)
        XCTAssertEqual(reach.levels, Set(LogReach.Level.allCases))
        XCTAssertTrue(reach.reachesTheLog)
        XCTAssertEqual(reach.lines, LogReach.Level.allCases.map(\.reach))
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
        XCTAssertEqual(reach.lines, [])
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

    func testTheRowNamesEveryLevelTheGrantHoldsInTheLaddersOrder() {
        XCTAssertEqual(LogReach(scope: "gym:read").lines, [LogReach.Level.read.reach])
        XCTAssertEqual(LogReach(scope: "gym:delete gym:read").lines,
                       [LogReach.Level.read.reach, LogReach.Level.delete.reach])
        XCTAssertEqual(LogReach(scope: "gym:delete gym:read gym:write").lines,
                       LogReach.Level.allCases.map(\.reach))
    }

    func testTheWriteAndDeleteLevelsNameTheToolsThatLeaveTheAccount() {
        XCTAssertTrue(LogReach.Level.write.reach.contains("shares one workout by link"))
        XCTAssertTrue(LogReach.Level.write.reach.contains("readable by anyone holding it"))
        XCTAssertTrue(LogReach.Level.write.reach.contains("adds a movement, or a day the program does not have yet"))
        XCTAssertTrue(LogReach.Level.delete.reach.contains("Discards a whole workout and every set in it, permanently"))
        XCTAssertTrue(LogReach.Level.delete.reach.contains("ends a share link"))
        XCTAssertTrue(ConnectedLog.canLines.contains { $0.contains("Share one workout by link") })
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
        XCTAssertEqual(state.settingsLine(now: 5_000), "laptop · connected today")
    }

    func testBothDoorsAreCountedTogether() {
        let state = ConnectedLog.state(grants: [
            ConnectedLog.Grant(clientId: "c1", name: "Claude", grantedMs: 1_000, scope: "gym:read"),
        ], keys: [
            ConnectedLog.Key(id: "k1", name: "laptop", createdMs: 5_000),
        ])

        XCTAssertEqual(state.settingsLine(now: 5_000), "2 tools read this log")
        XCTAssertEqual(ConnectedLog.count(2), "2 tools read this log")
    }

    func testARowSaysWhichDoorTheCredentialCameThrough() {
        XCTAssertEqual(ConnectedTool.Credential.approved.line,
                       "approved in your browser · ended under Connected tools")
        XCTAssertEqual(ConnectedTool.Credential.pasted.line,
                       "a static key you pasted · ended under API keys")
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

    func testAReadThatDidNotComeBackSaysNothingUnderTheSettingsRow() {
        XCTAssertNil(ConnectedLogState.unknown.settingsLine(now: 0))
        XCTAssertEqual(ConnectedLogState.none.settingsLine(now: 0), "no tool reads this log yet")
    }

    func testTheSettingsRowNamesOneToolAndCountsMore() {
        let day: Int64 = 86_400_000
        let claude = ConnectedTool(id: "c1", name: "Claude", grantedAtMs: 40 * day,
                                   reach: LogReach(scope: "gym:read"), credential: .approved)
        let cursor = ConnectedTool(id: "c2", name: "Cursor", grantedAtMs: 41 * day,
                                   reach: LogReach(scope: "gym:read"), credential: .approved)

        XCTAssertEqual(ConnectedLogState.connected([claude]).settingsLine(now: 40 * day),
                       "Claude · connected today")
        XCTAssertEqual(ConnectedLogState.connected([claude, cursor]).settingsLine(now: 41 * day),
                       "2 tools read this log")
    }

    func testTheInvitationIsOfferedUntilSomethingActuallyReachesTheLog() {
        XCTAssertTrue(ConnectedLogState.unknown.invites)
        XCTAssertTrue(ConnectedLogState.none.invites)
        XCTAssertFalse(ConnectedLogState.connected([
            ConnectedTool(id: "c1", name: "Claude", grantedAtMs: 0,
                          reach: LogReach(scope: "gym:read"), credential: .approved),
        ]).invites)
    }

    func testNoWordOnTheConnectedLogSellsAnything() {
        let sold = ["Windmill One", "upgrade", "Upgrade", "subscribe", "Subscribe", "plan", "Plan",
                    "trial", "Trial", "$", "€", "£", "per month", "/mo", "unlock", "Unlock",
                    "premium", "Premium", "founder", "limited time", "paid", "billing"]
        for line in Self.everyLine {
            for word in sold {
                XCTAssertFalse(line.contains(word), "“\(word)” is sold on: \(line)")
            }
        }
    }

    func testWhereThePriceWasTheCardSaysConnectingIsFree() {
        XCTAssertTrue(ConnectedLog.free.hasPrefix("Connecting your log is free."))
        XCTAssertTrue(ConnectedLog.inviteLine.contains("Connecting is free."))
        for line in Self.everyLine {
            XCTAssertFalse(line.contains("free for now"), line)
            XCTAssertFalse(line.contains("for a limited"), line)
        }
    }

    // The word coach names the room and nothing else; the pitch contrasts on where the log lives, not on quality.
    func testTheConnectPitchNeverSaysCoach() {
        for line in Self.everyLine {
            XCTAssertFalse(line.lowercased().contains("coach"), line)
        }
        XCTAssertEqual(ConnectedLog.sub,
                       "Not a chat in another tab. The twelve weeks of squats you already logged, readable by the assistant you already use.")
        XCTAssertTrue(ConnectedLog.free.contains("the workout share and the CSV"), ConnectedLog.free)
    }

    func testNothingClaimsAFreshnessThisSurfaceCannotObserve() {
        for line in Self.everyLine {
            XCTAssertFalse(line.contains("read 2h"), line)
            XCTAssertFalse(line.lowercased().contains("last read"), line)
            XCTAssertFalse(line.lowercased().contains("last active"), line)
        }
    }

    // `get_preferences` does not exist at any grant level and nothing replaced it: the rest target and
    // the reading unit are the lifter's own dials, not context a connection can fetch.
    func testNoLineOnTheConsentSurfaceClaimsAConnectionReadsHowTheGymIsSetUp() {
        for line in Self.everyLine {
            XCTAssertFalse(line.contains("how your gym is set up"), line)
            XCTAssertFalse(line.contains("preferences"), line)
        }
    }

    func testTheNeverPanelPromisesTheThreeThingsTheToolCatalogActuallyRefuses() {
        XCTAssertEqual(ConnectedLog.neverLines.count, 3)
        XCTAssertTrue(ConnectedLog.neverLines[0].contains("no apply tool at any grant level"))
        XCTAssertTrue(ConnectedLog.neverLines[1].contains("arrive as a proposal"))
        XCTAssertTrue(ConnectedLog.neverLines[2].contains("Edit a set you already logged"))
    }

    func testThePitchDoesNotPromiseThatNothingIsEverWritten() {
        for line in Self.everyLine {
            XCTAssertFalse(line.contains("never writes"), line)
        }
        XCTAssertTrue(ConnectedLog.bullets[1].contains("never changes until you tap Apply"))
        XCTAssertTrue(ConnectedLog.canLines.contains { $0.contains("add a movement or a day") })
        XCTAssertTrue(ConnectedLog.canLines.contains { $0.contains("Discard a whole workout") })
    }

    func testTheAccountBulletDoesNotPromiseAGrantJournalCannotName() {
        XCTAssertTrue(ConnectedLog.bullets[2].contains("One account across all three Windmill products"))
        XCTAssertTrue(ConnectedLog.bullets[2].contains("this log, your roadmap, or both"))
        XCTAssertFalse(ConnectedLog.bullets[2].contains("which of them"))
    }

    func testThePreconditionNamesOnlyToolsTheConnectPageHasARecipeFor() {
        XCTAssertTrue(ConnectedLog.precondition.contains("Claude, Cursor, Codex"))
        XCTAssertTrue(ConnectedLog.precondition.contains("speaks MCP"))
        XCTAssertTrue(ConnectedLog.precondition.contains("the log stays free regardless"))
        XCTAssertFalse(ConnectedLog.precondition.contains("ChatGPT"))
    }

    func testTheEndingLineSaysWhatRevokingActuallyDoesAndNamesNoHost() {
        XCTAssertTrue(ConnectedLog.ending.contains("an approved connection under Connected tools"))
        XCTAssertTrue(ConnectedLog.ending.contains("a static key under API keys"))
        XCTAssertTrue(ConnectedLog.ending.contains("stops its reads immediately"))
        XCTAssertTrue(ConnectedLog.ending.contains("every proposal already in your history stays"))
        for line in Self.everyLine {
            XCTAssertFalse(line.contains("windmill.works"), line)
        }
    }

    private static var everyLine: [String] {
        let day: Int64 = 86_400_000
        let approved = ConnectedTool(id: "c1", name: "Claude", grantedAtMs: 40 * day,
                                     reach: LogReach(scope: ""), credential: .approved)
        let pasted = ConnectedTool(id: "k1", name: "laptop", grantedAtMs: 41 * day,
                                   reach: LogReach(scope: "gym:read"), credential: .pasted)
        let rendered = [ConnectedLogState.none, .connected([approved]), .connected([approved, pasted])]
            .compactMap { $0.settingsLine(now: 41 * day) }

        return ConnectedLog.bullets + ConnectedLog.canLines + ConnectedLog.neverLines
            + LogReach.Level.allCases.map(\.reach)
            + ConnectedTool.Credential.allCases.map(\.line)
            + rendered
            + [ConnectedLog.count(1), ConnectedLog.count(2), ConnectedLog.since(0, now: 41 * day)]
            + [
                ConnectedLog.headline, ConnectedLog.sub, ConnectedLog.sundayHead, ConnectedLog.sunday,
                ConnectedLog.mondayHead, ConnectedLog.monday, ConnectedLog.precondition,
                ConnectedLog.action, ConnectedLog.accountFirst, ConnectedLog.desk, ConnectedLog.free,
                ConnectedLog.canTitle, ConnectedLog.neverTitle, ConnectedLog.ending,
                ConnectedLog.inviteTitle, ConnectedLog.inviteLine, ConnectedLog.inviteAction,
                ConnectedLog.unread, ConnectedLog.stateTitle, ConnectedLog.nothingReadsIt,
                ConnectedLog.settingsFallback, ConnectedLog.accountWide, ConnectedLog.webDoor,
            ]
    }
}
