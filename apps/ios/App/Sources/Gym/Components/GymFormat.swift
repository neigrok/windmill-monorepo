import SwiftUI
import DomainKit

// The one place a count's noun agrees with its number (docs/design/ios/ios-redesign.md §3).
nonisolated enum GymCount {
  static func of(_ count: Int, _ singular: String, plural: String? = nil) -> String {
    "\(count) \(noun(count, singular, plural: plural))"
  }

  // The noun alone, for a label that stands beside its value: *1 · Working set*.
  static func noun(_ count: Int, _ singular: String, plural: String? = nil) -> String {
    count == 1 ? singular : plural ?? singular + "s"
  }
}

// The one date formatter (docs/design/ios/ios-redesign.md §3 "Dates"): its forms in the person's locale and calendar,
// each day read in the zone the domain reads it in. No view orders a day and a month of its own.
nonisolated struct GymDate {
  let moment: Moment
  let locale: Locale
  let calendar: Calendar

  init(_ moment: Moment = Moment(now: Instant(Date()), zone: DeviceZone()), locale: Locale = .autoupdatingCurrent) {
    var calendar = locale.calendar
    calendar.timeZone = .gmt
    self.moment = moment; self.locale = locale; self.calendar = calendar
  }

  // *Wed 23*, only inside a month-sectioned list.
  func rowDay(_ day: LocalDay) -> String {
    draw(day, .dateTime.weekday(.abbreviated).day())
  }

  // *Sep 23*, the year only when it is not this one; *Today* and *Yesterday* as a value, lowercase inside a sentence.
  func day(_ day: LocalDay, inSentence: Bool = false) -> String {
    let relative = day == moment.today ? "Today" : day == moment.today.adding(days: -1) ? "Yesterday" : nil
    if let relative { return inSentence ? relative.lowercased() : relative }
    return draw(day, dated(day, .dateTime.day().month(.abbreviated)))
  }

  // *Wed, Sep 23*, the year only when it is not this one.
  func subtitle(_ day: LocalDay) -> String {
    draw(day, dated(day, .dateTime.weekday(.abbreviated).day().month(.abbreviated)))
  }

  // *September*, the year only when it is not this one: a month section's header, and the month a month moment names.
  func month(_ day: LocalDay) -> String { draw(day, dated(day, .dateTime.month(.wide))) }

  // *Aug*, a chart's month tick, the year only when it is not this one.
  func monthTick(_ day: LocalDay) -> String { draw(day, dated(day, .dateTime.month(.abbreviated))) }

  // *Wed, Sep 23 · 12:00–12:45 PM*. A span that crosses midnight keeps its first day and both times,
  // *Mon, Oct 12 · 11:43 PM – 12:20 AM*; one with no end yet is its day and its start.
  func span(_ start: Instant, _ end: Instant?) -> String {
    let day = subtitle(start), zone = moment.zone
    guard let end, end > start else { return "\(day) · \(time(start))" }
    guard LocalDay(end, in: zone) == LocalDay(start, in: zone), zone.offsetSeconds(at: end) == zone.offsetSeconds(at: start) else {
      return "\(day) · \(time(start)) – \(time(end))"
    }
    let times = Date.IntervalFormatStyle(locale: locale, calendar: locale.calendar, timeZone: timeZone(at: start)).hour().minute()
    return "\(day) · \(times.format(start.date..<end.date))"
  }

  // *11:43 PM*, the time alone, as a span draws it.
  func time(_ instant: Instant) -> String {
    Date.FormatStyle(locale: locale, calendar: locale.calendar, timeZone: timeZone(at: instant)).hour().minute().format(instant.date)
  }

  // *Sep 26 · 6:42 PM*, *Today · 6:42 PM*: a moment that needs its day and its time, joined here so no view joins them.
  func dayAndTime(_ instant: Instant, inSentence: Bool = false) -> String {
    "\(day(instant, inSentence: inSentence)) · \(time(instant))"
  }

  func rowDay(_ instant: Instant) -> String { rowDay(LocalDay(instant, in: moment.zone)) }
  func day(_ instant: Instant, inSentence: Bool = false) -> String { day(LocalDay(instant, in: moment.zone), inSentence: inSentence) }
  func subtitle(_ instant: Instant) -> String { subtitle(LocalDay(instant, in: moment.zone)) }

  // A form that names the year when the person's calendar puts the day in another year than today.
  func dated(_ day: LocalDay, _ form: Date.FormatStyle) -> Date.FormatStyle {
    calendar.isDate(noon(day), equalTo: noon(moment.today), toGranularity: .year) ? form : form.year()
  }

  // A day is drawn at its noon in UTC, so no offset can move it to its neighbour.
  func draw(_ day: LocalDay, _ form: Date.FormatStyle) -> String {
    var style = form
    style.locale = locale; style.calendar = calendar; style.timeZone = .gmt
    return style.format(noon(day))
  }

  func noon(_ day: LocalDay) -> Date {
    var gregorian = Calendar(identifier: .gregorian)
    gregorian.timeZone = .gmt
    return gregorian.date(from: DateComponents(year: day.year, month: day.month, day: day.day, hour: 12))!
  }

  func timeZone(at instant: Instant) -> TimeZone {
    TimeZone(secondsFromGMT: moment.zone.offsetSeconds(at: instant)) ?? .gmt
  }
}

// The log's instants meet Foundation's dates here, for formatting and for date pickers, to the millisecond.
extension Instant {
  nonisolated init(_ date: Date) { self.init(ms: Int64((date.timeIntervalSince1970 * 1_000).rounded())) }
  nonisolated var date: Date { Date(timeIntervalSince1970: Double(ms) / 1_000) }
}

extension Binding where Value == Instant {
  var date: Binding<Date> { Binding<Date>(get: { wrappedValue.date }, set: { wrappedValue = Instant($0) }) }
}
