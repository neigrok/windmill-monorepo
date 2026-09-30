import SyncCore
import SyncReplica
import Testing

// §7.9 the scopes in doubt, every draw at the top of its range: each re-pull drawn on the scope's own k, and when k
// returns to 0: after one unbroken stretch of 30 s followed and not in doubt, on leaving the set, and at a new seat.

struct BackoffTests {
  static let tree = ScopeRef.tree("b_00000001")
  static let overlay = ScopeRef.overlay("b_00000001")

  struct Highest: RandomSource {
    func next() -> UInt64 { .max }
  }

  // An ignored end draws the first re-pull, a further one while in doubt changes nothing, each re-pull that ends in doubt
  // draws the next on the scope's own k up to 30 s, and an applied rows page ends the doubt.
  @Test func aDoubtDrawsEachRePullOnTheScopesOwnBackoffUntilARowsPageEndsIt() {
    var doubts = Doubts()
    doubts.end(Self.tree, at: 0, random: Highest())
    #expect(doubts.inDoubt(Self.tree) && doubts.nextDue == 1_000)
    doubts.end(Self.tree, at: 500, random: Highest())
    #expect(doubts.nextDue == 1_000 && doubts.k(Self.tree) == 1)
    #expect(doubts.due(by: 999) == [] && doubts.due(by: 1_000) == [Self.tree])
    #expect(doubts.nextDue == nil)
    var dues: [Int64] = []
    var now: Int64 = 1_000
    for _ in 0..<6 {
      doubts.repulled(Self.tree, at: now, random: Highest())
      now = doubts.nextDue!
      dues.append(now)
      #expect(doubts.due(by: now) == [Self.tree])
    }
    #expect(dues == [3_000, 7_000, 15_000, 31_000, 61_000, 91_000])
    doubts.rows(Self.tree, at: now)
    doubts.repulled(Self.tree, at: now, random: Highest())
    #expect(!doubts.inDoubt(Self.tree) && doubts.nextDue == nil && doubts.k(Self.tree) == 7)
  }

  // `k` returns to 0 once the scope stayed followed, not in doubt, for 30 s; when it leaves the subscription set; and at
  // a change of the seat.
  @Test func aScopesKReturnsToZeroAfterThirtySecondsFollowedOnLeavingTheSetAndAtANewSeat() {
    var doubts = Doubts()
    doubts.end(Self.tree, at: 0, random: Highest())
    doubts.rows(Self.tree, at: 0)
    doubts.follow([Self.tree], at: 1_000)
    doubts.end(Self.tree, at: 30_999, random: Highest())
    #expect(doubts.k(Self.tree) == 2 && doubts.nextDue == 32_999)
    doubts.rows(Self.tree, at: 31_000)
    doubts.follow([Self.tree], at: 40_000)
    doubts.follow([], at: 50_000)
    doubts.follow([Self.tree], at: 60_000)
    doubts.end(Self.tree, at: 90_000, random: Highest())
    #expect(doubts.k(Self.tree) == 1 && doubts.nextDue == 91_000)
    doubts.end(Self.overlay, at: 90_000, random: Highest())
    doubts.keep([Self.overlay])
    #expect(doubts.k(Self.tree) == 0 && !doubts.inDoubt(Self.tree) && doubts.nextDue == 91_000)
    doubts.clear()
    #expect(doubts.k(Self.overlay) == 0 && doubts.nextDue == nil)
  }

  // A stretch of 39 s followed resets k however it ended: here the socket closed before the next ignored end.
  @Test func kResetsAfterThirtySecondsFollowedEvenIfTheSocketClosedSince() {
    var doubts = Doubts()
    doubts.end(Self.tree, at: 0, random: Highest())
    #expect(doubts.due(by: 1_000) == [Self.tree])
    doubts.repulled(Self.tree, at: 1_000, random: Highest())
    doubts.rows(Self.tree, at: 2_000)
    #expect(doubts.k(Self.tree) == 2)
    doubts.follow([Self.tree], at: 10_000)
    doubts.follow([], at: 49_000)
    doubts.end(Self.tree, at: 60_000, random: Highest())
    #expect(doubts.k(Self.tree) == 1 && doubts.nextDue == 61_000)
  }

  // Time followed while in doubt counts for nothing: 40 s followed in doubt, then another ignored end, leaves k as the
  // doubt's re-pulls drew it.
  @Test func timeFollowedInDoubtCountsForNothing() {
    var doubts = Doubts()
    doubts.end(Self.tree, at: 0, random: Highest())
    doubts.follow([Self.tree], at: 1_000)
    #expect(doubts.due(by: 1_000) == [Self.tree])
    doubts.end(Self.tree, at: 41_000, random: Highest())
    doubts.repulled(Self.tree, at: 41_000, random: Highest())
    #expect(doubts.k(Self.tree) == 2 && doubts.nextDue == 43_000)
  }

  // A stretch begins when the doubt of a scope still followed ends: 30 s from the rows page returns k to 0.
  @Test func aStretchBeginsWhenTheDoubtOfAFollowedScopeEnds() {
    var doubts = Doubts()
    doubts.follow([Self.tree], at: 0)
    doubts.end(Self.tree, at: 5_000, random: Highest())
    doubts.rows(Self.tree, at: 10_000)
    doubts.end(Self.tree, at: 39_999, random: Highest())
    #expect(doubts.k(Self.tree) == 2 && doubts.nextDue == 41_999)
    doubts.rows(Self.tree, at: 40_000)
    doubts.end(Self.tree, at: 70_000, random: Highest())
    #expect(doubts.k(Self.tree) == 1 && doubts.nextDue == 71_000)
  }

  // Time unfollowed counts for nothing: two stretches of 10 s and 5 s are not one of 30 s.
  @Test func timeUnfollowedCountsForNothing() {
    var doubts = Doubts()
    doubts.end(Self.tree, at: 0, random: Highest())
    doubts.rows(Self.tree, at: 0)
    doubts.follow([Self.tree], at: 1_000)
    doubts.follow([], at: 11_000)
    doubts.follow([Self.tree], at: 40_000)
    doubts.end(Self.tree, at: 45_000, random: Highest())
    #expect(doubts.k(Self.tree) == 2 && doubts.nextDue == 47_000)
  }
}
