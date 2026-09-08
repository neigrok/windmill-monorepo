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

        var label: String {
            switch self {
            case .read: return "Read"
            case .write: return "Write"
            case .delete: return "Delete"
            }
        }

        // Each row is a claim about `GymToolCatalog.cpp` at that access and nothing else: the
        // enumeration is the disclosure. No tool fetches the rest dial or the reading unit, so
        // nothing needs to say so.
        var meta: String {
            switch self {
            case .read: return "sets, workouts, routines, records, notes, weigh-ins"
            case .write: return "logs sets · adds routines · shares workouts · proposes changes"
            case .delete: return "discards a workout · ends a share"
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

    // The levels held, in the ladder's order rather than a Set's — or the one phrase for a grant
    // that is not about this log alone.
    var line: String {
        guard !accountWide else { return "whole account" }
        return Level.allCases.filter(levels.contains).map(\.rawValue).joined(separator: " · ")
    }
}

// One credential that reaches the training log. `grantedAtMs` is the day it came into being — for a
// grant, the earliest across every refresh.
struct ConnectedTool: Equatable, Identifiable, Sendable {
    enum Credential: Equatable, Sendable {
        case approved
        case pasted
    }

    let id: String
    let name: String
    let grantedAtMs: Int64
    let reach: LogReach
    let credential: Credential

    // The levels it holds, then the day it was made — a date, never today or yesterday, and never a
    // last read: the wire's `lastUsedMs` is a last-used, and a row would be read as a last-read.
    func meta(now: Int64) -> String {
        let since = "since \(Readout.shortDate(grantedAtMs, now: now))"
        switch credential {
        case .approved: return [reach.line, since].joined(separator: " · ")
        case .pasted: return ["API key", reach.line, since].joined(separator: " · ")
        }
    }
}

// `unread` is a read not yet back; `unknown` is one that failed. Neither says anything about the
// log, and only the second is a refusal a screen may draw. `none` is a real answer.
enum ConnectedLogState: Equatable {
    case unread
    case unknown
    case none
    case connected([ConnectedTool])

    var answered: Bool {
        switch self {
        case .unread, .unknown: return false
        case .none, .connected: return true
        }
    }

    // Under the settings row: the state and nothing else.
    var settingsMeta: String {
        switch self {
        case .unread, .unknown:
            return ConnectedLog.settingsUnknown
        case .none:
            return ConnectedLog.settingsNone
        case .connected(let tools):
            guard tools.count == 1, let only = tools.first else {
                return ConnectedLog.settingsMany(tools.count)
            }
            return "\(only.name) · \(only.reach.line)"
        }
    }

    // An unanswered read still invites: an invitation is not a claim about state.
    var invites: Bool {
        guard case .connected = self else { return true }
        return false
    }
}

// The room's one reader. A seat is read once: the launch asks from two places within a frame — the
// seat task and the scene turning active — and a read already in flight is the read. Every return
// from the background refreshes, because a lifter comes back from Safari having just connected a
// tool; so does a pull. A screen pushed or popped asks nothing. Signed out there is no read to make:
// the log is device-local, and a grant belongs to an account.
@MainActor
final class ConnectedLogReader: ObservableObject {
    @Published private(set) var state: ConnectedLogState = .unread
    private var seat: Account.Seat?
    private var reading = false

    func read(for account: Account) async {
        if seat != account.seat {
            seat = account.seat
            state = .unread
        }
        guard !state.answered else { return }
        await refresh(account)
    }

    func refresh(_ account: Account) async {
        guard !reading else { return }
        seat = account.seat
        reading = true
        defer { reading = false }
        state = account.isSignedIn ? await ConnectedLog.read(with: account.api) : .none
    }
}

// Every string the screen draws, byte-for-byte from `19-connected-log.md`. The apostrophe is the
// typographic one; the share window is a numeral.
enum ConnectedLog {
    static let title = "Connected log"

    // The precondition in eight words: a lifter who uses none of them reads their own answer.
    static let head = "Your log, read by Claude, Cursor or Codex."

    // The screen's one caption, and the surprising half: a write grant acts without asking.
    static let caption = "A routine change waits for your Apply; the rest lands at once."

    static let action = "Connect a tool"

    // A grant belongs to an account, and signed out the log is device-local.
    static let signInFirst = "Sign in first"

    // The browser glyph's name.
    static let opensInBrowser = "opens in your browser"

    static let disclosure = "How this works"

    // The whole of the long form: two levels of disclosure, and no third.
    static let how = [
        "One URL pasted into your tool. Your browser opens once to approve.",
        "A shared workout is public for 30 days, until you end it.",
        "No tool can apply a proposal or edit a logged set.",
        "Delete is approved on its own, and a discard is permanent.",
        "End a connection under Settings → Connected tools; a key under API keys.",
    ]

    static let connectedHead = "Connected"

    static let unnamedGrant = "A connected tool"

    static let unnamedKey = "A static key"

    static let unread = "Couldn’t read your connections."

    static let manage = "Manage connections"

    static let settingsUnknown = "your AI tools"

    static let settingsNone = "nothing connected yet"

    static func settingsMany(_ tools: Int) -> String {
        "\(tools) tools"
    }

    // The movement picker's card, an empty state: a line and the action.
    static let pickerLine = "A written program? Your AI tool can build it."

    static let connectPath = "/#/connect"

    static let settingsPath = "/#/settings"

    // One row of `GET /v1/oauth/grants`. `lastUsedMs` is on the wire and not decoded.
    struct Grant: Decodable, Equatable {
        let clientId: String
        let name: String
        let grantedMs: Int64
        let scope: String

        var named: String {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? unnamedGrant : trimmed
        }
    }

    // One row of `GET /v1/mcp-keys`. The endpoint serves no scope; see `state`.
    struct Key: Decodable, Equatable {
        let id: String
        let name: String
        let createdMs: Int64

        var named: String {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? unnamedKey : trimmed
        }
    }

    private struct Grants: Decodable {
        let grants: [Grant]
    }

    private struct Keys: Decodable {
        let keys: [Key]
    }

    // Both reads or neither: a static MCP key reaches the same tools and never appears in
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

// Two states, one screen: the head line while nothing is connected, the `Connected` section once
// something is. The grant is three rows of facts, the caption is their footer, the long form is one
// disclosure deep, and the one primary stands in the reach band.
struct ConnectScreen: View {
    let state: ConnectedLogState
    let isSignedIn: Bool
    let web: URL
    let onSignIn: () -> Void
    let onRefresh: () async -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        List {
            standing
            levels
            howThisWorks
            if case .connected = state { manage }
        }
        .scrollContentBackground(.hidden)
        .background(skin.canvas)
        .refreshable { await onRefresh() }
        .safeAreaInset(edge: .bottom) { reachBand }
    }

    // The refusal row is drawn only after a read failed — never while the first one is in flight —
    // and signed out the room answers `.none` without a read, so only a signed-in `unknown` is one.
    @ViewBuilder
    private var standing: some View {
        switch state {
        case .connected(let tools):
            Section(ConnectedLog.connectedHead) {
                ForEach(tools) { tool in
                    row(tool.name, meta: tool.meta(now: nowMs))
                }
            }
            .listRowBackground(skin.surface)
        case .unknown where isSignedIn:
            Section(ConnectedLog.connectedHead) {
                Text(ConnectedLog.unread)
                    .font(.body)
                    .foregroundStyle(skin.inkDim)
            }
            .listRowBackground(skin.surface)
        case .unread, .unknown, .none:
            Section {
                Text(ConnectedLog.head)
                    .font(.body)
                    .foregroundStyle(skin.ink)
            }
            .listRowBackground(skin.surface)
        }
    }

    private var levels: some View {
        Section {
            ForEach(LogReach.Level.allCases, id: \.rawValue) { level in
                row(level.label, meta: level.meta)
            }
        } footer: {
            Text(ConnectedLog.caption)
        }
        .listRowBackground(skin.surface)
    }

    private var howThisWorks: some View {
        Section {
            DisclosureGroup(ConnectedLog.disclosure) {
                ForEach(ConnectedLog.how, id: \.self) { line in
                    Text(line)
                        .font(.subheadline)
                        .foregroundStyle(skin.inkDim)
                }
            }
            .font(.body)
            .foregroundStyle(skin.ink)
        }
        .listRowBackground(skin.surface)
    }

    // Disconnecting is the shell's act, so the door leaves for the shell's settings.
    private var manage: some View {
        Section {
            Link(destination: page(ConnectedLog.settingsPath)) {
                HStack(spacing: WindmillSpace.x3) {
                    Text(ConnectedLog.manage)
                        .font(.body)
                        .foregroundStyle(skin.accent)
                    Spacer(minLength: 0)
                    browserGlyph
                        .foregroundStyle(skin.accent)
                }
                .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
            }
        }
        .listRowBackground(skin.surface)
    }

    // The label names what the tap will do, so no caption explains it.
    @ViewBuilder
    private var reachBand: some View {
        if isSignedIn {
            Link(destination: page(ConnectedLog.connectPath)) {
                HStack(spacing: WindmillSpace.x2) {
                    Text(ConnectedLog.action)
                    browserGlyph
                }
                .font(.headline)
                .foregroundStyle(skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            }
            .padding(.horizontal, GymLayout.gutter)
            .padding(.bottom, WindmillSpace.x2)
        } else {
            Button(action: onSignIn) {
                Text(ConnectedLog.signInFirst)
                    .font(.headline)
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            }
            .padding(.horizontal, GymLayout.gutter)
            .padding(.bottom, WindmillSpace.x2)
        }
    }

    private var browserGlyph: some View {
        Image(systemName: "arrow.up.forward")
            .font(.subheadline.weight(.semibold))
            .accessibilityLabel(ConnectedLog.opensInBrowser)
    }

    private func row(_ title: String, meta: String) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            Text(title)
                .font(.body)
                .foregroundStyle(skin.ink)
            Text(meta)
                .font(.footnote)
                .foregroundStyle(skin.inkDim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func page(_ path: String) -> URL {
        URL(string: path, relativeTo: web) ?? web
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
