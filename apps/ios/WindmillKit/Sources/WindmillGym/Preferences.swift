import Foundation

// PUT /v1/gym/preferences replaces the whole document and an omitted field takes its default, so every write sends every field.
public struct GymPreferences: Equatable, Codable, Sendable {
    public let units: Units
    // nil is off.
    public let restSeconds: Int?
    public let restSound: Bool
    public let confirmHaptic: Bool
    public let confirmSound: Bool

    public static let defaults = GymPreferences()

    public init(units: Units = .kg,
                restSeconds: Int? = nil,
                restSound: Bool = true,
                confirmHaptic: Bool = true,
                confirmSound: Bool = false) {
        self.units = units
        self.restSeconds = restSeconds.map { min(max($0, 15), 900) }
        self.restSound = restSound
        self.confirmHaptic = confirmHaptic
        self.confirmSound = confirmSound
    }

    enum CodingKeys: String, CodingKey {
        case units, restSeconds, restSound, confirmHaptic, confirmSound
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = GymPreferences.defaults
        self.init(units: (try? fields.decode(Units.self, forKey: .units)) ?? fallback.units,
                  restSeconds: try? fields.decode(Int.self, forKey: .restSeconds),
                  restSound: (try? fields.decode(Bool.self, forKey: .restSound)) ?? fallback.restSound,
                  confirmHaptic: (try? fields.decode(Bool.self, forKey: .confirmHaptic))
                      ?? fallback.confirmHaptic,
                  confirmSound: (try? fields.decode(Bool.self, forKey: .confirmSound))
                      ?? fallback.confirmSound)
    }

    public func with(units: Units? = nil, restSound: Bool? = nil, confirmHaptic: Bool? = nil,
                     confirmSound: Bool? = nil) -> GymPreferences {
        GymPreferences(units: units ?? self.units,
                       restSeconds: restSeconds,
                       restSound: restSound ?? self.restSound,
                       confirmHaptic: confirmHaptic ?? self.confirmHaptic,
                       confirmSound: confirmSound ?? self.confirmSound)
    }

    public func resting(_ seconds: Int?) -> GymPreferences {
        GymPreferences(units: units, restSeconds: seconds, restSound: restSound,
                       confirmHaptic: confirmHaptic, confirmSound: confirmSound)
    }
}

// Display only. Storage is kilograms under both.
public enum Units: String, Codable, Sendable, CaseIterable {
    case kg, lb
}
