import SwiftUI
import WindmillPlatform

// What one grant reaches in gym, read from the OAuth scope string. The empty scope is the
// account-wide grant and confers everything; a token nobody can parse confers nothing; the two must
// never be collapsed. Levels never imply each other.
struct LogReach: Equatable, Sendable {
    enum Level: String, CaseIterable, Sendable {
        case read
        case write
        case delete

        var reach: String {
            switch self {
            case .read:
                return "Reads your log — sets, workouts, routines, and records."
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
            // The last colon, not the first: that is where the server splits a token.
            guard let colon = token.lastIndex(of: ":"), colon != token.startIndex else { return nil }
            guard token[token.startIndex..<colon] == "gym" else { return nil }
            return Level(rawValue: String(token[token.index(after: colon)...]))
        })
    }

    var reachesTheLog: Bool {
        accountWide || !levels.isEmpty
    }

    // One line per level held, in the ladder's order rather than a Set's.
    var lines: [String] {
        Level.allCases.filter(levels.contains).map(\.reach)
    }
}

// One credential that reaches the training log. `grantedAtMs` is the day it came into being — for a
// grant, the earliest across every refresh.
struct ConnectedTool: Equatable, Identifiable, Sendable {
    enum Credential: String, CaseIterable, Equatable, Sendable {
        case approved
        case pasted

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

// `unknown` is a read that did not come back and says nothing at all; `none` is a real answer.
enum ConnectedLogState: Equatable {
    case unknown
    case none
    case connected([ConnectedTool])

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

    // `unknown` still invites: an invitation is not a claim about state.
    var invites: Bool {
        guard case .connected = self else { return true }
        return false
    }
}

enum ConnectedLog {
    static let headline = "Your training log, inside your own Claude."

    static let sub = """
        Not a chat in another tab. The twelve weeks of squats you already logged, readable by the \
        assistant you already use.
        """

    static let sundayHead = "Sunday, in Claude"

    static let sunday = """
        “Look at my last twelve weeks of bench. Write me a four-week block — heavier triples, and \
        swap the flies for incline work.”
        """

    static let mondayHead = "Monday, in gym"

    static let monday = "A proposal on Push A · 4 changes. You read it, you tap Apply, you train."

    static let bullets = [
        "Nothing to install and no tokens to buy — you paste one address, and the first connect opens your browser to approve.",
        "It reads your log and proposes. A day of your program that already stands never changes until you tap Apply.",
        "One account across all three Windmill products, and a grant names what it reaches: this log, your roadmap, or both.",
    ]

    static let precondition = """
        Needs an assistant you already use — Claude, Cursor, Codex, or anything else that speaks \
        MCP. If you use none of them, this one is not for you yet, and the log stays free regardless.
        """

    static let action = "How to connect"

    static let accountFirst = "This one needs an account"

    static let desk = """
        It takes a minute at a computer: paste one address into your tool, approve it in the \
        browser, and it is connected.
        """

    static let free = """
        Connecting your log is free. So is the rest of this room — logging, history, routines, the \
        workout share and the CSV.
        """

    static let canTitle = "What a connection can do"

    static let canLines = [
        "Read what you have logged — sets, sessions, routines, and records.",
        "Record what you lift, and add a movement or a day the program does not have yet.",
        "Propose a change to a day that already stands, or propose taking one out.",
        "Share one workout by link — a page anyone holding that link can read without signing in, until it expires or you end it.",
        "Discard a whole workout — only if it asks for that and you allow it, and you see what it asked for before you do.",
    ]

    static let neverTitle = "What it can never do"

    static let neverLines = [
        "Apply a proposal. There is no apply tool at any grant level — the diff waits on the routine until you tap it.",
        "Change or remove a day of your program by itself. Both arrive as a proposal and wait.",
        "Edit a set you already logged. No tool on a connection rewrites what you lifted.",
    ]

    static let stateTitle = "Connected log"

    static func count(_ tools: Int) -> String {
        tools == 1 ? "one tool reads this log" : "\(tools) tools read this log"
    }

    static func since(_ ms: Int64, now: Int64) -> String {
        "connected \(Readout.when(ms, now: now))"
    }

    static let nothingReadsIt = "no tool reads this log yet"

    static let settingsFallback = "what your own assistant can read here, and what it can never do"

    // Said on a row whose credential is the account-wide one.
    static let accountWide = """
        Approved for your whole account rather than for this log alone — every level here is on, and \
        so is everything outside gym.
        """

    static let webDoor = "Your connections, on the web"

    static let ending = """
        Connections are made and ended on the web: the connect page carries the recipe for each \
        tool, and your account settings end either kind — an approved connection under Connected \
        tools, a static key under API keys. Ending one stops its reads immediately, and every \
        proposal already in your history stays.
        """

    static let inviteTitle = "Your program, read by the assistant you already use."

    static let inviteLine = """
        Ask it on Sunday for a four-week block; the proposal is waiting on the routine on Monday. \
        Connecting is free.
        """

    static let inviteAction = "How it works →"

    static let unread = "this phone couldn’t read your connections just now"

    // One row of `GET /v1/oauth/grants`. `lastUsedMs` is on the wire and not decoded: it is a
    // last-used, and a card would be read as a last-read.
    struct Grant: Decodable, Equatable {
        let clientId: String
        let name: String
        let grantedMs: Int64
        let scope: String

        var named: String {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "A connected tool" : trimmed
        }
    }

    // One row of `GET /v1/mcp-keys`. The endpoint serves no scope; see `state`.
    struct Key: Decodable, Equatable {
        let id: String
        let name: String
        let createdMs: Int64

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

    // Both doors or neither: a static MCP key reaches the same tools and never appears in
    // `/v1/oauth/grants`. Either read failing makes the answer `unknown` rather than an undercount.
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
        // Every static key is the account-wide grant, and the list endpoint serves no scope, so the
        // reach is stated here rather than decoded.
        let pasted = keys.map { key in
            ConnectedTool(id: key.id, name: key.named, grantedAtMs: key.createdMs,
                          reach: LogReach(scope: ""), credential: .pasted)
        }
        let tools = approved + pasted
        guard !tools.isEmpty else { return .none }
        return .connected(tools)
    }
}

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
            panel(ConnectedLog.neverTitle, ConnectedLog.neverLines, ink: skin.inkFaint)

            if state == .unknown, isSignedIn {
                Text(ConnectedLog.unread)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
            }

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

    private func connected(_ tools: [ConnectedTool]) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            VStack(alignment: .leading, spacing: 2) {
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
