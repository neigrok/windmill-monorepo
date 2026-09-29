import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncStore
import SyncTesting
import Testing

// The first boot against the local probe server over HTTP (backend/RUNNING.md, `windmill_server_probe`), when
// SYNC_BENCH_PROBE_URL names it. That server carries the probe product alone, not gym, so the history is the probe's
// equivalent of 10 000 sets: 400 runs of 25 laps, each run started and ended by its commands and each lap a record under
// its run with a server serial, logged on one phone and synced after each run. Each run of the benchmark signs in a new
// account.
extension Benchmarks {
  @Suite(.enabled(if: ProbeServer.url != nil, "SYNC_BENCH_PROBE_URL names the probe server"))
  struct ProbeServerBoot {
    static let runs = 400
    static let lapsPerRun = 25

    @Test func bootFromEmpty() async throws {
      let server = try #require(ProbeServer.url)
      let registry = try Corpus.probeRegistry()
      let transport = HTTPTransport(baseURL: server, schema: registry.version)
      let email = "sync-bench-\(UUID().uuidString.prefix(8).lowercased())@example.com"
      let writer = try Phone(store: Store.inMemory(registry: registry), transport: transport)
      let seeding = try await ProbeServer.signIn(email: email, at: server)
      try await writer.signIn(seeding.account, token: seeding.token)
      for _ in 0..<Self.runs {
        try Self.logRun(on: writer, laps: Self.lapsPerRun)
        await writer.sync()
      }
      await writer.sync()
      #expect(try writer.engine.read(ProbeServer.scope) { try $0.drawn("lap").count } == Self.runs * Self.lapsPerRun)
      #expect(try writer.store.read { try $0.replica($0.activeReplica())?.outbox.count } == 0)

      try await Bench.inDirectory { directory in
        let path = directory.appending(path: "sync.sqlite")
        let times = TransactionTimes()
        let booting = try await ProbeServer.signIn(email: email, at: server)
        let before = Memory.now()
        let began = ContinuousClock.now
        let (phone, peak) = try await Memory.peak {
          let phone = try Phone.onDisk(path, registry: registry, transport: transport, crashPoints: times.crashPoints)
          try await phone.signIn(booting.account, token: booting.token)
          await phone.pull()
          return phone
        }
        let elapsed = ContinuousClock.now - began
        #expect(try phone.firstPullComplete(ProbeServer.scope))
        #expect(try phone.engine.read(ProbeServer.scope) { try $0.drawn("lap").count } == Self.runs * Self.lapsPerRun)
        Bench.report("boot · empty store to first pull of probe complete (10 000 laps, probe server over HTTP)", [
          ("elapsed", Bench.format(Bench.ms(elapsed))), ("bytesOnDisk", Bench.format(bytes: Phone.bytesOnDisk(path))),
        ] + peak.growth(since: before, as: "peak"))
        times.durations(of: .pullPage, as: "transaction · a boot page from the probe server").report()
      }
    }

    // A run as the probe's run screen makes one: `probe.start` with its predicted run, the laps one gesture each, then
    // `probe.end`, each decided inside its commit.
    static func logRun(on phone: Phone, laps: Int) throws {
      let (_, run) = try phone.engine.commit(ProbeServer.scope) { context -> (Gesture?, RecordID) in
        let run = try context.mintID("run")
        let start = Command(name: "probe.start", args: ["id": run.json, "startedAt": JSON(context.now), "join": false])
        return (Gesture(changes: [], command: start, predict: [.create("run", id: .given(run), ["startedAt": JSON(context.now)])]), run)
      }
      for number in 0..<laps {
        try phone.commit(Gesture(changes: [.create("lap", id: .given(try phone.engine.mintID("lap")),
                                                   ["runId": run.json, "weight": JSON(floatLiteral: 60 + Double(number % 8) * 2.5)])]),
                         in: ProbeServer.scope)
      }
      _ = try phone.engine.commit(ProbeServer.scope) { context -> (Gesture?, Void) in
        (Gesture(changes: [], command: Command(name: "probe.end", args: ["runId": run.json, "endedAt": JSON(context.now)])), ())
      }
    }
  }
}

enum ProbeServer {
  static let url = ProcessInfo.processInfo.environment["SYNC_BENCH_PROBE_URL"].flatMap(URL.init(string:))
  static let scope = ScopeRef.product("probe")

  // The dev stack's sign-in: `POST /v1/dev/sign-in {email}` → `{account, token}`, a new session of that email's account.
  static func signIn(email: String, at server: URL) async throws -> (account: String, token: SessionToken) {
    var request = URLRequest(url: server.appending(path: "v1/dev/sign-in"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data(JSON.object(["email": .string(email)]).jcsText.utf8)
    let (body, response) = try await URLSession.shared.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw BenchError("the dev sign-in answered \(response)") }
    let answer = try JSON(parsing: [UInt8](body))
    return (try answer.member("account").asString(), SessionToken(try answer.member("token").asString()))
  }
}
