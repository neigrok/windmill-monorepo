import SyncCore

// §7.4's retry backoff, which every loop draws from, and §7.9's scopes in doubt, each re-pulled on a backoff of its own.

// §7.4's backoff, which every loop draws its retries from: a sleep of `max(floor, random(0, min(ceiling, 1 s · 2^k)))`,
// full jitter from the injected source, after which k grows by one; the bound stops doubling once it passes the ceiling.
package struct Backoff: Sendable {
  package private(set) var k = 0

  package init() {}

  package mutating func next(ceilingMs: Int64, floorMs: Int64, random: any RandomSource) -> Int64 {
    var bound = Constants.backoffBaseMs
    for _ in 0..<k where bound < ceilingMs { bound *= 2 }
    var draws = Draws(source: random)
    let sleep = Int64.random(in: 0...min(ceilingMs, bound), using: &draws)
    k += 1
    return max(floorMs, sleep)
  }

  package mutating func reset() {
    k = 0
  }
}

// §7.9 the scopes in doubt, which the puller and the live socket share, on the monotonic clock; a process starts with none.
package struct Doubts: Sendable {
  // Appendix B's re-pull backoff: its ceiling, and how long a scope stays followed, not in doubt, before `k` resets.
  static let ceilingMs: Int64 = 30_000
  static let settledMs: Int64 = 30_000

  struct Scope {
    var backoff = Backoff()
    var inDoubt = false
    var due: Int64?
    var followed = false
    var followedSince: Int64?

    // One unbroken stretch followed, not in doubt, of `settledMs` or more returns `k` to 0, however the stretch ends.
    mutating func settle(at now: Int64) {
      if let since = followedSince, now - since >= Doubts.settledMs { backoff.reset() }
    }
  }

  var scopes: [ScopeRef: Scope] = [:]

  package init() {}

  // `followed` is all the socket follows from `now`: a newly followed scope not in doubt starts a stretch; a dropped one ends it.
  package mutating func follow(_ followed: Set<ScopeRef>, at now: Int64) {
    for scope in Set(scopes.keys).union(followed) {
      var state = scopes[scope] ?? Scope()
      state.settle(at: now)
      state.followed = followed.contains(scope)
      if !state.followed {
        state.followedSince = nil
      } else if state.followedSince == nil && !state.inDoubt {
        state.followedSince = now
      }
      scopes[scope] = state
    }
  }

  // An ignored end at `now` ends the scope's stretch; a scope not yet in doubt comes into doubt, its first re-pull drawn.
  package mutating func end(_ scope: ScopeRef, at now: Int64, random: any RandomSource) {
    var state = scopes[scope] ?? Scope()
    state.settle(at: now)
    state.followedSince = nil
    if !state.inDoubt {
      state.inDoubt = true
      state.due = now + state.backoff.next(ceilingMs: Self.ceilingMs, floorMs: 0, random: random)
    }
    scopes[scope] = state
  }

  // The scopes whose re-pull is due by `now`, taken: each is drawn again only when its re-pull ends in doubt.
  package mutating func due(by now: Int64) -> Set<ScopeRef> {
    let due = Set(scopes.filter { $0.value.inDoubt && $0.value.due.map { $0 <= now } == true }.keys)
    for scope in due { scopes[scope]?.due = nil }
    return due
  }

  // A re-pull of `scope` ended at `now`, answered, failed or unanswered: still in doubt, its next re-pull is drawn.
  package mutating func repulled(_ scope: ScopeRef, at now: Int64, random: any RandomSource) {
    guard var state = scopes[scope], state.inDoubt, state.due == nil else { return }
    state.due = now + state.backoff.next(ceilingMs: Self.ceilingMs, floorMs: 0, random: random)
    scopes[scope] = state
  }

  // An applied rows page at `now` ends the scope's doubt and re-pull; a scope still followed starts a stretch.
  package mutating func rows(_ scope: ScopeRef, at now: Int64) {
    guard var state = scopes[scope], state.inDoubt else { return }
    state.inDoubt = false
    state.due = nil
    if state.followed { state.followedSince = now }
    scopes[scope] = state
  }

  package func inDoubt(_ scope: ScopeRef) -> Bool {
    scopes[scope]?.inDoubt == true
  }

  // The scope's `k`: how many re-pulls its backoff has drawn since it last reset.
  package func k(_ scope: ScopeRef) -> Int {
    scopes[scope]?.backoff.k ?? 0
  }

  // When the earliest re-pull ahead is due; nil when none is.
  package var nextDue: Int64? { scopes.values.compactMap(\.due).min() }

  // A scope that left the subscription set loses its doubt and its `k`.
  package mutating func keep(_ set: Set<ScopeRef>) {
    scopes = scopes.filter { set.contains($0.key) }
  }

  // A sign-in, a sign-out or a re-identify of the active replica ends every doubt and returns every `k` to 0.
  package mutating func clear() {
    scopes = [:]
  }
}
