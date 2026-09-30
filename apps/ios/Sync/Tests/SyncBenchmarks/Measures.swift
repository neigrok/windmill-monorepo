import Foundation
import Observation
import SyncCore
import SyncEngine
import SyncStore
import Synchronization
import Testing

// The engine's budgets (design §4.6, §11 M11) measured on a store on disk. The suite runs only under SYNC_BENCH=1, one
// benchmark at a time, and prints every measure as one `bench` line beside its budget; with SYNC_BENCH_REPORT=<path>
// each line is also appended to that file as one JSON object. A measure over budget is a finding to file, not a failed
// test: a benchmark fails only when it did not measure what it names.
@Suite(.serialized, .enabled(if: Bench.isOn, "the benchmarks run under SYNC_BENCH=1"))
enum Benchmarks {}

enum Bench {
  static let isOn = ProcessInfo.processInfo.environment["SYNC_BENCH"] == "1"
  static let reportPath = ProcessInfo.processInfo.environment["SYNC_BENCH_REPORT"]

  #if os(iOS)
  static let platform = "simulator"
  #else
  static let platform = "mac"
  #endif

  // A directory of its own under the temporary directory, deleted when `body` ends; `body` runs on the caller's actor.
  static func inDirectory<Value>(isolation: isolated (any Actor)? = #isolation, _ body: (URL) async throws -> Value) async throws -> Value {
    let directory = FileManager.default.temporaryDirectory.appending(path: "sync-bench-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    return try await body(directory)
  }

  static func ms(_ duration: Duration) -> Double {
    Double(duration.components.seconds) * 1_000 + Double(duration.components.attoseconds) / 1e15
  }

  // One measure's line: printed, and appended to the report file when one is named.
  static func report(_ measure: String, _ fields: [(String, String)], budget: String? = nil, over: Bool? = nil) {
    var line = "bench [\(platform)] \(measure):"
    for (name, value) in fields { line += " \(name)=\(value)" }
    if let budget { line += " | budget \(budget) → \(over == true ? "OVER" : "under")" }
    print(line)
    guard let reportPath else { return }
    var object: [String: String] = ["platform": platform, "measure": measure]
    for (name, value) in fields { object[name] = value }
    object["budget"] = budget
    object["verdict"] = over.map { $0 ? "over" : "under" }
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let handle = FileHandle(forWritingAtPath: reportPath) ?? {
            FileManager.default.createFile(atPath: reportPath, contents: nil)
            return FileHandle(forWritingAtPath: reportPath)
          }()
    else { return }
    handle.seekToEndOfFile()
    handle.write(data + Data("\n".utf8))
    try? handle.close()
  }

  static func format(_ ms: Double) -> String { String(format: "%.2fms", ms) }
  static func format(bytes: Int) -> String { String(format: "%.1fMB", Double(bytes) / 1_048_576) }
}

// The durations of one measure, each taken on the monotonic clock.
struct Samples {
  let measure: String
  private(set) var ms: [Double] = []

  init(_ measure: String) {
    self.measure = measure
  }

  mutating func time<Value>(_ body: () throws -> Value) rethrows -> Value {
    let began = ContinuousClock.now
    defer { ms.append(Bench.ms(ContinuousClock.now - began)) }
    return try body()
  }

  mutating func time<Value>(_ body: () async throws -> Value) async rethrows -> Value {
    let began = ContinuousClock.now
    defer { ms.append(Bench.ms(ContinuousClock.now - began)) }
    return try await body()
  }

  mutating func add(_ duration: Duration) {
    ms.append(Bench.ms(duration))
  }

  mutating func add(contentsOf other: Samples) {
    ms += other.ms
  }

  // The same measure without its first `count` samples, taken while caches filled.
  func afterWarmUp(_ count: Int) -> Samples {
    var kept = Samples(measure)
    kept.ms = Array(ms.dropFirst(count))
    return kept
  }

  // The nearest-rank percentile.
  func percentile(_ p: Double) -> Double {
    let sorted = ms.sorted()
    guard !sorted.isEmpty else { return .nan }
    return sorted[min(sorted.count - 1, max(0, Int((p / 100 * Double(sorted.count)).rounded(.up)) - 1))]
  }

  // Prints the distribution; with a p95 budget, whether it holds.
  func report(p95Budget budget: Double? = nil) {
    let p95 = percentile(95)
    Bench.report(measure, [
      ("n", "\(ms.count)"), ("p50", Bench.format(percentile(50))), ("p95", Bench.format(p95)), ("p99", Bench.format(percentile(99))),
      ("max", Bench.format(ms.max() ?? .nan)),
    ], budget: budget.map { "p95 ≤ \(Bench.format($0))" }, over: budget.map { p95 > $0 })
  }
}

// What the views cost the main actor, as a UI module observes them: a view's observers are told on the main actor, in the
// turn that changes its state, and the view shows the change once the main actor runs again.
@MainActor
enum ViewTimes {
  // From the moment `act` answers to the moment the view's observers are told.
  static func untilNotified(_ view: RecordsView, after act: () async throws -> ContinuousClock.Instant) async throws -> Duration {
    let told = notification(of: view)
    let from = try await act()
    return try await told() - from
  }

  // A view's first load, from the call that makes it: the main actor's share (the call, and the turn that shows the load,
  // from the observers being told to the caller running again), and the whole wait until the observers are told.
  static func firstLoad(_ make: () throws -> RecordsView) async throws -> (view: RecordsView, onMain: Duration, total: Duration) {
    let began = ContinuousClock.now
    let view = try make()
    let made = ContinuousClock.now
    let told = try await notification(of: view)()
    let resumed = ContinuousClock.now
    guard case .loaded = view.state else { throw BenchError("the view was told of a change but not loaded") }
    return (view, (made - began) + (resumed - told), told - began)
  }

  // Waits for the next time the view's observers are told, and answers when that was.
  static func notification(of view: RecordsView) -> () async throws -> ContinuousClock.Instant {
    let (told, tell) = AsyncStream<ContinuousClock.Instant>.makeStream()
    withObservationTracking { _ = view.state } onChange: {
      tell.yield(ContinuousClock.now)
      tell.finish()
    }
    return {
      var iterator = told.makeAsyncIterator()
      guard let at = await iterator.next() else { throw BenchError("the view was never told") }
      return at
    }
  }
}

// When each of a store's transactions committed, from its commit hook. Transactions an engine loop runs back to back (a
// pull answer's sample then its pages, a push answer's sample then its results) are timed each from the commit before
// it: how long it held the writer, which a commit arriving meanwhile waits for.
final class TransactionTimes: Sendable {
  let commits = Mutex<[(tx: TxName, at: ContinuousClock.Instant)]>([])

  var crashPoints: CrashPoints {
    CrashPoints { [self] point in
      guard case .afterCommit(let tx) = point else { return }
      commits.withLock { $0.append((tx, ContinuousClock.now)) }
    }
  }

  func reset() {
    commits.withLock { $0 = [] }
  }

  // When the first `tx` since the last reset committed.
  func firstCommit(of tx: TxName) -> ContinuousClock.Instant? {
    commits.withLock { $0.first { $0.tx == tx }?.at }
  }

  // Each `tx` since the last reset, timed from the commit before it.
  func durations(of tx: TxName, as measure: String) -> Samples {
    var samples = Samples(measure)
    let commits = commits.withLock { $0 }
    for (index, commit) in commits.enumerated() where index > 0 && commit.tx == tx { samples.add(commit.at - commits[index - 1].at) }
    return samples
  }

  // One line for each kind of transaction but commits since the last reset. The first of a loop's run is timed from
  // whatever committed before it, the network's wait included, so a kind's max may overstate its hold. The kinds a loop
  // runs back to back (a page's chunks and settling slices, a push answer's result batches, the epoch change after
  // either, the sweep) carry §2.5's WRITER_SLICE_MS as their budget.
  func reportEachKind(_ context: String) {
    let sliced: [TxName] = [.pullPage, .settle, .results, .epochChange, .sweep]
    for tx in TxName.allCases where tx != .commit {
      let samples = durations(of: tx, as: "transaction · \(tx.rawValue) \(context)")
      if !samples.ms.isEmpty { samples.report(p95Budget: sliced.contains(tx) ? Double(Constants.writerSliceMs) : nil) }
    }
  }
}

// The process's memory at one moment: the bytes its malloc zones hold for live allocations, which is what the engine
// allocates whatever the allocator kept from work before; and its physical footprint, the figure iOS holds an app to,
// which counts pages the allocator kept.
struct Memory {
  let heap: Int
  let footprint: Int

  static func now() -> Memory {
    var stats = malloc_statistics_t()
    malloc_zone_statistics(nil, &stats)
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(task_self_trap(), task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return Memory(heap: stats.size_in_use, footprint: result == KERN_SUCCESS ? Int(info.phys_footprint) : 0)
  }

  // The growth from `before` to this reading, as report fields.
  func growth(since before: Memory, as name: String) -> [(String, String)] {
    [(name + "Heap", Bench.format(bytes: heap - before.heap)), (name + "Footprint", Bench.format(bytes: footprint - before.footprint))]
  }

  // The highest heap and footprint seen while `body` runs, each sampled every millisecond on a thread of its own.
  static func peak<Value>(during body: () async throws -> Value) async rethrows -> (value: Value, peak: Memory) {
    let sampler = PeakSampler()
    sampler.start()
    let value = try await body()
    return (value, sampler.stop())
  }
}

final class PeakSampler: @unchecked Sendable {
  let lock = NSLock()
  var peak = Memory.now()
  var running = true
  let finished = DispatchSemaphore(value: 0)

  func start() {
    Thread.detachNewThread { [self] in
      while lock.withLock({ running }) {
        sample()
        usleep(1_000)
      }
      finished.signal()
    }
  }

  func sample() {
    let now = Memory.now()
    lock.withLock { peak = Memory(heap: max(peak.heap, now.heap), footprint: max(peak.footprint, now.footprint)) }
  }

  func stop() -> Memory {
    lock.withLock { running = false }
    finished.wait()
    sample()
    return lock.withLock { peak }
  }
}
