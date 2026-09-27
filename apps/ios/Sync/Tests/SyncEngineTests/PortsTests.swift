import Foundation
import SyncCore
import SyncEngine
import SyncTesting
import Testing

// The production ports that need no device: the system clock's readings and the identities the engine mints (D-2, D-3).

struct PortsTests {
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
}
