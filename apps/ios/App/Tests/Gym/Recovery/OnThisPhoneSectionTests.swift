import Foundation
import Testing
import DomainKit
import DomainKitTesting
import GymDomain
import SyncCore
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

@Suite @MainActor struct OnThisPhoneSectionTests {
  // Every reason the log or the phone can give is one line of at most twelve words that names its way out, and the primary
  // Inspect offers for it; a spent identity's only way out is Discard.
  @Test func everyReasonNamesItsWayOut() {
    let table = WorkoutRecovery.Reason.allCases.map { "\($0.rawValue) | \($0.line(stranded: 1)) | \($0.primary?.title ?? "Discard only")" }
    #expect(table == [
      "session-open | Your account has an open workout — keep this one as finished. | Keep as finished",
      "session-overlap | Overlaps another workout — fix its times. | Fix workout",
      "id-taken | Already added once — discard this copy. | Discard only",
      "bad-instant | Its times don’t line up — fix the times. | Fix workout",
      "too-many-sets | Over 200 sets — remove some, then retry. | Fix workout",
      "invalid-set | Refused by the log — fix the workout, then retry. | Fix workout",
      "unknown-exercise | A movement is missing — fix its sets, then retry. | Fix workout",
      "session-finished | A set missed its workout — retry puts it back. | Retry",
      "unsent | Not on your log yet — retry to add it. | Retry",
      "other | Refused by the log — fix the workout, then retry. | Fix workout",
    ])
    #expect(WorkoutRecovery.Reason.allCases.allSatisfy { $0.line(stranded: 3).split(separator: " ").count <= 12 })
    #expect(WorkoutRecovery.Reason.strandedSets.line(stranded: 3) == "3 sets missed their workout — retry puts them back.")
  }

  // The list puts the workouts that need the lifter before the ones on their way, and leaves out a section with none.
  @Test func needsYouComesBeforeAdding() {
    let row = { (id: String, reason: String?) in WaitingRow(id: ID(RecordID(id)), title: id, reason: reason) }
    let rows = [row("sending", nil), row("unsent", "Not on your log yet — retry to add it."), row("landing", nil)]
    let read = { (rows: [WaitingRow]) in OnThisPhoneList.sections(rows).map { "\($0.title): \($0.rows.map(\.title).joined(separator: ", "))" } }
    #expect(read(rows) == ["Needs you: unsent", "Adding: sending, landing"])
    #expect(read(rows.filter { $0.reason == nil }) == ["Adding: sending, landing"])
    #expect(read([]) == [])
    #expect(OnThisPhoneSection.summary(rows) == "1 needs you")
  }

  // Keep, Retry and Save and retry say why they wait: a paused account waits on a sign-in, a log never read on a connection.
  @Test func aWaitingRecoverySaysWhatItWaitsOn() {
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let gym = GymModel(runner: harness.runner)
    let log = { (complete: Bool) in
      TrainingLog(sessions: [], sets: [], moment: Moment(now: Instant(ms: 1_790_424_000_000), zone: FixedZone(offsetSeconds: 0)),
                  firstPullComplete: complete, catalogue: Catalogue(custom: [], names: []))
    }
    gym.log = log(false)
    #expect(gym.recoveryWait == "Adding it needs a connection.")
    gym.authPaused = true
    #expect(gym.recoveryWait == "Sign in again to add it.")
    gym.authPaused = false; gym.log = log(true)
    #expect(gym.recoveryWait == nil)
  }
}
