import Foundation
import SyncCore
import SyncEngine
import SyncTesting
import Synchronization
import Testing

// The production ports that need no device: the system clock's readings and the identities the engine mints (D-2, D-3).

struct PortsTests {
  // §2.5: the writer passes to those that wait for it in the order they asked, so one that waits while a transaction holds
  // it goes before any that asks later.
  @Test(.timeLimit(.minutes(1))) func theWriterPassesInTheOrderItWasAskedFor() {
    let line = WriterLine()
    let order = Mutex<[String]>([])
    line.enter()
    var threads: [Thread] = []
    for name in ["first", "second", "third"] {
      let waiting = line.waiting
      let thread = Thread {
        line.enter()
        order.withLock { $0.append(name) }
        line.leave()
      }
      thread.start()
      threads.append(thread)
      while line.waiting == waiting {}
    }
    line.leave()
    while order.withLock({ $0.count }) < 3 {}
    #expect(order.withLock { $0 } == ["first", "second", "third"])
    #expect(line.waiting == 0)
  }

  @Test func theSystemClockReadsTheWallTheMonotonicClockAndTheBoot() throws {
    let clock = SystemClock()
    let before = Int64(Date().timeIntervalSince1970 * 1000)
    let first = clock.reading()
    let second = clock.reading()
    let after = Int64(Date().timeIntervalSince1970 * 1000)
    #expect((before...after).contains(first.wall))
    #expect(second.mono >= first.mono)
    #expect(first.boot == second.boot)
    #expect(first.boot != "boot-unknown")
    #expect(!second.jumped(since: first))
  }

  @Test func identitiesTakeTheirSpecifiedShapes() throws {
    let identities = Identities(random: SeededRandomSource(seed: 5))
    let shapes = [
      (identities.replicaID(), try Pattern("^rp_[0-9a-f]{32}$")),
      (try identities.actor().text, try Pattern("^r_[a-z0-9]{12}$")),
      (identities.gestureID(), try Pattern("^g_[a-z0-9]{24}$")),
      (identities.forkGuard(), try Pattern("^fg_[0-9a-f]{32}$")),
    ]
    #expect(shapes.filter { !$0.1.matches($0.0) }.map(\.0) == [])
    #expect(identities.replicaID() != identities.replicaID())
  }

  // §7.1 step 7: a minted gesture id holds at least 122 bits from the CSPRNG: 24 symbols, each drawn from 36, 124.1 bits.
  @Test func aGestureIdHoldsAtLeast122Bits() {
    let identities = Identities(random: SeededRandomSource(seed: 7))
    let drawn = (0..<400).map { _ in identities.gestureID() }
    #expect(Set(drawn.map { $0.prefix(2) }) == ["g_"])
    let symbols = drawn.map { $0.dropFirst(2) }
    #expect(Set(symbols.map(\.count)) == [24])
    #expect(Set(symbols.joined()) == Set("0123456789abcdefghijklmnopqrstuvwxyz"))
    #expect((24 * log2(36.0) * 10).rounded() / 10 == 124.1)
  }

  @Test func sessionTokensAreTheSameOnlyByteForByte() {
    #expect(Set([SessionToken("\u{E9}"), SessionToken("e\u{301}"), SessionToken("\u{E9}")]).count == 2)
  }
}
