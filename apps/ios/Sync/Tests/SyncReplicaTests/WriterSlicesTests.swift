import SyncCore
import SyncReplica
import SyncTesting
import Testing

// §2.5 each sliced step sized by how long the last of its kind held the writer, driven on a fake clock by a cost model.
struct WriterSlicesTests {
  // A step holds 1 ms and 1 ms more per 64 rows: the size doubles, then settles at 682, near the most within the 12 ms aim.
  @Test func eachStepsHoldSizesTheNextTowardTheAimWithoutPassingIt() {
    var slices = WriterSlices(.measured)
    #expect(Self.chunks(6, of: &slices) { _, rows in 1 + (Int64(rows) + 63) / 64 } == [
      "64 rows 2 ms", "128 rows 3 ms", "256 rows 5 ms", "512 rows 9 ms", "682 rows 12 ms", "682 rows 12 ms",
    ])
  }

  // A device slower than the start assumes, 1 ms and 1 ms more per 2 rows: only the first step overruns WRITER_SLICE_MS.
  @Test func onASlowerDeviceOnlyTheFirstStepOverrunsTheBudget() {
    var slices = WriterSlices(.measured)
    #expect(Self.chunks(4, of: &slices) { _, rows in 1 + (Int64(rows) + 1) / 2 } == [
      "64 rows 33 ms", "23 rows 13 ms", "21 rows 12 ms", "21 rows 12 ms",
    ])
  }

  // Rows three times dearer from the sixth step: that step overruns by the rise, and the size falls to what fits the aim.
  @Test func aCostThatRisesOverrunsOnceByTheRiseAndSettlesAgain() {
    var slices = WriterSlices(.measured)
    #expect(Self.chunks(9, of: &slices) { step, rows in 1 + ((step < 5 ? 1 : 3) * Int64(rows) + 63) / 64 } == [
      "64 rows 2 ms", "128 rows 3 ms", "256 rows 5 ms", "512 rows 9 ms", "682 rows 12 ms", "682 rows 33 ms", "248 rows 13 ms",
      "228 rows 12 ms", "228 rows 12 ms",
    ])
  }

  // A hold the clock misses doubles the size once: the step after it holds within the budget, and the size comes back.
  @Test func aHoldTheClockMissesStaysWithinTheBudgetByOneStepsGrowthAtMost() {
    var slices = WriterSlices(.measured)
    #expect(Self.chunks(10, of: &slices) { step, rows in step == 5 ? 0 : 1 + (Int64(rows) + 63) / 64 } == [
      "64 rows 2 ms", "128 rows 3 ms", "256 rows 5 ms", "512 rows 9 ms", "682 rows 12 ms", "682 rows 0 ms", "1364 rows 23 ms",
      "711 rows 13 ms", "656 rows 12 ms", "656 rows 12 ms",
    ])
  }

  // Steps the clock never sees double up to the ceiling; a partial step shrinks the size only past the aim, and one that took nothing never.
  @Test func quickStepsStopAtTheCeilingAndPartialStepsOnlyShrinkPastTheAim() {
    var slices = WriterSlices(.measured)
    #expect(Self.chunks(9, of: &slices) { _, _ in 0 }.map { $0.split(separator: " ")[0] } == [
      "64", "128", "256", "512", "1024", "2048", "4096", "4096", "4096",
    ])
    let scope = ScopeRef.product("probe")
    slices.record(.chunk(scope), took: 10, held: .milliseconds(5))
    slices.record(.chunk(scope), took: 0, held: .milliseconds(500))
    #expect(slices.size(.chunk(scope)) == 4_096)
    slices.record(.chunk(scope), took: 10, held: .milliseconds(50))
    #expect(slices.size(.chunk(scope)) == 2)
  }

  // However long a step held the writer, the next takes one at least, so a page or an answer always ends.
  @Test func aStepThatOverrunsFarLeavesOneAtLeast() {
    var slices = WriterSlices(.measured)
    slices.record(.settle, took: 1, held: .milliseconds(50))
    slices.record(.results, took: 16, held: .seconds(30))
    #expect([slices.size(.settle), slices.size(.results)] == [1, 1])
  }

  // Each scope's chunks keep a size of their own, so a cheap scope never oversizes a dear one; settling and batches keep one a kind.
  @Test func eachScopesChunksAndEachKindOfEntryStepKeepTheirOwnSize() {
    var slices = WriterSlices(.measured)
    let (cheap, dear) = (ScopeRef.product("probe"), ScopeRef.tree("b_00000001"))
    for _ in 0..<3 { slices.record(.chunk(cheap), took: slices.size(.chunk(cheap)), held: .milliseconds(1)) }
    slices.record(.chunk(dear), took: 64, held: .milliseconds(24))
    slices.record(.settle, took: 32, held: .milliseconds(3))
    #expect([slices.size(.chunk(cheap)), slices.size(.chunk(dear)), slices.size(.chunk(.tree("b_00000002"))), slices.size(.settle),
             slices.size(.results)] == [512, 32, 64, 64, 16])
  }

  // Fixed sizes never move, whatever a step held, and a size below one is one.
  @Test func fixedSizesAreOneAtLeastAndNeverMove() {
    var slices = WriterSlices(.fixed(.init(chunkRows: 0, settleEntries: 3, resultsPerBatch: -1)))
    let steps: [SlicedStep] = [.chunk(.product("probe")), .settle, .results]
    for step in steps { slices.record(step, took: 1, held: .milliseconds(100)) }
    #expect(steps.map(slices.size) == [1, 3, 1])
  }

  // `count` chunks of one scope on a fake clock, the step numbered from 0 of `rows` rows holding the writer `hold(step, rows)` ms.
  static func chunks(_ count: Int, of slices: inout WriterSlices, hold: (Int, Int) -> Int64) -> [String] {
    let (clock, scope) = (SimClock(wallMs: 0), ScopeRef.product("probe"))
    return (0..<count).map { step in
      let rows = slices.size(.chunk(scope))
      let held = clock.measure { clock.advance(ms: hold(step, rows)) }
      slices.record(.chunk(scope), took: rows, held: held)
      return "\(rows) rows \(held.components.seconds * 1_000 + held.components.attoseconds / 1_000_000_000_000_000) ms"
    }
  }
}
