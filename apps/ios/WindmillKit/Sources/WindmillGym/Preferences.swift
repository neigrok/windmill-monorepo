import Foundation

// HOW THE ROOM IS SET UP (§I). These live on the ACCOUNT rather than on the phone, because a lifter
// reads in one unit everywhere and rests the way their program says; signed out they live on the
// device and the claim carries them (LocalLog, TrainingStore's claim).
//
// NOTHING HERE IS ABOUT EQUIPMENT, and that is a decision rather than a gap: the bar weight and the
// plate set this document used to carry went on 2026-08-13, along with the loading readout they fed.
// Gyms are more or less the same, and this product guides a program and tracks what was done.
//
// KILOGRAMS ARE THE ONLY THING STORED, forever, and `units` cannot change that here: there is no
// conversion constant anywhere in gym's Swift, and that absence is the proof rather than a promise —
// a display transform cannot reach a write when no display transform exists. What `units` records is
// the lifter's answer, kept on the account for the surfaces that can spell it; this room still DRAWS
// kilograms, because its ladder and its keypad are kilogram instruments and a pound numeral over
// buttons that step in kilos would not add up. The settings row says exactly that where
// it is drawn, which is the same per-surface honesty the haptic row owes.
//
// THE DOCUMENT IS WHOLE ON THE WIRE. `PUT /v1/gym/preferences` replaces every field and an omitted one
// takes its DEFAULT rather than keeping what was stored, so a row that changes one value sends the
// ones it did not touch — which is why every screen edits this one value and never a field of it.
public struct GymPreferences: Equatable, Codable, Sendable {
    public let units: Units
    // Absent IS off, and off is the default: a timer nobody asked for that starts beeping in a gym is
    // the kind of thing this product does not do. There is no zero and no `false` for it.
    public let restSeconds: Int?
    public let restSound: Bool
    // The INTENT, which is the account's; what each surface can honour is the surface's. This one has
    // a haptic and uses it.
    public let confirmHaptic: Bool
    public let confirmSound: Bool

    public static let defaults = GymPreferences()

    // The bands are the server's own (`domain/Preferences`), and they are CLAMPED here rather than
    // refused: the only documents this type ever builds come from a screen that offers legal values
    // — and refuses out loud where it cannot — and from shelves this app wrote itself, so a value
    // outside a band is a file from another build, and the room's rule for one of those is that it
    // opens anyway.
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

    // A read defaults rather than throws, field by field — the module's rule (Training.swift). A
    // build that has never heard of a unit reads `kg` instead of refusing to draw the room, and every
    // fallback is the default itself, so the defaults are written once.
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

    // The dial has its own verb rather than an argument on `with`, because `nil` is a REAL value here
    // — it is how the timer is turned OFF — and an optional argument defaulting to nil could not tell
    // "turn it off" from "leave it alone".
    public func resting(_ seconds: Int?) -> GymPreferences {
        GymPreferences(units: units, restSeconds: seconds, restSound: restSound,
                       confirmHaptic: confirmHaptic, confirmSound: confirmSound)
    }
}

// How the lifter reads a number. Storage is kilograms under both of them — see the head of this file
// for why this room still draws kg, and where it says so.
public enum Units: String, Codable, Sendable, CaseIterable {
    case kg, lb
}
