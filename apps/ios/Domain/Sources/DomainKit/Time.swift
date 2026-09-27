// §5 time as the kit's own values: integer epoch milliseconds, Gregorian days, and a zone the app injects.

public struct Instant: Hashable, Comparable, Sendable {
  public let ms: Int64

  public init(ms: Int64) {
    self.ms = ms
  }

  public static func < (a: Instant, b: Instant) -> Bool { a.ms < b.ms }
}

public protocol Zone: Sendable {
  func offsetSeconds(at instant: Instant) -> Int
}

public struct FixedZone: Zone {
  let seconds: Int

  public init(offsetSeconds: Int) {
    seconds = offsetSeconds
  }

  public func offsetSeconds(at instant: Instant) -> Int { seconds }
}

// A proleptic Gregorian `YYYY-MM-DD` date. Every computation is §5.2's, on 64-bit integers with floor division.
public struct LocalDay: Hashable, Comparable, Sendable, CustomStringConvertible {
  public let year: Int, month: Int, day: Int

  // Exactly `DDDD-DD-DD`, a real day of the years 0001–9999.
  public init?(_ text: String) {
    let bytes = Array(text.utf8)
    let digits = [0, 1, 2, 3, 5, 6, 8, 9]
    guard bytes.count == 10, bytes[4] == UInt8(ascii: "-"), bytes[7] == UInt8(ascii: "-"),
          digits.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[$0]) }) else { return nil }
    let number = { (range: Range<Int>) in range.reduce(0) { $0 * 10 + Int(bytes[$1] - UInt8(ascii: "0")) } }
    let (year, month, day) = (number(0..<4), number(5..<7), number(8..<10))
    guard year >= 1, (1...12).contains(month), day >= 1, day <= LocalDay.length(ofMonth: month, in: year) else { return nil }
    self.year = year
    self.month = month
    self.day = day
  }

  public init(_ instant: Instant, offsetSeconds: Int) {
    self.init(daysSinceEpoch: LocalDay.floorDivide(instant.ms + Int64(offsetSeconds) * 1_000, 86_400_000))
  }

  public init(_ instant: Instant, in zone: any Zone) {
    self.init(instant, offsetSeconds: zone.offsetSeconds(at: instant))
  }

  // civil(days), days since 1970-01-01.
  init(daysSinceEpoch days: Int64) {
    let z = days + 719_468
    let era = LocalDay.floorDivide(z, 146_097)
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let day = doy - (153 * mp + 2) / 5 + 1
    let month = mp < 10 ? mp + 3 : mp - 9
    year = Int(yoe + era * 400 + (month <= 2 ? 1 : 0))
    self.month = Int(month)
    self.day = Int(day)
  }

  // The inverse of civil.
  var daysSinceEpoch: Int64 {
    let y = Int64(month <= 2 ? year - 1 : year)
    let era = LocalDay.floorDivide(y, 400)
    let yoe = y - era * 400
    let mp = Int64(month > 2 ? month - 3 : month + 9)
    let doy = (153 * mp + 2) / 5 + Int64(day) - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
  }

  public var text: String {
    "\(LocalDay.padded(year, to: 4))-\(LocalDay.padded(month, to: 2))-\(LocalDay.padded(day, to: 2))"
  }

  public var description: String { text }

  public func adding(days: Int) -> LocalDay {
    LocalDay(daysSinceEpoch: daysSinceEpoch + Int64(days))
  }

  public func days(until other: LocalDay) -> Int {
    Int(other.daysSinceEpoch - daysSinceEpoch)
  }

  // ISO: Monday 1 … Sunday 7.
  public var weekday: Int {
    Int(LocalDay.floorModulo(daysSinceEpoch + 3, 7)) + 1
  }

  public static func < (a: LocalDay, b: LocalDay) -> Bool {
    (a.year, a.month, a.day) < (b.year, b.month, b.day)
  }

  static func length(ofMonth month: Int, in year: Int) -> Int {
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
    return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  }

  static func floorDivide(_ a: Int64, _ b: Int64) -> Int64 {
    let quotient = a / b
    return (a % b != 0 && (a < 0) != (b < 0)) ? quotient - 1 : quotient
  }

  static func floorModulo(_ a: Int64, _ b: Int64) -> Int64 {
    a - floorDivide(a, b) * b
  }

  static func padded(_ number: Int, to width: Int) -> String {
    let digits = String(number)
    return String(repeating: "0", count: Swift.max(0, width - digits.count)) + digits
  }
}
