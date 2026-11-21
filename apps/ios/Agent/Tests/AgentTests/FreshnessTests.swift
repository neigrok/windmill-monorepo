import Agent
import Testing

struct FreshnessTests {
  @Test func staleRequiresARunningRecordAndAConfirmedServerClock() {
    #expect(TurnFreshness.isStale(state: "running", syncLive: true, serverNow: 1_800_100, serverUpdatedAt: 100))
    #expect(!TurnFreshness.isStale(state: "running", syncLive: true, serverNow: 1_800_099, serverUpdatedAt: 100))
    #expect(!TurnFreshness.isStale(state: "running", syncLive: false, serverNow: 99_000_000, serverUpdatedAt: 100))
    #expect(!TurnFreshness.isStale(state: "running", syncLive: true, serverNow: nil, serverUpdatedAt: 100))
    #expect(!TurnFreshness.isStale(state: "running", syncLive: true, serverNow: 99_000_000, serverUpdatedAt: nil))
    #expect(!TurnFreshness.isStale(state: "completed", syncLive: true, serverNow: 99_000_000, serverUpdatedAt: 100))
    #expect(!TurnFreshness.isStale(state: "running", syncLive: true, serverNow: 1, serverUpdatedAt: 100))
  }
}
