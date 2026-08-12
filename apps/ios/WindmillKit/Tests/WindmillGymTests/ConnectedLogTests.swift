import XCTest
@testable import WindmillGym

// THE CONNECTED LOG (§D12–13). Two things are pinned here and they are different in kind.
//
// The first is the READING OF A CREDENTIAL: what a scope string means is the backend's rule
// (backend/platform/domain/ToolScope.h) and this is gym's native copy of it, so the case that
// matters most — the empty scope is the legacy ACCOUNT-WIDE grant and not an empty one — cannot
// quietly invert on this surface. The account has TWO credential doors onto gym's tools and both
// are read, so an emptiness this screen asserts is one it actually checked.
//
// The second is the COPY, and pinning copy is unusual enough to say why. Every line on these two
// cards is a claim about what a connection can do, and the wave that wrote them deleted a price
// that named a tier gating nothing. A test that reads the words is the only thing standing between
// that decision and the next person who adds "Windmill One" back to a card because a board still
// draws it. `everyLine` is the whole of both faces — the constants, the per-level reach, the
// settings row, and the literals the connected face renders — because a guard that walked only the
// half a screen shares with the pitch would pass a chip added to the other half.
final class ConnectedLogTests: XCTestCase {
    // The one that inverts. Every token minted before scopes existed carries scope '', and it
    // reaches every product at every level — reading it as "nothing" would tell a lifter the widest
    // grant in the system holds nothing, which is the direction of this mistake that can hurt.
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

    // Three levels, and none of them implies another: `gym:write` is not `gym:read`, and above all
    // it is not `gym:delete` — the whole point of the ladder is that the destructive reach was
    // approved rather than carried along.
    func testALevelIsOnlyEverTheLevelThatWasGranted() {
        XCTAssertEqual(LogReach(scope: "gym:read").levels, [.read])
        XCTAssertEqual(LogReach(scope: "gym:write").levels, [.write])
        XCTAssertEqual(LogReach(scope: "gym:delete").levels, [.delete])
        XCTAssertEqual(LogReach(scope: "gym:read gym:write").levels, [.read, .write])
        XCTAssertFalse(LogReach(scope: "gym:read gym:write").accountWide)
    }

    // A grant for the other products is a real grant that reaches nothing here, and it is the
    // opposite answer from the empty one.
    func testAGrantOnAnotherProductDoesNotReachTheLog() {
        let reach = LogReach(scope: "roadmap:read roadmap:write journal:read")

        XCTAssertFalse(reach.accountWide)
        XCTAssertEqual(reach.levels, [])
        XCTAssertFalse(reach.reachesTheLog)
        XCTAssertEqual(reach.lines, [])
    }

    // A token this build cannot parse confers NOTHING. A typo at rest may only ever narrow a grant,
    // which is the server's own stance and has to be this one too.
    func testAnUnreadableTokenConfersNothing() {
        XCTAssertFalse(LogReach(scope: "gym").reachesTheLog)
        XCTAssertFalse(LogReach(scope: "gym:").reachesTheLog)
        XCTAssertFalse(LogReach(scope: ":read").reachesTheLog)
        XCTAssertFalse(LogReach(scope: "gym:admin").reachesTheLog)
        XCTAssertFalse(LogReach(scope: "GYM:READ").reachesTheLog)
        XCTAssertEqual(LogReach(scope: "gym:admin gym:read").levels, [.read],
                       "one unreadable token narrows itself and nothing else")
    }

    // The product is everything before the LAST colon, because that is where the server splits it.
    func testTheProductIsReadUpToTheLastColonAsTheServerReadsIt() {
        XCTAssertEqual(LogReach(scope: "gym:extra:read").levels, [],
                       "the product here is `gym:extra`, which is not this log")
    }

    // WHAT A ROW SAYS IS ONE LINE PER LEVEL, IN THE LADDER'S ORDER rather than a Set's — so a
    // connection's whole reach is on its own card and not summarised into the half that flatters it.
    func testTheRowNamesEveryLevelTheGrantHoldsInTheLaddersOrder() {
        XCTAssertEqual(LogReach(scope: "gym:read").lines, [LogReach.Level.read.reach])
        XCTAssertEqual(LogReach(scope: "gym:delete gym:read").lines,
                       [LogReach.Level.read.reach, LogReach.Level.delete.reach])
        XCTAssertEqual(LogReach(scope: "gym:delete gym:read gym:write").lines,
                       LogReach.Level.allCases.map(\.reach))
    }

    // THE TWO CAPABILITIES A CARD THAT FLATTERED THE FEATURE WOULD LEAVE OUT, and both hand a
    // lifter's data somewhere. `share_session` is Access::write in
    // backend/products/gym/adapters/mcp/GymToolCatalog.cpp — "anyone holding it can read that
    // workout and its sets without signing in" — so `gym:write` must say it mints a link;
    // `discard_session` is Access::del and permanent, so `gym:delete` must say it destroys a
    // workout. It is the same vocabulary the web puts on the consent page (LEVEL_LINES in
    // web/src/products/gym/connect/connect.js), because one grant may not read two ways.
    func testTheWriteAndDeleteLevelsNameTheToolsThatLeaveTheAccount() {
        XCTAssertTrue(LogReach.Level.write.reach.contains("shares one workout by link"))
        XCTAssertTrue(LogReach.Level.write.reach.contains("readable by anyone holding it"))
        XCTAssertTrue(LogReach.Level.write.reach.contains("adds a movement, or a day the program does not have yet"))
        XCTAssertTrue(LogReach.Level.delete.reach.contains("Discards a whole workout and every set in it, permanently"))
        XCTAssertTrue(LogReach.Level.delete.reach.contains("ends a share link"))
        XCTAssertTrue(ConnectedLog.canLines.contains { $0.contains("Share one workout by link") })
    }

    // The grant list is filtered to this log and nothing else: a roadmap tool is a real connection on
    // this account and is not a tool that reads a training log.
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

    // THE SECOND CREDENTIAL DOOR, and the reason this screen reads twice. A static MCP key resolves
    // at the same bearer check as an OAuth token (McpHttpEndpoint hands the header to McpKeyService
    // when OAuthService declines it), reaches every gym tool — `mcp_keys.scope` defaults to '' and
    // nothing in the backend ever writes it — and appears in no grant list. An account read daily by
    // one is a CONNECTED account, and saying "no tool reads this log yet" over it would be a false
    // assertion rather than a missing row.
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

    // A row names WHICH door it came through, because the two are ended in different places — an
    // approved grant under the account's connected tools, a key beside the keys.
    func testARowSaysWhichDoorTheCredentialCameThrough() {
        XCTAssertEqual(ConnectedTool.Credential.approved.line,
                       "approved in your browser · ended under Connected tools")
        XCTAssertEqual(ConnectedTool.Credential.pasted.line,
                       "a static key you pasted · ended under API keys")
    }

    // `client_name` is '' for a client that registered without one, and a row with a blank where the
    // name goes reads as a rendering fault rather than as an unnamed tool. Naming a key is optional
    // at the mint, so an unnamed one is ordinary — and it still gets a noun.
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

    // THE THREE ANSWERS ARE NOT TWO. A read that did not come back says nothing — the settings row
    // draws no line at all rather than denying a connection that may be live this second.
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

    // The invitation is not a claim about the state, so a failed read may not silence it — and a log
    // something already reads may not carry it. It is the same value the opening picker's card and
    // the Routines card are both handed, so neither can outlive the other.
    func testTheInvitationIsOfferedUntilSomethingActuallyReachesTheLog() {
        XCTAssertTrue(ConnectedLogState.unknown.invites)
        XCTAssertTrue(ConnectedLogState.none.invites)
        XCTAssertFalse(ConnectedLogState.connected([
            ConnectedTool(id: "c1", name: "Claude", grantedAtMs: 0,
                          reach: LogReach(scope: "gym:read"), credential: .approved),
        ]).invites)
    }

    // NOTHING ON THESE CARDS NAMES A PRICE, A TIER OR A LOCK. Windmill One gates nothing in gym, is
    // read nowhere in this product, and cannot be bought — `paidPlansOpen()` is a hardcoded false
    // and BillingApi 503s — so a word from that vocabulary here would point a tap at a checkout that
    // answers 503.
    func testNoWordOnTheConnectedLogSellsAnything() {
        // No "pro" in the list, and that is the one word this test cannot ask for: it is inside
        // `proposes`, `proposal` and `program`, which are three of the truest words on these cards.
        let sold = ["Windmill One", "upgrade", "Upgrade", "subscribe", "Subscribe", "plan", "Plan",
                    "trial", "Trial", "$", "€", "£", "per month", "/mo", "unlock", "Unlock",
                    "premium", "Premium", "founder", "limited time", "paid", "billing"]
        for line in Self.everyLine {
            for word in sold {
                XCTAssertFalse(line.contains(word), "“\(word)” is sold on: \(line)")
            }
        }
    }

    // Where the price was, what is TRUE — and stated flatly, with no countdown and no "for now"
    // beside it, because manufactured urgency is the thing this brand refuses first.
    func testWhereThePriceWasTheCardSaysConnectingIsFree() {
        XCTAssertTrue(ConnectedLog.free.hasPrefix("Connecting your log is free."))
        XCTAssertTrue(ConnectedLog.inviteLine.contains("Connecting is free."))
        for line in Self.everyLine {
            XCTAssertFalse(line.contains("free for now"), line)
            XCTAssertFalse(line.contains("for a limited"), line)
        }
    }

    // §D13 draws `connected · read 2h ago`. Nothing records a last READ per connection — the grant
    // keeps a last-USED that writes advance too — so no line on this surface claims one.
    func testNothingClaimsAFreshnessThisSurfaceCannotObserve() {
        for line in Self.everyLine {
            XCTAssertFalse(line.contains("read 2h"), line)
            XCTAssertFalse(line.lowercased().contains("last read"), line)
            XCTAssertFalse(line.lowercased().contains("last active"), line)
        }
    }

    // THE THREE THAT ARE PROPERTIES OF THE TOOL CATALOG. There is no apply tool at any grant level,
    // both destructive changes to the program mint a proposal, and nothing anywhere edits a set that
    // is already logged — so the card may promise all three by name.
    func testTheNeverPanelPromisesTheThreeThingsTheToolCatalogActuallyRefuses() {
        XCTAssertEqual(ConnectedLog.neverLines.count, 3)
        XCTAssertTrue(ConnectedLog.neverLines[0].contains("no apply tool at any grant level"))
        XCTAssertTrue(ConnectedLog.neverLines[1].contains("arrive as a proposal"))
        XCTAssertTrue(ConnectedLog.neverLines[2].contains("Edit a set you already logged"))
    }

    // The bullet §D writes as "It reads. It proposes. It never writes to your program." is not true —
    // `create_routine` lands a day the program does not have yet, immediately — so the card promises
    // the thing that IS true, that a day already standing waits for the tap. The delete level is
    // named where it belongs rather than hidden: a connection that asked for it can discard a
    // workout outright.
    func testThePitchDoesNotPromiseThatNothingIsEverWritten() {
        for line in Self.everyLine {
            XCTAssertFalse(line.contains("never writes"), line)
        }
        XCTAssertTrue(ConnectedLog.bullets[1].contains("never changes until you tap Apply"))
        XCTAssertTrue(ConnectedLog.canLines.contains { $0.contains("add a movement or a day") })
        XCTAssertTrue(ConnectedLog.canLines.contains { $0.contains("Discard a whole workout") })
    }

    // A GRANT CAN NAME TWO PRODUCTS AND NOT THREE. The tool surface is roadmap + gym — `mcpModules`
    // in backend/platform/infra/main.cpp, with `scopes_supported` derived from that same composite —
    // so journal has no tool for a grant to reach, and the bullet says what a grant names rather
    // than implying all three are on the consent screen.
    func testTheAccountBulletDoesNotPromiseAGrantJournalCannotName() {
        XCTAssertTrue(ConnectedLog.bullets[2].contains("One account across all three Windmill products"))
        XCTAssertTrue(ConnectedLog.bullets[2].contains("this log, your roadmap, or both"))
        XCTAssertFalse(ConnectedLog.bullets[2].contains("which of them"))
    }

    // The precondition names the tools windmill.works/connect can hand a recipe to. §D says "Claude
    // or ChatGPT"; the connect page carries Claude Desktop, Claude Code, Cursor, Codex and any MCP
    // client, and nothing for ChatGPT.
    func testThePreconditionNamesOnlyToolsTheConnectPageHasARecipeFor() {
        XCTAssertTrue(ConnectedLog.precondition.contains("Claude, Cursor, Codex"))
        XCTAssertTrue(ConnectedLog.precondition.contains("speaks MCP"))
        XCTAssertTrue(ConnectedLog.precondition.contains("the log stays free regardless"))
        XCTAssertFalse(ConnectedLog.precondition.contains("ChatGPT"))
    }

    // Every clause of the ending line is the code's: revoking a grant drops it and every token
    // minted under it in one transaction (PgOAuthRepository::revokeGrant), revoking a key deletes
    // its row (PgMcpKeyRepository::revoke), and a proposal belongs to the account rather than to the
    // connection that wrote it. It NAMES NO HOST — every door in this room resolves against the
    // account's own base URL, so a debug build points at its own server.
    func testTheEndingLineSaysWhatRevokingActuallyDoesAndNamesNoHost() {
        XCTAssertTrue(ConnectedLog.ending.contains("an approved connection under Connected tools"))
        XCTAssertTrue(ConnectedLog.ending.contains("a static key under API keys"))
        XCTAssertTrue(ConnectedLog.ending.contains("stops its reads immediately"))
        XCTAssertTrue(ConnectedLog.ending.contains("every proposal already in your history stays"))
        for line in Self.everyLine {
            XCTAssertFalse(line.contains("windmill.works"), line)
        }
    }

    // EVERY LINE ON BOTH FACES, and the connected face's own literals are in it — the title, the
    // count, the instant's label, the credential note, the web door and the settings row. The build
    // this replaced pinned only the pitch's constants, so a chip added to the connected face would
    // have passed the guard above green.
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
