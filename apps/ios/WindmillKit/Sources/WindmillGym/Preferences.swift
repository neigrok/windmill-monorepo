import Foundation

// HOW THE ROOM IS SET UP — five answers, and they are all about a barbell (§I). They live on the
// ACCOUNT rather than on the phone, because a lifter reads in one unit everywhere and their gym's
// plates are their gym's, not this device's; signed out they live on the device and the claim carries
// them (LocalLog, TrainingStore's claim).
//
// KILOGRAMS ARE THE ONLY THING STORED, forever, and `units` cannot change that here: there is no
// conversion constant anywhere in gym's Swift, and that absence is the proof rather than a promise —
// a display transform cannot reach a write when no display transform exists. What `units` records is
// the lifter's answer, kept on the account for the surfaces that can spell it; this room still DRAWS
// kilograms, because its ladder, its keypad and its plate math are kilogram instruments and a pound
// numeral over buttons that step in kilos would not add up. The settings row says exactly that where
// it is drawn, which is the same per-surface honesty the haptic row owes.
//
// THE DOCUMENT IS WHOLE ON THE WIRE. `PUT /v1/gym/preferences` replaces every field and an omitted one
// takes its DEFAULT rather than keeping what was stored, so a row that changes one value sends the
// four it did not touch — which is why every screen edits this one value and never a field of it.
public struct GymPreferences: Equatable, Codable, Sendable {
    public let units: Units
    public let barWeightKg: Double
    // ONE SIDE of the bar, heaviest first. Empty is a real answer — this gym owns no plates — and is
    // not the same as never having been asked, which is the full set below.
    public let platesKg: [Double]
    // Absent IS off, and off is the default: a timer nobody asked for that starts beeping in a gym is
    // the kind of thing this product does not do. There is no zero and no `false` for it.
    public let restSeconds: Int?
    public let restSound: Bool
    // The INTENT, which is the account's; what each surface can honour is the surface's. This one has
    // a haptic and uses it.
    public let confirmHaptic: Bool
    public let confirmSound: Bool

    public static let everyPlate: [Double] = [25, 20, 15, 10, 5, 2.5, 1.25]

    // The log's own ceiling on the one field here that is a list (`domain/Preferences`,
    // kMaxPlateKinds — the refusal is `too-many-plates`). It counts KINDS, so a gym owning three 2.5s
    // spends one of the twelve. It is read by the SETTINGS SCREEN, which refuses the thirteenth chip
    // out loud, and the clamp below is only what catches a document that never came from a chip.
    public static let maxPlateKinds = 12

    public static let defaults = GymPreferences()

    // The bands are the server's own (`domain/Preferences`), and they are CLAMPED here rather than
    // refused: the only documents this type ever builds come from a screen that offers legal values
    // — and refuses out loud where it cannot — and from shelves this app wrote itself, so a value
    // outside a band is a file from another build, and the room's rule for one of those is that it
    // opens anyway.
    public init(units: Units = .kg,
                barWeightKg: Double = 20,
                platesKg: [Double] = GymPreferences.everyPlate,
                restSeconds: Int? = nil,
                restSound: Bool = true,
                confirmHaptic: Bool = true,
                confirmSound: Bool = false) {
        self.units = units
        self.barWeightKg = barWeightKg.isFinite ? min(max(barWeightKg, 0), 100) : 20
        // Deduped on the product's own grid and sorted heaviest-first, exactly as the store answers —
        // so the chips read the same before a reply as after one, and a gym owning two 2.5s owns 2.5s.
        let owned = platesKg.filter { $0.isFinite && $0 >= 0.01 && $0 <= 100 }.map(Ladder.round)
        self.platesKg = Array(Set(owned).sorted(by: >).prefix(GymPreferences.maxPlateKinds))
        self.restSeconds = restSeconds.map { min(max($0, 15), 900) }
        self.restSound = restSound
        self.confirmHaptic = confirmHaptic
        self.confirmSound = confirmSound
    }

    enum CodingKeys: String, CodingKey {
        case units, barWeightKg, platesKg, restSeconds, restSound, confirmHaptic, confirmSound
    }

    // A read defaults rather than throws, field by field — the module's rule (Training.swift). A
    // build that has never heard of a unit reads `kg` instead of refusing to draw the room, and every
    // fallback is the default itself, so the defaults are written once.
    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = GymPreferences.defaults
        self.init(units: (try? fields.decode(Units.self, forKey: .units)) ?? fallback.units,
                  barWeightKg: (try? fields.decode(Double.self, forKey: .barWeightKg))
                      ?? fallback.barWeightKg,
                  platesKg: (try? fields.decode([Double].self, forKey: .platesKg)) ?? fallback.platesKg,
                  restSeconds: try? fields.decode(Int.self, forKey: .restSeconds),
                  restSound: (try? fields.decode(Bool.self, forKey: .restSound)) ?? fallback.restSound,
                  confirmHaptic: (try? fields.decode(Bool.self, forKey: .confirmHaptic))
                      ?? fallback.confirmHaptic,
                  confirmSound: (try? fields.decode(Bool.self, forKey: .confirmSound))
                      ?? fallback.confirmSound)
    }

    public func owning(_ plateKg: Double) -> Bool {
        platesKg.contains(Ladder.round(plateKg))
    }

    // Whether one more KIND fits — the log's ceiling, asked before a chip is turned on so the screen
    // can refuse out loud instead of letting the constructor drop the lightest plate this gym owns
    // off the end of the list. A plate already owned always fits: turning it off can only bring the
    // count down.
    public func hasRoomFor(_ plateKg: Double) -> Bool {
        owning(plateKg) || platesKg.count < GymPreferences.maxPlateKinds
    }

    // A chip tapped on or off. The whole document travels, because the whole document is what a write
    // replaces — a settings screen that sent one field would reset the other four to their defaults.
    public func toggling(_ plateKg: Double) -> GymPreferences {
        let plate = Ladder.round(plateKg)
        return with(platesKg: owning(plate) ? platesKg.filter { $0 != plate } : platesKg + [plate])
    }

    public func with(units: Units? = nil, barWeightKg: Double? = nil, platesKg: [Double]? = nil,
                     restSound: Bool? = nil, confirmHaptic: Bool? = nil,
                     confirmSound: Bool? = nil) -> GymPreferences {
        GymPreferences(units: units ?? self.units,
                       barWeightKg: barWeightKg ?? self.barWeightKg,
                       platesKg: platesKg ?? self.platesKg,
                       restSeconds: restSeconds,
                       restSound: restSound ?? self.restSound,
                       confirmHaptic: confirmHaptic ?? self.confirmHaptic,
                       confirmSound: confirmSound ?? self.confirmSound)
    }

    // The dial has its own verb rather than an argument on `with`, because `nil` is a REAL value here
    // — it is how the timer is turned OFF — and an optional argument defaulting to nil could not tell
    // "turn it off" from "leave it alone".
    public func resting(_ seconds: Int?) -> GymPreferences {
        GymPreferences(units: units, barWeightKg: barWeightKg, platesKg: platesKg,
                       restSeconds: seconds, restSound: restSound,
                       confirmHaptic: confirmHaptic, confirmSound: confirmSound)
    }
}

// How the lifter reads a number. Storage is kilograms under both of them — see the head of this file
// for why this room still draws kg, and where it says so.
public enum Units: String, Codable, Sendable, CaseIterable {
    case kg, lb
}
