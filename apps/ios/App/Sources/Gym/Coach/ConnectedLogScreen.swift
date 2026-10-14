import SwiftUI
import Observation
import DomainKit

nonisolated struct CoachConnection: Identifiable, Equatable {
  let id: String
  let name: String
  let created: Int64
  let levels: String
  let key: Bool
  var meta: String {
    let day = Instant(ms: created).date.formatted(.dateTime.day().month(.abbreviated))
    return (key ? "API key · " : "") + levels + " · since " + day
  }
  struct Grant: Decodable { let clientId: String; let name: String?; let grantedMs: Int64; let scope: String? }
  struct Key: Decodable { let id: String; let name: String?; let createdMs: Int64 }
  struct Grants: Decodable { let grants: [Grant] }
  struct Keys: Decodable { let keys: [Key] }
  static func decode(grants: Data, keys: Data) throws -> [CoachConnection] {
    let grants = try JSONDecoder().decode(Grants.self, from: grants).grants
    let keys = try JSONDecoder().decode(Keys.self, from: keys).keys
    let approved = grants.compactMap { grant -> CoachConnection? in
      let scope = (grant.scope ?? "").split(whereSeparator: \.isWhitespace).map(String.init)
      let levels = ["read", "write", "delete"].filter { scope.contains("gym:" + $0) }
      guard scope.isEmpty || !levels.isEmpty else { return nil }
      let name = (grant.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      return CoachConnection(id: "grant:" + grant.clientId, name: name.isEmpty ? "A connected tool" : name,
        created: grant.grantedMs, levels: scope.isEmpty ? "whole account" : levels.joined(separator: " · "), key: false)
    }
    return approved + keys.map { key in
      let name = (key.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      return CoachConnection(id: "key:" + key.id, name: name.isEmpty ? "A static key" : name,
        created: key.createdMs, levels: "whole account", key: true)
    }
  }
}

@Observable @MainActor final class CoachConnections {
  let gym: GymModel
  let rest: GymRESTClient
  var owner: String?
  var rows: [CoachConnection]?
  var reading = false
  var failed = false
  var connectionRequired = false
  var generation = 0
  init(gym: GymModel, rest: GymRESTClient? = nil) { self.gym = gym; self.rest = rest ?? CoachFixture.rest(gym) }
  func load() async {
    generation += 1; let generation = generation
    guard gym.coachAccountAvailable, !gym.authPaused else { rows = nil; reading = false; failed = false; owner = nil; return }
    let account = gym.account; owner = account
    reading = true; failed = false; connectionRequired = false; rows = nil
    defer { if self.generation == generation { reading = false } }
    do {
      async let grants = rest.coachRequest("/v1/oauth/grants", expectedAccount: account)
      async let keys = rest.coachRequest("/v1/mcp-keys", expectedAccount: account)
      let data = try await (grants, keys)
      guard account == gym.account, !gym.accountTransition, self.generation == generation else { return }
      rows = try CoachConnection.decode(grants: data.0, keys: data.1)
    } catch {
      guard account == gym.account, self.generation == generation, !(error is CancellationError) else { return }
      failed = true
      connectionRequired = GymRESTClient.needsConnection(error)
      if error is DecodingError { gym.report("gym_read", error) }
    }
  }
  // The Gym settings row's meta: what reaches the log, never a sentence (19-connected-log.md, "The native settings row").
  var summary: String {
    guard gym.coachAccountAvailable else { return "nothing connected yet" }
    guard owner == gym.account, let rows else { return "your AI tools" }
    switch rows.count {
    case 0: return "nothing connected yet"
    case 1: return rows[0].name + " · " + rows[0].levels
    default: return GymCount.of(rows.count, "tool")
    }
  }
}

struct ConnectedLogScreen: View {
  let gym: GymModel
  @State var connections: CoachConnections
  @Environment(\.openURL) var openURL
  @Environment(\.coachOpenAccount) var openAccount
  @State var browserError = false
  init(gym: GymModel) { self.gym = gym; _connections = State(initialValue: CoachConnections(gym: gym)) }
  var listed: [CoachConnection] { gym.coachAccountAvailable && connections.owner == gym.account ? connections.rows ?? [] : [] }
  var unknown: Bool { gym.coachAccountAvailable && connections.failed }
  // Something may reach the log: the list replaces the head line and Manage connections joins the disclosure.
  var drawsConnections: Bool { unknown || !listed.isEmpty }
  var body: some View {
    List {
      Group {
        if drawsConnections {
          Section("Connected") {
            if unknown {
              Text(connections.connectionRequired ? "Connect to the internet to read your connections." : "Couldn’t read your connections.").foregroundStyle(GymPalette.inkDim)
            }
            ForEach(listed) { row in GymRow(title: row.name, meta: row.meta) }
          }
        }
        Section {
          GymRow(title: "Read", meta: "sets, workouts, routines, records, notes, weigh-ins")
          GymRow(title: "Write", meta: "logs sets · saves notes · adds routines · shares workouts · proposes changes")
          GymRow(title: "Delete", meta: "discards a workout · ends a share")
        } header: {
          if !drawsConnections { Text("Your log, read by Claude, Cursor or Codex.").font(.subheadline).foregroundStyle(GymPalette.inkDim).textCase(nil) }
        } footer: { Text("A routine change waits for your Apply; the rest lands at once.") }
        Section {
          if drawsConnections {
            Button { browse("settings") } label: { Label("Manage connections", systemImage: "arrow.up.forward") }
              .accessibilityHint("opens in your browser")
          }
          DisclosureGroup("How this works") {
            ForEach(["One URL pasted into your tool. Your browser opens once to approve.",
              "A shared workout is public for 30 days, until you end it.", "No tool can apply a proposal or edit a logged set.",
              "Delete is approved on its own, and a discard is permanent.", "End a connection under Settings → Connected tools; a key under API keys."], id: \.self) { Text($0).font(.callout) }
          }
        }
      }.listRowBackground(GymPalette.card)
    }.listStyle(.insetGrouped).navigationTitle("Connected log").modifier(GymPage()).accessibilityIdentifier("gym-connected-log")
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 0) {
          GymTransient(gym: gym, message: browserError ? "The browser couldn’t be opened. Try again." : nil,
                       dismiss: { browserError = false }, errorIdentifier: "gym-coach-error", undoIdentifier: "coach-engine-undo")
          connect
        }
      }
      .toolbar(.hidden, for: .tabBar)
      .refreshable { await connections.load() }
      .task(id: "\(gym.account ?? ""):\(gym.authPaused):\(gym.accountTransition)") { await connections.load() }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "connected_log"]) }
  }
  // The screen's one primary; signed in, its symbol names the browser it leaves for.
  var connect: some View {
    ActionBand(title: gym.coachAccountAvailable ? "Connect a tool" : "Sign in first", room: .gym, actionIdentifier: "coach-connect-tool",
               symbol: gym.coachAccountAvailable ? "arrow.up.forward" : nil) {
      if gym.coachAccountAvailable { browse("connect") } else { openAccount?() }
    }.accessibilityHint(gym.coachAccountAvailable ? "opens in your browser" : "")
  }
  func browse(_ route: String) {
    guard let base = gym.runtime?.settings.baseURL, let url = URL(string: "/#/" + route, relativeTo: base)?.absoluteURL else { browserError = true; return }
    openURL(url) { accepted in
      browserError = !accepted
      if !accepted { gym.telemetry.failure("gym_action", kind: "unexpected") }
    }
  }
}
