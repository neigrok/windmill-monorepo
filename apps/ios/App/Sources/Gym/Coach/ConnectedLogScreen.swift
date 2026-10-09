import SwiftUI
import Observation

nonisolated struct CoachConnection: Identifiable, Equatable {
  let id: String
  let name: String
  let created: Int64
  let levels: String
  let key: Bool
  var meta: String {
    let day = Date(timeIntervalSince1970: Double(created) / 1000).formatted(.dateTime.day().month(.abbreviated))
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
}

struct ConnectedLogScreen: View {
  let gym: GymModel
  @State var connections: CoachConnections
  @Environment(\.openURL) var openURL
  @Environment(\.coachOpenAccount) var openAccount
  @State var accountHint = false
  @State var browserError = false
  init(gym: GymModel) { self.gym = gym; _connections = State(initialValue: CoachConnections(gym: gym)) }
  var body: some View {
    List {
      Group {
        Section {
          Text("Your log, read by Claude, Cursor or Codex.").font(.title3.weight(.semibold))
        }.listRowBackground(Color.clear)
        if gym.coachAccountAvailable {
          Section("Connected") {
            if connections.owner != gym.account || connections.reading { ProgressView("Reading your connections…") }
            else if connections.failed {
              Text(connections.connectionRequired ? "Connect to the internet to read your connections." : "Couldn’t read your connections.")
              Button("Try again") { Task { await connections.load() } }
            } else if let rows = connections.rows {
              if rows.isEmpty { Text("nothing connected yet").foregroundStyle(GymPalette.inkDim) }
              ForEach(rows) { row in
                VStack(alignment: .leading, spacing: 5) { Text(row.name); Text(row.meta).font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim) }
              }
            }
          }.listRowBackground(GymPalette.card)
        }
        Section {
          capability("Read", "sets, workouts, routines, records, notes, weigh-ins")
          capability("Write", "logs sets · saves notes · adds routines · shares workouts · proposes changes")
          capability("Delete", "discards a workout · ends a share")
        } footer: { Text("A routine change waits for your Apply; the rest lands at once.") }
        Section {
          Button {
            if gym.coachAccountAvailable { browse("connect") }
            else if let openAccount { openAccount() } else { accountHint = true }
          } label: { Label(gym.coachAccountAvailable ? "Connect a tool" : "Sign in first", systemImage: "arrow.up.forward") }
            .accessibilityHint("opens in your browser").accessibilityIdentifier("coach-connect-tool")
          if gym.coachAccountAvailable { Button { browse("settings") } label: { Label("Manage connections", systemImage: "arrow.up.forward") }.accessibilityHint("opens in your browser") }
          if accountHint { Text("Open You and settings in the top bar.").font(.callout) }
      }.listRowBackground(GymPalette.card)
      Section {
        DisclosureGroup("How this works") {
          ForEach(["One URL pasted into your tool. Your browser opens once to approve.",
            "A shared workout is public for 30 days, until you end it.", "No tool can apply a proposal or edit a logged set.",
            "Delete is approved on its own, and a discard is permanent.", "End a connection under Settings → Connected tools; a key under API keys."], id: \.self) { Text($0).font(.callout) }
        }
      }.listRowBackground(GymPalette.card)
      }.listRowBackground(GymPalette.card)
    }.listStyle(.insetGrouped).navigationTitle("Connected log").modifier(GymPage()).accessibilityIdentifier("gym-connected-log")
      .safeAreaInset(edge: .bottom) {
        GymTransient(gym: gym, message: browserError ? "The browser couldn’t be opened. Try again." : nil,
                     dismiss: { browserError = false }, errorIdentifier: "gym-coach-error", undoIdentifier: "coach-engine-undo")
      }
      .toolbar(.hidden, for: .tabBar)
      .refreshable { await connections.load() }
      .task(id: "\(gym.account ?? ""):\(gym.authPaused):\(gym.accountTransition)") { await connections.load() }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "connected_log"]) }
  }
  func capability(_ title: String, _ line: String) -> some View {
    VStack(alignment: .leading, spacing: 5) { Text(title).font(.body.weight(.semibold)); Text(line).font(.callout).foregroundStyle(GymPalette.inkDim) }
  }
  func browse(_ route: String) {
    guard let base = gym.runtime?.settings.baseURL, let url = URL(string: "/#/" + route, relativeTo: base)?.absoluteURL else { browserError = true; return }
    openURL(url) { accepted in
      browserError = !accepted
      if !accepted { gym.telemetry.failure("gym_action", kind: "unexpected") }
    }
  }
}
