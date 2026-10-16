import Foundation
import Testing
import DomainKit
@testable import Windmill

@Suite struct GymFormatTests {
  func formatter(today: String = "2026-10-14", offsetSeconds: Int = 0, locale: String = "en_US") -> GymDate {
    let day = LocalDay(today)!
    let noon = Instant(ms: Int64(LocalDay("1970-01-01")!.days(until: day)) * 86_400_000 + 43_200_000 - Int64(offsetSeconds) * 1_000)
    return GymDate(Moment(now: noon, zone: FixedZone(offsetSeconds: offsetSeconds)), locale: Locale(identifier: locale))
  }

  @Test func theDayFormsNameTodayYesterdayAndTheYearOnlyWhenItIsAnotherOne() {
    let dates = formatter()
    #expect([dates.day(LocalDay("2026-10-14")!), dates.day(LocalDay("2026-10-13")!), dates.day(LocalDay("2026-09-23")!),
             dates.day(LocalDay("2025-09-23")!)] == ["Today", "Yesterday", "Sep 23", "Sep 23, 2025"])
    #expect([dates.day(LocalDay("2026-10-14")!, inSentence: true), dates.day(LocalDay("2026-10-13")!, inSentence: true),
             dates.day(LocalDay("2026-09-23")!, inSentence: true)] == ["today", "yesterday", "Sep 23"])
    #expect([dates.rowDay(LocalDay("2026-10-14")!), dates.rowDay(LocalDay("2026-09-23")!)] == ["Wed 14", "Wed 23"])
    #expect([dates.subtitle(LocalDay("2026-09-23")!), dates.subtitle(LocalDay("2025-09-23")!)] == ["Wed, Sep 23", "Tue, Sep 23, 2025"])
    let newYear = formatter(today: "2026-01-01")
    #expect([newYear.day(LocalDay("2025-12-31")!), newYear.day(LocalDay("2025-12-30")!), newYear.subtitle(LocalDay("2025-12-30")!)]
            == ["Yesterday", "Dec 30, 2025", "Tue, Dec 30, 2025"])
  }

  @Test func aSpanKeepsItsFirstDayAndBothTimesAcrossMidnight() {
    let dates = formatter()
    #expect(dates.span(Instant(ms: 1_790_164_800_000), Instant(ms: 1_790_167_500_000)) == "Wed, Sep 23 · 12:00\u{2009}–\u{2009}12:45\u{202F}PM")
    #expect(dates.span(Instant(ms: 1_791_848_580_000), Instant(ms: 1_791_850_800_000)) == "Mon, Oct 12 · 11:43\u{202F}PM – 12:20\u{202F}AM")
    #expect(dates.span(Instant(ms: 1_790_164_800_000), nil) == "Wed, Sep 23 · 12:00\u{202F}PM")
    #expect(dates.time(Instant(ms: 1_791_848_580_000)) == "11:43\u{202F}PM")
  }

  @Test func anInstantIsReadOnTheDayItsZonePutsItIn() {
    let east = formatter(offsetSeconds: 36_000), evening = Instant(ms: 1_790_193_600_000)
    #expect([east.rowDay(evening), east.day(evening), east.subtitle(evening), east.time(evening)]
            == ["Thu 24", "Sep 24", "Thu, Sep 24", "6:00\u{202F}AM"])
    #expect(east.span(Instant(ms: 1_791_848_580_000), Instant(ms: 1_791_850_800_000)) == "Tue, Oct 13 · 9:43\u{2009}–\u{2009}10:20\u{202F}AM")
  }

  @Test func theFormsFollowThePersonsLocale() {
    let british = formatter(locale: "en_GB"), german = formatter(locale: "de_DE")
    #expect([british.rowDay(LocalDay("2026-09-23")!), british.day(LocalDay("2026-09-23")!), british.subtitle(LocalDay("2025-09-23")!),
             british.span(Instant(ms: 1_791_848_580_000), Instant(ms: 1_791_850_800_000))]
            == ["Wed 23", "23 Sep", "Tue, 23 Sep 2025", "Mon 12 Oct · 23:43 – 00:20"])
    #expect([german.day(LocalDay("2026-09-23")!), german.subtitle(LocalDay("2026-09-23")!),
             german.span(Instant(ms: 1_790_164_800_000), Instant(ms: 1_790_167_500_000))]
            == ["23. Sept.", "Mi. 23. Sept.", "Mi. 23. Sept. · 12:00–12:45"])
  }
}
