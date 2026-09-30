import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncStore
import SyncTesting

// What every benchmark stands on: a phone, the gym history on a model server, and the gestures a lifter makes.

// MARK: - A phone

// One phone of the benchmarks: the real engine in step mode, over a store on disk (WAL, synchronous=FULL) or in memory,
// on the system's clocks and randomness. Its loops never start, so a benchmark drives the sender and the puller itself
// and nothing else writes while it measures. `Keys` outlive the process, so a relaunch over the same file finds its
// session token and fork guard and neither re-identifies nor pauses.
final class Phone: Sendable {
  struct Keys: Sendable {
    let tokens = InMemoryTokenStore()
    let forkGuard = InMemoryForkGuardStore()
    let connectivity = SwitchedConnectivity()
  }

  let store: Store
  let engine: SyncEngine
  let keys: Keys

  init(store: Store, transport: any SyncTransport, keys: Keys = Keys()) throws {
    self.store = store
    self.keys = keys
    engine = try SyncEngine(
      config: EngineConfig(appVersion: "bench", surface: .ios, drivesLoops: false), store: store, transport: transport,
      tokens: keys.tokens, forkGuard: keys.forkGuard, clock: .system, random: SystemRandom(), connectivity: keys.connectivity)
  }

  static func onDisk(_ path: URL, registry: Registry, transport: any SyncTransport, keys: Keys = Keys(),
                     crashPoints: CrashPoints = .none) throws -> Phone {
    try Phone(store: Store(path: path.path, registry: registry, crashPoints: crashPoints), transport: transport, keys: keys)
  }

  // Engine start, and a sign-in that nothing written signed out makes complete at once.
  func signIn(_ account: String, token: SessionToken) async throws {
    await engine.start()
    let session = try await engine.signIn(account: account, token: token)
    guard session.isComplete else { throw BenchError("a phone with nothing written signed in with a decision due") }
  }

  // The sender's rounds until nothing is left to send, each pause the server asks for (a `retry` answer) waited out.
  func push() async {
    while true {
      switch await engine.sender.step() {
      case .again: continue
      case .wait(let ms): try? await Task.sleep(for: .milliseconds(ms))
      case .idle, .paused, .stopped, .backoff: return
      }
    }
  }

  // The puller's rounds, every subscribed scope wanted or only `scopes`, until one pulls nothing more, each round's
  // duration; after each, the sweep deletes what the round took out of every view, as its loop would.
  @discardableResult
  func pull(only scopes: [ScopeRef]? = nil) async -> [Duration] {
    if let scopes { engine.puller.wants.add(scopes) } else { engine.puller.wants.all() }
    var rounds: [Duration] = []
    while true {
      let began = ContinuousClock.now
      let step = await engine.puller.step()
      rounds.append(ContinuousClock.now - began)
      while engine.sweeper.step() == .again {}
      switch step {
      case .pulled, .frame, .again: continue
      case .idle, .fallback, .repull, .paused, .stopped, .backoff: return rounds
      }
    }
  }

  func sync() async {
    await push()
    await pull()
  }

  func firstPullComplete(_ scope: ScopeRef) throws -> Bool {
    try engine.read(scope) { try $0.firstPullComplete() }
  }

  @discardableResult
  func commit(_ gesture: Gesture, in scope: ScopeRef = Gym.scope) throws -> CommitReceipt {
    guard case .committed(let receipt) = try engine.commit(scope, gesture) else { throw BenchError("the commit was refused") }
    return receipt
  }

  // The file's size on disk, its write-ahead log included.
  static func bytesOnDisk(_ path: URL) -> Int {
    [path.path, path.path + "-wal"].compactMap { try? FileManager.default.attributesOfItem(atPath: $0)[.size] as? Int }.reduce(0, +)
  }
}

struct BenchError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

// The gym product has no server rules the engine's budgets depend on: plain creates, updates and deletes only.
struct NoGymRules: ServerRules {}

// MARK: - The history

// A model server holding one lifter's gym history, made through the engine as a lifter makes it: 20 exercises, 8
// routines, and 400 sessions of 25 sets, 10 000 sets, logged on one phone and synced every two sessions. The server runs
// in this process on the system clock. Built once per process; each benchmark boots phones of its own from it.
final class GymHistory: Sendable {
  static let account = "lifter"
  static let sessionCount = 400
  static let setsPerSession = 25
  static let setCount = sessionCount * setsPerSession

  let network: SimNetwork
  let exercises: [RecordID]
  let routines: [RecordID]
  let sessions: [RecordID]
  let writer: Phone

  static let shared = Shared()

  actor Shared {
    var history: GymHistory?

    func history() async throws -> GymHistory {
      if let history { return history }
      let made = try await GymHistory.make()
      history = made
      return made
    }
  }

  init(network: SimNetwork, exercises: [RecordID], routines: [RecordID], sessions: [RecordID], writer: Phone) {
    self.network = network
    self.exercises = exercises
    self.routines = routines
    self.sessions = sessions
    self.writer = writer
  }

  var token: SessionToken { network.server.token(for: Self.account) }

  static func make() async throws -> GymHistory {
    let network = SimNetwork(server: ModelServer(registry: SyncSchema.registry, rules: NoGymRules(), state: ServerState(epoch: "ep-1")),
                             clock: SystemClock())
    let writer = try Phone(store: Store.inMemory(registry: SyncSchema.registry), transport: network)
    try await writer.signIn(account, token: network.server.token(for: account))
    let exercises = try (0..<20).map { _ in try writer.engine.mintID(Gym.Types.exercise) }
    try writer.commit(Gesture(changes: exercises.enumerated().map { index, id in
      .create(Gym.Types.exercise, id: .given(id), ["name": .string("Movement \(index)"), "pattern": "squat", "equipment": "barbell"])
    }))
    let routines = try (0..<8).map { _ in try writer.engine.mintID(Gym.Types.routine) }
    try writer.commit(Gesture(changes: routines.enumerated().map { index, id in
      .create(Gym.Types.routine, id: .given(id), ["name": .string("Routine \(index)"), "entries": routineEntries(exercises, from: index)])
    }))
    var sessions: [RecordID] = []
    for index in 0..<sessionCount {
      let session = try writer.engine.mintID(Gym.Types.session)
      sessions.append(session)
      var changes: [Change] = [.create(Gym.Types.session, id: .given(session))]
      for number in 0..<setsPerSession {
        changes.append(.create(Gym.Types.set, id: .given(try writer.engine.mintID(Gym.Types.set)),
                               setValues(session: session, exercise: exercises[(index + number / 5) % exercises.count], number: number)))
      }
      try writer.commit(Gesture(changes: changes))
      if index % 2 == 1 { await writer.sync() }
    }
    await writer.sync()
    let history = GymHistory(network: network, exercises: exercises, routines: routines, sessions: sessions, writer: writer)
    let held = network.server.rows(Gym.scope, of: account).filter { $0.key.type == Gym.Types.set }.count
    guard held == setCount else { throw BenchError("the server holds \(held) sets, not \(setCount)") }
    return history
  }

  // A routine of five movements, three working sets each.
  static func routineEntries(_ exercises: [RecordID], from index: Int) -> JSON {
    .array((0..<5).map { offset in
      ["exerciseId": exercises[(index + offset) % exercises.count].json, "restSeconds": 120,
       "sets": [["reps": 5, "weightKg": 80], ["reps": 5, "weightKg": 80], ["reps": 5, "weightKg": 80]]]
    })
  }

  // A logged set as the set logger writes it: its session and movement, the load, the reps and the kind; now and then
  // an RPE and a note.
  static func setValues(session: RecordID, exercise: RecordID, number: Int) -> [String: JSON] {
    var values: [String: JSON] = [
      "sessionId": session.json, "exerciseId": exercise.json, "weightKg": JSON(floatLiteral: 60 + Double(number % 8) * 2.5),
      "reps": JSON(5 + number % 4), "kind": number % 5 == 0 ? "warmup" : "working",
    ]
    if number % 3 == 0 { values["rpe"] = JSON(floatLiteral: 7.5) }
    if number % 10 == 0 { values["note"] = "Felt strong, bar speed good" }
    return values
  }

  // A phone on disk at `path`, signed in as the lifter and started, pulled until its first pull of gym is complete and
  // it draws every set the server holds (benchmarks before it may have added some): the boot, with each pull round's
  // duration.
  func bootPhone(at path: URL, keys: Phone.Keys = Phone.Keys(), crashPoints: CrashPoints = .none) async throws
    -> (phone: Phone, rounds: [Duration]) {
    let phone = try Phone.onDisk(path, registry: SyncSchema.registry, transport: network, keys: keys, crashPoints: crashPoints)
    try await phone.signIn(Self.account, token: token)
    let rounds = await phone.pull()
    guard try phone.firstPullComplete(Gym.scope) else { throw BenchError("the boot ended before the first pull of gym was complete") }
    let sets = try phone.engine.read(Gym.scope) { try $0.drawn(Gym.Types.set).count }
    let served = network.server.rows(Gym.scope, of: Self.account).filter { $0.key.type == Gym.Types.set }.count
    guard sets == served, sets >= Self.setCount else { throw BenchError("the booted phone draws \(sets) sets, the server holds \(served)") }
    return (phone, rounds)
  }
}

// MARK: - The gestures a lifter makes

enum Gestures {
  // Log a set: one plain create, its id minted as `id` says.
  static func logSet(in session: RecordID, of exercise: RecordID, id: NewID, number: Int = 1) -> Gesture {
    Gesture(changes: [.create(Gym.Types.set, id: id, GymHistory.setValues(session: session, exercise: exercise, number: number))])
  }

  // The routine editor's save: exactly the lattice fields it writes, guarded at their stored stamps.
  static func editRoutine(_ routine: RecordID, name: String, exercises: [RecordID], shift: Int) -> Gesture {
    Gesture(
      changes: [.update(Gym.Types.routine, routine, ["name": .string(name), "entries": GymHistory.routineEntries(exercises, from: shift)])],
      guards: [RegisterRef(type: Gym.Types.routine, id: routine, field: "name"), RegisterRef(type: Gym.Types.routine, id: routine, field: "entries")])
  }

  // Delete a set, held for Undo.
  static func heldDelete(_ set: RecordID) -> Gesture {
    Gesture(changes: [.delete(Gym.Types.set, set)], hold: true)
  }
}
