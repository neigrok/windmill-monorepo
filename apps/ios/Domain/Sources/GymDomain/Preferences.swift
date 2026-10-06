import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public struct GymPreferences: Draftable, Equatable {
  public static let type = Gym.Types.prefs
  public static let scope = Gym.scope
  public static let savesGuarded = false

  public let id: ID<GymPreferences>
  public var units: String
  public var confirmHaptic: Bool
  public var confirmSound: Bool

  public init(id: ID<GymPreferences> = ID("prefs"), units: String = Gym.Defaults.Prefs.units,
              confirmHaptic: Bool = Gym.Defaults.Prefs.confirmHaptic, confirmSound: Bool = Gym.Defaults.Prefs.confirmSound) {
    self.id = id
    self.units = units
    self.confirmHaptic = confirmHaptic
    self.confirmSound = confirmSound
  }

  public init(_ fields: Fields) throws(DecodeError) {
    self.init(id: ID(fields.id), units: try fields.string("units", default: Gym.Defaults.Prefs.units),
              confirmHaptic: try fields.bool("confirmHaptic", default: Gym.Defaults.Prefs.confirmHaptic),
              confirmSound: try fields.bool("confirmSound", default: Gym.Defaults.Prefs.confirmSound))
  }

  public var fields: [String: JSON] {
    ["units": .string(units), "confirmHaptic": .bool(confirmHaptic), "confirmSound": .bool(confirmSound)]
  }

  public static let checks: [Check<GymPreferences>] = [
    Check("units") { value, _ in value.units = try PreferencesRules.units.apply(value.units, at: "units") },
  ]
}

public typealias Preferences = GymPreferences
public typealias SavePreferences = SaveDraft<GymPreferences, GymRefusal>

public struct RestSettings: Equatable, Sendable {
  public let seconds: Int?
  public let sound: Bool

  public init(seconds: Int? = Gym.Defaults.Prefs.restSeconds, sound: Bool = Gym.Defaults.Prefs.restSound) {
    self.seconds = seconds
    self.sound = sound
  }

  public init(_ fields: Fields) throws(DecodeError) {
    self.init(seconds: try fields.optionalInt("restSeconds"), sound: try fields.bool("restSound", default: Gym.Defaults.Prefs.restSound))
  }
}

public func restSettings(_ read: Reader) throws -> RestSettings {
  guard let record = try read.repository(GymPreferences.self).record(ID("prefs"), in: .drawn) else { return RestSettings() }
  return try RestSettings(Fields(record))
}

public enum PreferencesRules {
  public static let units = ChoiceSpec("prefs.units", values: ["kg", "lb"])
  static let rules: [Rule] = [.local(units)]
}
