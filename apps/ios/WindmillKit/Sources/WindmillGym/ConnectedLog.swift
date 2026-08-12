import SwiftUI
import WindmillPlatform

// THE CONNECTED LOG (§D screens 12 and 13) — the lifter's OWN assistant, reading the log they
// already keep. On this phone it is an INVITATION and never a gate, and that is the wave's ruling
// rather than a softening of the board.
//
// §D sells it as "The log is free. The connected log is Windmill One." That sentence is retired by
// the build, three ways: gym's MCP tools read no entitlement and never did, Ask ships open behind a
// stated daily cap so `hasWindmillOne` is read NOWHERE in this product, and Windmill One cannot be
// bought at all — `paidPlansOpen()` is a hardcoded false and `BillingApi` 503s while no price id is
// configured. A price here would name a tier that gates nothing, sold by a button that lands on a
// checkout answering 503. So the pitch stays and the price goes: where the price was, this file
// says the true thing, which is that connecting is free. Not free for now, no countdown, no
// founder's rate — those are the manufactured urgency this brand refuses.
//
// WHAT IS WORTH DRAWING IS THE EXCHANGE: the sentence you type in your own tool on Sunday and the
// object that lands in gym on Monday. Then the precondition, out loud, before anybody spends an
// evening on it.
//
// TWO THINGS §D DRAWS THAT THIS FILE DOES NOT:
//   · `connected · read 2h ago`. NOTHING RECORDS A LAST READ PER CONNECTION. `oauth_grants` keeps a
//     last-USED that every authenticated call advances, throttled to a minute — a different claim,
//     and one made by writes as well as reads. A card that invented a freshness it cannot observe is
//     the same defect as a receipt counting rows it never served. The row says `connected` and the
//     day it was granted, and both of those are stored.
//   · `Disconnect Claude`. Consent, the client list and the revoke are the SHELL's, once, on the
//     web — a second door onto one decision is how two surfaces come to disagree about who may read
//     a log. This screen names where it happens instead of rebuilding it.
//
// CONNECTING ITSELF IS A DESK ACT and the copy says so: you paste one address into a tool that runs
// on a computer. The phone's share is the invitation and the state, which is why the primary action
// here opens the page that holds the recipes rather than pretending to be it.
//
// THE STATE IS READ FROM BOTH CREDENTIAL DOORS, not from the OAuth grants alone — see `read`. An
// account whose only reader is a static MCP key is a connected account, and a screen that asked one
// of the two questions would be asserting an emptiness it never checked.

// What one grant reaches IN GYM, read from the OAuth scope string — the native mirror of
// web/src/shell/auth/scopes.js over backend/platform/domain/ToolScope.h, including the three cases
// it is easy to collapse and must not: the EMPTY scope is the legacy account-wide grant (every token
// minted before scopes existed carries it), a token nobody can parse confers NOTHING, and those two
// are opposite answers — telling somebody a grant holds nothing when it holds everything is the lie
// that matters. Levels never imply each other: `gym:write` is not `gym:read`, and above all not
// `gym:delete`.
struct LogReach: Equatable, Sendable {
    enum Level: String, CaseIterable, Sendable {
        case read
        case write
        case delete

        // WHAT THE LEVEL BUYS, AND EVERY CLAUSE IS A TOOL IN THE CATALOG
        // (backend/products/gym/adapters/mcp/GymToolCatalog.cpp):
        //
        //   read    list_exercises · list_sessions · get_session · last_time · list_routines ·
        //           get_stats · get_preferences
        //   write   start_session · log_set · finish_session · create_routine ·
        //           propose_routine_change · create_exercise · share_session
        //   delete  discard_session · propose_routine_removal · revoke_share
        //
        // It is the SAME VOCABULARY the web half of this wave puts on the consent page
        // (web/src/products/gym/connect/connect.js LEVEL_LINES), because a grant that read one way
        // where it was approved and another in the room would be two descriptions of one approval.
        // In particular `write` names the day it adds and the LINK IT CAN MINT — share_session hands
        // one workout to anyone holding the URL, without a sign-in — rather than only the half that
        // waits for a tap, and `delete` names the workout it can destroy outright.
        var reach: String {
            switch self {
            case .read:
                return "Reads your log — sets, workouts, routines, records, and how your gym is set up."
            case .write:
                return """
                    Records what you lift · adds a movement, or a day the program does not have yet · \
                    proposes a change to a day that already stands · shares one workout by link, \
                    readable by anyone holding it until it expires.
                    """
            case .delete:
                return """
                    Discards a whole workout and every set in it, permanently · ends a share link · \
                    proposes taking a day out.
                    """
            }
        }
    }

    let levels: Set<Level>
    let accountWide: Bool

    init(scope: String) {
        let tokens = scope.split(whereSeparator: \.isWhitespace)
        guard !tokens.isEmpty else {
            levels = Set(Level.allCases)
            accountWide = true
            return
        }
        accountWide = false
        levels = Set(tokens.compactMap { token -> Level? in
            // The LAST colon, not the first: that is where the server splits a token, and a second
            // opinion about it here is how one grant comes to read two ways.
            guard let colon = token.lastIndex(of: ":"), colon != token.startIndex else { return nil }
            guard token[token.startIndex..<colon] == "gym" else { return nil }
            return Level(rawValue: String(token[token.index(after: colon)...]))
        })
    }

    var reachesTheLog: Bool {
        accountWide || !levels.isEmpty
    }

    // What THIS grant reaches here, one line per level it holds, in the ladder's order rather than a
    // Set's. A row lists exactly the levels that were approved, so nobody meets a capability of their
    // own connection for the first time as a surprise.
    var lines: [String] {
        Level.allCases.filter(levels.contains).map(\.reach)
    }
}

// One credential that reaches the training log. THERE ARE TWO DOORS ONTO GYM'S TOOLS and this type
// carries which one, because they are ended in different places: an OAuth grant is approved in a
// browser and revoked under the account's connected tools, and a static MCP key is pasted by hand
// and revoked beside the keys. `grantedAtMs` is the day the credential came into being and is the
// only instant on this card — for a grant it is set once and kept as the earliest across every
// refresh, so it is a fact rather than an impression.
struct ConnectedTool: Equatable, Identifiable, Sendable {
    enum Credential: String, CaseIterable, Equatable, Sendable {
        case approved
        case pasted

        // WHERE IT IS ENDED IS THE HALF THAT DIFFERS, and both are sections of one settings page:
        // web/src/shell/settings/SettingsPage.jsx renders `ConnectedToolsSection` (title "Connected
        // tools") and `ApiKeysSection` (title "API keys"), and each revokes its own kind.
        var line: String {
            switch self {
            case .approved: return "approved in your browser · ended under Connected tools"
            case .pasted: return "a static key you pasted · ended under API keys"
            }
        }
    }

    let id: String
    let name: String
    let grantedAtMs: Int64
    let reach: LogReach
    let credential: Credential
}

// THREE ANSWERS AND NOT TWO. A read that did not come back is not an empty account — it is a thing
// this phone does not know, and the row it feeds says nothing at all rather than denying a
// connection that may be live. `none` is a real answer: signed out there is no account for a grant
// to hang on, and signed in it means the log the account holds is read by nobody.
enum ConnectedLogState: Equatable {
    case unknown
    case none
    case connected([ConnectedTool])

    // The line under §I's `Connected log` row. One tool is named with the day it was granted; more
    // than one is counted, because a settings row is one line and a list of names would take the
    // row's own title off the screen.
    func settingsLine(now: Int64) -> String? {
        switch self {
        case .unknown:
            return nil
        case .none:
            return ConnectedLog.nothingReadsIt
        case .connected(let tools):
            guard tools.count == 1, let only = tools.first else {
                return ConnectedLog.count(tools.count)
            }
            return "\(only.name) · \(ConnectedLog.since(only.grantedAtMs, now: now))"
        }
    }

    // Whether the room offers the invitation, and `unknown` offers it: an invitation is not a claim
    // about state, so a read that did not land may not silence it. Nothing counts how many times it
    // was passed over.
    var invites: Bool {
        guard case .connected = self else { return true }
        return false
    }
}

enum ConnectedLog {
    // §D12's headline. The phone says it about Claude because that is the tool the connect page
    // opens on; the precondition names the whole list rather than leaving it implied.
    static let headline = "Your training log, inside your own Claude."

    static let sub = """
        Not a coach in a chat tab. The twelve weeks of squats you already logged, readable by the \
        assistant you already use.
        """

    static let sundayHead = "Sunday, in Claude"

    static let sunday = """
        “Look at my last twelve weeks of bench. Write me a four-week block — heavier triples, and \
        swap the flies for incline work.”
        """

    static let mondayHead = "Monday, in gym"

    static let monday = "A proposal on Push A · 4 changes. You read it, you tap Apply, you train."

    // THREE BULLETS, CHECKED AGAINST THE TOOL CATALOG RATHER THAN AGAINST THE BOARD. §D's second one
    // reads "It reads. It proposes. It never writes to your program", and that one is not true:
    // `create_routine` lands a day the program does not have yet, immediately, and the catalog says
    // so in its own description — a day that did not exist takes nothing away. What IS true, and is
    // the promise worth making, is that a day already standing never moves without the tap.
    //
    // The third one says what a grant NAMES rather than what it covers. The tool surface is built
    // from two products — `mcpModules` in backend/platform/infra/main.cpp is roadmap and gym, and
    // `scopes_supported` is derived from that composite — so journal has no tools for a grant to
    // reach, and a bullet promising the grant names all three would name one it cannot.
    static let bullets = [
        "Nothing to install and no tokens to buy — you paste one address, and the first connect opens your browser to approve.",
        "It reads your log and proposes. A day of your program that already stands never changes until you tap Apply.",
        "One account across all three Windmill products, and a grant names what it reaches: this log, your roadmap, or both.",
    ]

    // THE MOST HONEST LINE ON THE BOARD, kept — with the tools windmill.works/connect can actually
    // hand a recipe to. §D says "a Claude or ChatGPT account you already have"; the connect page
    // carries Claude Desktop, Claude Code, Cursor, Codex and any MCP client, and nothing for
    // ChatGPT, so this does not promise one. Ask's own free-door paragraph names the same list, for
    // the same reason and out of the same page — see Ask.freeDoor, which walks the lifter here.
    static let precondition = """
        Needs an assistant you already use — Claude, Cursor, Codex, or anything else that speaks \
        MCP. If you use none of them, this one is not for you yet, and the log stays free regardless.
        """

    static let action = "How to connect"

    // Signed out the door is the account's, because there is nothing for a grant to hang on yet —
    // the same branch the opening picker's card takes, and it says which door it is opening.
    static let accountFirst = "This one needs an account"

    static let desk = """
        It takes a minute at a computer: paste one address into your tool, approve it in the \
        browser, and it is connected.
        """

    // WHERE THE PRICE WAS. Every line of it is true of this build: nothing in gym reads an
    // entitlement, and no surface offers a checkout.
    static let free = """
        Connecting your log is free. So is the rest of this room — logging, history, routines, the \
        coach link and the CSV.
        """

    static let canTitle = "What a connection can do"

    // THE WIDEST A GRANT CAN BE, so nobody meets one of these for the first time as a surprise. Two
    // of them are the ones a card that flattered the feature would leave out, and they are the two
    // that hand a lifter's data somewhere: the LINK, which `gym:write` can mint and which anybody
    // holding it reads without signing in, and the DISCARD, which is the delete level and the reason
    // the ladder exists — it is asked for separately and shown separately, and `gym:write` never
    // carries it.
    static let canLines = [
        "Read what you have logged — sets, sessions, routines, records, and how your gym is set up.",
        "Record what you lift, and add a movement or a day the program does not have yet.",
        "Propose a change to a day that already stands, or propose taking one out.",
        "Share one workout by link — a page anyone holding that link can read without signing in, until it expires or you end it.",
        "Discard a whole workout — only if it asks for that and you allow it, and you see what it asked for before you do.",
    ]

    static let neverTitle = "What it can never do"

    // ALL THREE ARE PROPERTIES OF THE TOOL CATALOG, not promises this screen makes on its behalf:
    // there is no apply tool at any grant level, both destructive changes to the program mint a
    // proposal instead, and nothing anywhere edits a set that is already logged.
    static let neverLines = [
        "Apply a proposal. There is no apply tool at any grant level — the diff waits on the routine until you tap it.",
        "Change or remove a day of your program by itself. Both arrive as a proposal and wait.",
        "Edit a set you already logged. No tool on a connection rewrites what you lifted.",
    ]

    // THE CONNECTED FACE'S OWN WORDS, kept here with the rest rather than inline in the view, so the
    // one test that reads every line of copy on these two cards actually reads every line of it.
    static let stateTitle = "Connected log"

    static func count(_ tools: Int) -> String {
        tools == 1 ? "one tool reads this log" : "\(tools) tools read this log"
    }

    static func since(_ ms: Int64, now: Int64) -> String {
        "connected \(Readout.when(ms, now: now))"
    }

    static let nothingReadsIt = "no tool reads this log yet"

    // The line the settings row falls back to when the read did not come back. A door is a place to
    // go rather than a claim, so it describes the destination and denies no connection.
    static let settingsFallback = "what your own assistant can read here, and what it can never do"

    // Said on a row whose credential is the legacy account-wide one. The levels above are gym's
    // three; this is the half of that grant which is not a training log at all.
    static let accountWide = """
        Approved for your whole account rather than for this log alone — every level here is on, and \
        so is everything outside gym.
        """

    static let webDoor = "Your connections, on the web"

    // Where a connection ends, and what ending it does. Every clause is the code's: revoking a grant
    // drops it AND every token minted under it in one transaction (PgOAuthRepository::revokeGrant),
    // revoking a key deletes its row (PgMcpKeyRepository::revoke), both credentials are re-resolved
    // against the database on every single call, and a proposal belongs to the account rather than
    // to the connection that wrote it, so history keeps every one of them.
    //
    // IT NAMES NO HOST. Every door in this room resolves against the account's own base URL, so a
    // debug build points at its own server — a sentence that said windmill.works would be the one
    // place on the screen that did not.
    static let ending = """
        Connections are made and ended on the web: the connect page carries the recipe for each \
        tool, and your account settings end either kind — an approved connection under Connected \
        tools, a static key under API keys. Ending one stops its reads immediately, and every \
        proposal already in your history stays.
        """

    // The card Routines carries. It is the same offer in two sentences, and it wears no lock, no
    // chip and no price, because nothing here is withheld.
    static let inviteTitle = "Your program, read by the assistant you already use."

    static let inviteLine = """
        Ask it on Sunday for a four-week block; the proposal is waiting on the routine on Monday. \
        Connecting is free.
        """

    static let inviteAction = "How it works →"

    // The one line a failed read is allowed to say. It denies nothing and asserts nothing — the
    // invitation under it stands either way, because it was never a claim about the state.
    static let unread = "this phone couldn’t read your connections just now"

    // One row of `GET /v1/oauth/grants`, kept to what gym has a use for. `lastUsedMs` is on the wire
    // and is deliberately not decoded: see the head of this file — it is a last-USED and the card
    // would be read as a last-READ.
    struct Grant: Decodable, Equatable {
        let clientId: String
        let name: String
        let grantedMs: Int64
        let scope: String

        // `client_name` is empty for a client that registered without one, and a row with a blank
        // where the name goes reads as a rendering fault rather than as an unnamed tool.
        var named: String {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "A connected tool" : trimmed
        }
    }

    // One row of `GET /v1/mcp-keys`. The endpoint serves no scope, and it does not need to: see
    // `state` below.
    struct Key: Decodable, Equatable {
        let id: String
        let name: String
        let createdMs: Int64

        // Naming a key is optional at the mint (McpKeyApi::createKey reads only `name`, and the
        // column defaults to ''), so an unnamed one is ordinary rather than a fault.
        var named: String {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "A static key" : trimmed
        }
    }

    private struct Grants: Decodable {
        let grants: [Grant]
    }

    private struct Keys: Decodable {
        let keys: [Key]
    }

    // BOTH DOORS OR NEITHER. Two different credentials reach gym's tools, and only one of them is an
    // OAuth grant: a static MCP key resolves at the same bearer check
    // (backend/platform/adapters/mcp/McpHttpEndpoint.cpp hands the header to McpKeyService after
    // OAuthService declines it) and never appears in `/v1/oauth/grants`. It is a door the account
    // offers by hand — the connect page's "Advanced — static API key for clients without OAuth" —
    // so reading only the grants would tell a lifter whose key reads this log every day that nothing
    // reads it, which is the direction of this mistake that hurts.
    //
    // EITHER READ FAILING MAKES THE ANSWER `unknown` RATHER THAN AN UNDERCOUNT. "2 tools read this
    // log" is an assertion, and a half-read list cannot support one; a screen that does not know
    // says so, and the invitation under it stands either way.
    static func read(with api: WindmillApi) async -> ConnectedLogState {
        async let grants = api.get("/v1/oauth/grants", as: Grants.self)
        async let keys = api.get("/v1/mcp-keys", as: Keys.self)
        do {
            return state(grants: try await grants.grants, keys: try await keys.keys)
        } catch {
            return .unknown
        }
    }

    static func state(grants: [Grant], keys: [Key]) -> ConnectedLogState {
        let approved = grants.compactMap { grant -> ConnectedTool? in
            let reach = LogReach(scope: grant.scope)
            guard reach.reachesTheLog else { return nil }
            return ConnectedTool(id: grant.clientId, name: grant.named, grantedAtMs: grant.grantedMs,
                                 reach: reach, credential: .approved)
        }
        // EVERY STATIC KEY IS THE ACCOUNT-WIDE GRANT, and that is read off the schema rather than
        // guessed: `mcp_keys.scope` defaults to '' (backend/db/schema.sql), the mint endpoint reads
        // only a name, and nothing anywhere in the backend ever writes that column — so there is no
        // narrower key for this to mistake. The list endpoint serves no scope, which is why the
        // reach is stated here instead of decoded.
        let pasted = keys.map { key in
            ConnectedTool(id: key.id, name: key.named, grantedAtMs: key.createdMs,
                          reach: LogReach(scope: ""), credential: .pasted)
        }
        let tools = approved + pasted
        guard !tools.isEmpty else { return .none }
        return .connected(tools)
    }
}

// THE INVITATION, WHERE THE PROGRAM IS (§D12's "on Routines"). It is never drawn mid-session: this
// card lives on a tab, and a tab is not on screen while a workout is.
struct ConnectInvite: View {
    let open: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                Text(ConnectedLog.inviteTitle)
                    .font(WindmillFont.body(15, .semibold))
                    .foregroundStyle(skin.ink)
                    .multilineTextAlignment(.leading)
                Text(ConnectedLog.inviteLine)
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkFaint)
                    .lineSpacing(3)
                    .multilineTextAlignment(.leading)
                Text(ConnectedLog.inviteAction)
                    .font(WindmillFont.body(14, .bold))
                    .foregroundStyle(skin.accent)
            }
            .padding(WindmillSpace.x4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                .foregroundStyle(skin.accent))
        }
    }
}

// THE SCREEN, and it has two faces because the lifter has two questions. Connected, the only
// question is what the thing that reads this log may do — so the rows come first and the pitch is
// gone; a room that sold a connection to somebody who already made one would be advertising at
// them. Not connected, it is §D12's exchange, its precondition, and the door to the recipe.
struct ConnectScreen: View {
    let state: ConnectedLogState
    let isSignedIn: Bool
    let web: URL
    let onConnect: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                if case .connected(let tools) = state {
                    connected(tools)
                } else {
                    invitation
                }
            }
            .padding(.horizontal, WindmillSpace.x4)
            .padding(.top, WindmillSpace.x8)
            .padding(.bottom, WindmillSpace.x8)
        }
    }

    private var invitation: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                Text(ConnectedLog.headline)
                    .font(WindmillFont.display(28))
                    .foregroundStyle(skin.ink)
                Text(ConnectedLog.sub)
                    .font(WindmillFont.body(14.5))
                    .foregroundStyle(skin.inkDim)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.bottom, WindmillSpace.x2)

            exchange
            bullets

            Text(ConnectedLog.precondition)
                .font(GymType.numeral(12.5))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(WindmillSpace.x3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.canvas))
                .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                    .strokeBorder(skin.line, lineWidth: 1))

            panel(ConnectedLog.canTitle, ConnectedLog.canLines, ink: skin.setDone)
            // THE BOARD PAINTS THIS HEADING IN THE ALARM INK AND THE ROOM DOES NOT. That colour
            // marks exactly three things here — a write that failed, a read that failed, and the one
            // destructive control (GymSkin) — and a promise about what CANNOT happen is none of
            // them. Painting a reassurance in danger red would tell a lifter something is wrong at
            // the moment they are being told nothing can go wrong.
            panel(ConnectedLog.neverTitle, ConnectedLog.neverLines, ink: skin.inkFaint)

            if state == .unknown, isSignedIn {
                Text(ConnectedLog.unread)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
            }

            // THE PRIMARY ACTION, AND NOTHING IS SOLD BESIDE IT. Signed in it opens the page that
            // holds the per-tool recipe; signed out it opens the account door and says so, because
            // a grant needs an account to hang on.
            Button(action: onConnect) {
                Text(isSignedIn ? ConnectedLog.action : ConnectedLog.accountFirst)
                    .font(WindmillFont.body(17, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary - 6)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            }
            .padding(.top, WindmillSpace.x2)

            Text(ConnectedLog.desk)
                .font(GymType.numeral(12.5))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

            Text(ConnectedLog.free)
                .font(GymType.numeral(12.5))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var exchange: some View {
        VStack(spacing: 0) {
            said(ConnectedLog.sundayHead, ConnectedLog.sunday,
                 mark: skin.inkFaint, fill: skin.surface, edge: skin.line)
            Text("↓")
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.inkFaint)
                .padding(.vertical, WindmillSpace.x2)
            said(ConnectedLog.mondayHead, ConnectedLog.monday,
                 mark: skin.accent, fill: skin.accentSoft, edge: skin.accent)
        }
    }

    private func said(_ head: String, _ body: String,
                      mark ink: Color, fill: Color, edge: Color) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text(head)
                .font(GymType.numeral(10.5, .bold))
                .textCase(.uppercase)
                .kerning(0.9)
                .foregroundStyle(ink)
            Text(body)
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.ink)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(fill))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(edge, lineWidth: 1))
    }

    private var bullets: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            ForEach(ConnectedLog.bullets, id: \.self) { line in
                HStack(alignment: .top, spacing: WindmillSpace.x2) {
                    Text("·")
                        .font(WindmillFont.body(13.5, .bold))
                        .foregroundStyle(skin.setDone)
                    Text(line)
                        .font(WindmillFont.body(13.5))
                        .foregroundStyle(skin.inkDim)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, WindmillSpace.x2)
    }

    // EACH ROW SAYS WHAT THAT CREDENTIAL REACHES, LEVEL BY LEVEL, rather than leaving the whole
    // description to one summarising clause. A lifter standing here has already connected, so the
    // question is no longer whether to — it is what the thing on the other end may do, and the two
    // answers a flattering card would omit (the link it can mint, the workout it can destroy) are
    // named on the level that buys them.
    private func connected(_ tools: [ConnectedTool]) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(ConnectedLog.stateTitle)
                    .font(WindmillFont.display(28))
                    .foregroundStyle(skin.ink)
                Text(ConnectedLog.count(tools.count))
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
            }
            .padding(.bottom, WindmillSpace.x2)

            ForEach(tools) { tool in
                VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                    HStack(spacing: WindmillSpace.x3) {
                        Text(tool.name)
                            .font(WindmillFont.body(15, .bold))
                            .foregroundStyle(skin.ink)
                        Spacer(minLength: 0)
                        Text(ConnectedLog.since(tool.grantedAtMs, now: nowMs))
                            .font(GymType.numeral(11.5))
                            .foregroundStyle(skin.setDone)
                    }
                    ForEach(tool.reach.lines, id: \.self) { line in
                        Text(line)
                            .font(GymType.numeral(12))
                            .foregroundStyle(skin.inkDim)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if tool.reach.accountWide {
                        Text(ConnectedLog.accountWide)
                            .font(GymType.numeral(12))
                            .foregroundStyle(skin.inkDim)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(tool.credential.line)
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.inkFaint)
                }
                .padding(WindmillSpace.x4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
                .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .strokeBorder(skin.setDone, lineWidth: 1))
            }

            panel(ConnectedLog.neverTitle, ConnectedLog.neverLines, ink: skin.inkFaint)

            Text(ConnectedLog.ending)
                .font(GymType.numeral(12.5))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

            Link(destination: URL(string: "/#/settings", relativeTo: web) ?? web) {
                HStack(spacing: WindmillSpace.x2) {
                    Text(ConnectedLog.webDoor)
                        .font(WindmillFont.body(14, .semibold))
                        .foregroundStyle(skin.accent)
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(skin.accent)
                }
                .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
            }
        }
    }

    private func panel(_ title: String, _ lines: [String], ink: Color) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text(title)
                .font(GymType.numeral(10.5, .bold))
                .textCase(.uppercase)
                .kerning(0.9)
                .foregroundStyle(ink)
            ForEach(lines, id: \.self) { line in
                Text(line)
                    .font(WindmillFont.body(13.5))
                    .foregroundStyle(skin.ink)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.canvas))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
