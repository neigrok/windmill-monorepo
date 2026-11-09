import Foundation
import Testing
import SyncCore
import GymDomain
import JournalDomain
@testable import Windmill

// Each message the catalog varies by count reads, for every count it can receive, as the English the app spells, its
// digits as Swift writes them.
@Suite @MainActor struct LocalizableTests {
  static let counts = [0, 1, 2, 3, 4, 5, 11, 12, 21, 22, 25, 101, 111, 1000, 1001]

  func many(_ count: Int, _ one: String, _ other: String) -> String { "\(count) \(count == 1 ? one : other)" }

  @Test func theCopyLocaleKeepsDigitsPlainWhereARegionGroupsThem() {
    #expect(String(localized: "\(1234) sets", locale: Locale(identifier: "de_DE")) == "1.234 sets")
    #expect(String(localized: "\(1234) sets", locale: Locale(identifier: "en_US")) == "1,234 sets")
    #expect(String(localized: "\(1234) sets", locale: .copy) == "1234 sets")
  }

  @Test func signOutAndDeleteAccountCountTheUnconfirmedChanges() {
    for count in Self.counts.dropFirst() {
      let them = count == 1 ? "it" : "them"
      #expect(AppModel.signOutMessage(unsent: count) == "\(count == 1 ? "1 change hasn’t" : "\(count) changes haven’t") been confirmed by your account yet. Keep \(them) on this phone until you sign in again, or discard \(them) from this phone.")
      #expect(AccountDeletion.unconfirmedLine(count) == (count == 1
        ? "1 change on this phone hasn’t been confirmed by your account. It is deleted too."
        : "\(count) changes on this phone haven’t been confirmed by your account. They are deleted too."))
    }
  }

  @Test func theSignInQuestionCountsEachKindItNames() {
    let kinds = [(Session.type, "workout", "workouts"), (Routine.type, "routine", "routines"), (WeighIn.type, "weigh-in", "weigh-ins"),
                 (Exercise.type, "movement", "movements"), (Note.type, "note", "notes"), (Page.type, "journal page", "journal pages")]
    for count in Self.counts.dropFirst() {
      for (type, one, other) in kinds {
        #expect(AdoptionQuestion(counts: [type == Page.type ? .journal : .gym: [type: count]]).phrase == many(count, one, other))
      }
    }
    for count in Self.counts {
      #expect(AdoptionQuestion(counts: [.gym: [GymPreferences.type: count]]).phrase == many(count, "change", "changes"))
    }
  }

  @Test func bringingItBackCountsWhatLandedOfWhatTheAccountHolds() throws {
    for total in Self.counts.dropFirst() {
      var restore = try #require(SignInRestore(method: "email", holdings: [
        "journal": .init(count: total, lastWrittenAt: 1), "gym": .init(count: total, lastWrittenAt: 2),
      ], at: Date(timeIntervalSince1970: 0)))
      restore.land([.journal: total - 1, .gym: total], arrived: [], at: Date(timeIntervalSince1970: 1))
      #expect(restore.count(.journal) == "\(total - 1) of \(many(total, "page", "pages"))")
      #expect(restore.count(.gym) == "\(total) of \(many(total, "workout", "workouts"))")
    }
  }

  @Test func echoesCountTheirPassagesAndStampTheirDistance() {
    for count in Self.counts {
      #expect(JournalEchoTab.label(count) == "\(many(count, "passage", "passages")) you wrote before")
    }
    #expect(JournalEchoStamp.distance(from: "2026-11-08", to: "2026-11-22") == "2 WK")
    #expect(JournalEchoStamp.distance(from: "2026-07-22", to: "2026-11-22") == "4 MO")
    #expect(JournalEchoStamp.distance(from: "2004-11-22", to: "2026-11-22") == "22 YR")
    #expect(JournalEchoStamp.date("2025-05-29", namedYear: nil) == "29 MAY 2025")
  }

  @Test func theLiveActivityPlacesTheSetInItsPlan() {
    func place(_ ordinal: Int, of planned: Int?) -> String? {
      WorkoutActivityAttributes.ContentState(title: "", movement: "Squat", load: "", reps: 5, workingSetOrdinal: ordinal,
        plannedWorkingSetCount: planned, startedAt: .distantPast, lastSetAt: nil, restSeconds: nil, staleAt: .distantFuture,
        offer: nil, effort: nil).place
    }
    #expect([place(2, of: 4), place(21, of: 22), place(23, of: 22), place(1001, of: nil)] == ["Set 2 of 4", "Set 21 of 22", "Set 23", "Set 1001"])
  }
}
