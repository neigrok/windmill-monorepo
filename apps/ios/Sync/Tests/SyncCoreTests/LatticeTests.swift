import SyncCore
import SyncTesting
import Testing

// §11.2 property 1: the join laws, over pools where equal stamps, equal ranks and absent registers are common.

struct LatticeTests {
  @Test func registerJoinsObeyTheLaws() throws {
    var random = SeededRandom.fromEnvironment()
    let rank = Rank([("draft", 0), ("review", 1), ("done", 2), ("dropped", 2)])
    for _ in 0..<3_000 {
      let values: [JSON] = ["a", "b", 9, 10, false, .null, ["a": 3], ["b": 1, "a": 2]]
      let register = { (random: inout SeededRandom) in random.chance(0.2) ? nil : Register(random.pick(values), random.stamp()) }
      let ranked = { (random: inout SeededRandom) in
        random.chance(0.2) ? nil : Register(.string(random.pick(["draft", "review", "done", "dropped"])), random.stamp())
      }
      let life = { (random: inout SeededRandom) in random.chance(0.2) ? nil : Life(random.pick([.alive, .dead]), random.stamp()) }
      let born = { (random: inout SeededRandom) in random.chance(0.2) ? nil : random.stamp() }

      try checkLaws(Join.lww, register(&random), register(&random), register(&random), seed: random.seed)
      try checkLaws(Join.fww, register(&random), register(&random), register(&random), seed: random.seed)
      try checkLaws({ try Join.ranked($0, $1, rank: rank) }, ranked(&random), ranked(&random), ranked(&random), seed: random.seed)
      try checkLaws(Join.life, life(&random), life(&random), life(&random), seed: random.seed)
      try checkLaws(Join.born, born(&random), born(&random), born(&random), seed: random.seed)
    }
  }

  @Test func recordJoinObeysTheLaws() throws {
    var random = SeededRandom.fromEnvironment()
    let card = try #require(try Corpus.probeRegistry().type("card"))
    for _ in 0..<2_000 {
      let lattice = { (random: inout SeededRandom) -> Lattice in
        var fields: [String: Register] = [:]
        if random.chance(0.6) { fields["title"] = Register(.string(random.pick(["A", "B"])), random.stamp()) }
        if random.chance(0.6) { fields["claim"] = Register(.string(random.pick(["ann", "bob"])), random.stamp()) }
        if random.chance(0.6) { fields["tier"] = Register(.string(random.pick(["draft", "done", "dropped"])), random.stamp()) }
        return Lattice(
          life: random.chance(0.3) ? nil : Life(random.pick([.alive, .dead]), random.stamp()),
          born: random.chance(0.3) ? nil : random.stamp(),
          fields: fields)
      }
      let join = { (a: Lattice?, b: Lattice?) throws -> Lattice? in try Join.record(card, a ?? Lattice(), b ?? Lattice()) }
      try checkLaws(join, lattice(&random), lattice(&random), lattice(&random), seed: random.seed)
    }
  }

  @Test func aFieldTheRegistryDoesNotKnowIsKeptFromOneSideAndRefusedFromTwo() throws {
    let card = try #require(try Corpus.probeRegistry().type("card"))
    let shine = Register("gold", try Stamp("4:0:a"))
    let kept = try Join.record(card, Lattice(fields: ["shine": shine]), Lattice())
    #expect(kept == Lattice(fields: ["shine": shine]))
    #expect(throws: JoinError.unknownFieldOnBothSides("shine")) {
      try Join.record(card, Lattice(fields: ["shine": shine]), Lattice(fields: ["shine": shine]))
    }
  }

  func checkLaws<Value: Equatable>(
    _ join: (Value?, Value?) throws -> Value?, _ a: Value?, _ b: Value?, _ c: Value?, seed: UInt64
  ) throws {
    #expect(try join(a, a) == a, "idempotent, seed \(seed)")
    #expect(try join(a, nil) == a, "absent is the identity, seed \(seed)")
    #expect(try join(a, b) == join(b, a), "commutative, seed \(seed)")
    #expect(try join(join(a, b), c) == join(a, join(b, c)), "associative, seed \(seed)")
  }
}
