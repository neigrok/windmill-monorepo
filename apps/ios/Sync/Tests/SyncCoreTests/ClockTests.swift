import SyncCore
import Testing

// §10.4 a clock reading's boot is compared by its bytes, as `jumped(since:)` compares it.

struct ClockTests {
  @Test func readingsOfLookAlikeBootsAreDifferent() {
    let readings = ["\u{E9}", "e\u{301}"].map { ClockReading(wall: 1, mono: 1, boot: $0) }
    #expect(Set(readings).count == 2)
    #expect(readings[1].jumped(since: readings[0]))
  }
}
