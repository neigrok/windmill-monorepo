import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// A weigh-in: the lifter's one number for one local day, keyed by that day. It is one fact, saved whole, so the newest
// save of the day wins whole: its weight, its moment and its presence.
public struct WeighIn: Draftable, Removable, Timestamped, Equatable {
  public static let type = Gym.Types.weighin
  public static let scope = Gym.scope
  public static let savesGuarded = false
  public static let heldRemoval = true
  public static let timestampField = "recordedAt"

  public let id: ID<WeighIn>
  // Nil or NaN while the field holds no number.
  public var kg: Double?
  // The moment of the save that wrote it, which the save itself stamps.
  public private(set) var recordedAt: Instant?

  public init(day: LocalDay, kg: Double? = nil, recordedAt: Instant? = nil) {
    id = ID(day)
    self.kg = kg
    self.recordedAt = recordedAt
  }

  public init(_ r: Fields) throws(DecodeError) {
    id = ID(r.id)
    kg = try r.optionalDouble("kg")
    recordedAt = try r.optionalInstant("recordedAt")
  }

  // Nil for an id the registry's pattern admits that no calendar holds; no read draws it.
  public var day: LocalDay? { id.day }

  public var fields: [String: JSON] {
    ["kg": .of(kg), "recordedAt": .of(recordedAt)]
  }

  public static let checks: [Check<WeighIn>] = [
    .key { w, moment in
      guard let day = w.day else { throw Violation(rule: WeighInRules.dayRule, path: "id", reason: .custom("notADay")) }
      guard day <= WeighInRules.latestDay(at: moment) else {
        throw Violation(rule: WeighInRules.dayRule, path: "id", reason: .custom("future"))
      }
    },
    Check("kg") { w, _ in
      guard let kg = w.kg else { throw Violation(rule: WeighInRules.kg.path, path: "kg", reason: .notANumber) }
      w.kg = try WeighInRules.kg.apply(kg, at: "kg") as Double
    },
  ]
}

public enum WeighInRules {
  public static let kg = NumberSpec("weighin.kg", min: 20, max: 400, quantum: 0.01)
  // A real day, the device's local today or earlier; the server backstops it past its own UTC tomorrow.
  public static let dayRule = "weighin.day"

  // The last day the picker offers and the key rule admits.
  public static func latestDay(at moment: Moment) -> LocalDay {
    moment.today
  }

  static let rules: [Rule] = [
    .local(kg),
    .local(dayRule, subject: WeighIn.type, backstop: [Gym.Codes.badInstant]),
  ]
}

public typealias SaveWeighIn = SaveDraft<WeighIn, GymRefusal>
public typealias DeleteWeighIn = Remove<WeighIn, GymRefusal>

// The room's one read: the stance reads the store, a held delete included; all else reads what is drawn up to today.
public struct Bodyweight: Equatable, Sendable {
  public static let gapDays = 7
  // The recent window's days, today the last of them.
  public static let recentDays = 90

  public enum Stance: Equatable, Sendable {
    // The first pull has not landed and nothing is stored: no claim either way.
    case unknown
    case empty
    case holding

    init(storing weighIns: [WeighIn], firstPullComplete: Bool) {
      guard weighIns.isEmpty else {
        self = .holding
        return
      }
      self = firstPullComplete ? .empty : .unknown
    }
  }

  public struct Entry: Equatable, Sendable {
    public let day: LocalDay
    public let kg: Double

    public init(day: LocalDay, kg: Double) {
      self.day = day
      self.kg = kg
    }
  }

  // Its age in calendar days: 0 today, 1 yesterday.
  public struct Reading: Equatable, Sendable {
    public let entry: Entry
    public let daysAgo: Int

    public init(entry: Entry, daysAgo: Int) {
      self.entry = entry
      self.daysAgo = daysAgo
    }
  }

  public enum Window: Equatable, Sendable {
    case recent
    case all
  }

  // A stretch longer than `gapDays` between two dots, named by them.
  public struct Gap: Equatable, Sendable {
    public let after: LocalDay
    public let before: LocalDay

    public init(after: LocalDay, before: LocalDay) {
      self.after = after
      self.before = before
    }
  }

  public struct Chart: Equatable, Sendable {
    public let window: Window
    public let dots: [Entry]
    public let gaps: [Gap]

    public init(window: Window, dots: [Entry], gaps: [Gap]) {
      self.window = window
      self.dots = dots
      self.gaps = gaps
    }
  }

  public let stance: Stance
  // Day ascending.
  public let entries: [Entry]
  public let today: LocalDay

  public init(stored: [WeighIn], drawn: [WeighIn], firstPullComplete: Bool, at moment: Moment) {
    stance = Stance(storing: stored, firstPullComplete: firstPullComplete)
    today = moment.today
    entries = drawn
      .compactMap { w in w.day.flatMap { day in w.kg.map { Entry(day: day, kg: $0) } } }
      .filter { $0.day <= moment.today }
      .sorted { $0.day < $1.day }
  }

  public init(_ read: Reader) throws {
    let weighIns = read.repository(WeighIn.self)
    self.init(stored: try weighIns.all(in: .stored), drawn: try weighIns.all(in: .drawn),
              firstPullComplete: try read.firstPullComplete(), at: read.moment)
  }

  // The log head: the newest weigh-in and its age; nil draws nothing.
  public var reading: Reading? {
    entries.last.map { Reading(entry: $0, daysAgo: $0.day.days(until: today)) }
  }

  // What the picker reopens: the picked day's weigh-in, nil for a day with none.
  public func entry(on day: LocalDay) -> Entry? {
    entries.first { $0.day == day }
  }

  // Coach's `list_bodyweight`: each bound inclusive, either open.
  public func entries(from: LocalDay?, to: LocalDay?) -> [Entry] {
    entries.filter { entry in (from.map { entry.day >= $0 } ?? true) && (to.map { entry.day <= $0 } ?? true) }
  }

  public func chart(_ window: Window) -> Chart {
    let dots = window == .recent ? entries(from: today.adding(days: 1 - Bodyweight.recentDays), to: nil) : entries
    let gaps = zip(dots, dots.dropFirst())
      .filter { $0.day.days(until: $1.day) > Bodyweight.gapDays }
      .map { Gap(after: $0.day, before: $1.day) }
    return Chart(window: window, dots: dots, gaps: gaps)
  }
}
