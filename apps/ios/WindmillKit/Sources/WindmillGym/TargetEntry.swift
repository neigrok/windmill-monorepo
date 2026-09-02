import Foundation

// The routine target's three typed fields — sets, reps, weight — and the six refusals they carry.
//
// These are the PLANNING sheet's bands, the ones `backend/products/gym/domain/Routine.cpp:20-26`
// enforces: sets 1–20, reps 1–100, a load inside ±500 kg. The rack's keypad is a different control on
// a different screen and enforces the LIVE LOGGER's band instead — reps 1–99, `KeypadEntry.repsBand`
// — and the two are named apart here so neither can be read as the other.
//
// An empty field is not a blank: it is the null target, and the placeholder says what it means.
public enum TargetEntry {
    // Routine.cpp:22 — a named set count keeps its band; naming none is `open`.
    public static let setsBand = 1...20
    // Routine.cpp:24 — a named rep target keeps its band; naming none is `max`.
    public static let repsBand = 1...100
    // Routine.cpp:26 — a load may be band-assisted, so the sign is legal and the magnitude is not.
    public static let maxWeightKg: Double = 500

    // What an open line MEANS. One sentence on every surface (`15-the-routine.md`), the twin of
    // `web/src/products/gym/routines.js` OPEN_LINE and Android's `TargetEntry.openLine`, drawn on
    // the target sheet alone while the line on it is open — a list's target column already reads
    // `open` per row, and the sheet says what that means the moment a line is touched.
    public static let openLine = "You decide the numbers at the rack."

    // What an emptied field means, drawn as the placeholder inside it.
    public static let setsPlaceholder = "open"
    public static let repsPlaceholder = "max"
    public static let weightPlaceholder = "last time"

    // `.decimalPad` has no sign key, and a load may be band-assisted — a chin-up planned at −20 kg is
    // a target `Routine.cpp:26` accepts and the rack already logs. So the weight field carries the
    // sign control the rest of the product carries, and it is `±` and never a bare `−`: a standalone
    // minus reads as *decrement* here, which is what it means in the logger's rep stepper, and it
    // cannot say "back to positive" (`15-the-routine.md`). An empty field has no sign to flip.
    public static func flipped(_ typed: String) -> String {
        let raw = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return typed }
        if raw.hasPrefix("-") || raw.hasPrefix("\u{2212}") { return String(raw.dropFirst()) }
        return "-" + raw
    }

    // The six pinned refusals of `docs/design/gym/briefs/15-the-routine.md`. They were the custom
    // keypad's; iOS never had a typed target field, so on this surface they are new work.
    public static let oneDecimalPoint = "One decimal point only."
    public static let notANumber = "That is not a number yet."
    public static let overWeight = "Over 500 kg — check the number."
    public static let outOfRepsBand = "Whole reps, 1 to 100."
    public static let outOfSetsBand = "Sets, 1 to 20."
    public static let zeroTarget = "A zero target is no target — clear the field instead."

    // The seventh, and the one that is a refusal of an ACT rather than of a value: clearing sets is
    // what opens a line, and `Routine.cpp:18` refuses a line that names reps or a load without sets.
    // The clear is refused and the field keeps what it held (ledger `2l`).
    public static let clearOthersFirst = "Clear reps and weight first — an open line names neither."

    // The eighth, and the same illegal shape reached from the other side: a number typed onto a line
    // whose sets are already empty. That keystroke LANDS — refusing it would drop what was just asked
    // for — so the commit is refused instead, and the remedy is the opposite one, which is why it
    // cannot be said in the sentence above.
    public static let nameSetsFirst = "Name the sets first — an open line names neither."

    // Also the sheet's focus identity: the field a refusal belongs to and the field a keyboard is in
    // are the same three things.
    public enum Field: Hashable {
        case sets, reps, weight
    }

    // One refusal for the whole sheet, and the field it belongs to, so the sheet draws it once and
    // under that field rather than one per field.
    public struct Refusal: Equatable {
        public let field: Field
        public let said: String

        public init(field: Field, said: String) {
            self.field = field
            self.said = said
        }
    }

    // The sheet's one refusal, fail-fast in the order a lifter meets it: the refused KEYSTROKE first
    // (they are owed a word about what they just did), then the line's SHAPE — a line naming no sets
    // may name no reps and no load, whatever those two hold — then the three fields topmost first, so
    // nobody is told about the third while the first is still nonsense.
    public static func refusal(sets: String, reps: String, weight: String,
                               clearRefused: Bool = false) -> Refusal? {
        if clearRefused { return Refusal(field: .sets, said: clearOthersFirst) }
        if blank(sets), !blank(reps) || !blank(weight) {
            return Refusal(field: .sets, said: nameSetsFirst)
        }
        if let said = readSets(sets).refusal { return Refusal(field: .sets, said: said) }
        if let said = readReps(reps).refusal { return Refusal(field: .reps, said: said) }
        if let said = readWeight(weight).refusal { return Refusal(field: .weight, said: said) }
        return nil
    }

    public static func blank(_ typed: String) -> Bool {
        typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // `value` is nil for an empty field — the null target — and nil for a refused one; `refusal` is
    // what tells the two apart.
    public struct Reading<Value: Equatable>: Equatable {
        public let value: Value?
        public let refusal: String?

        public var isRefused: Bool { refusal != nil }
    }

    public static func readSets(_ typed: String) -> Reading<Int> {
        whole(typed, band: setsBand, outOfBand: outOfSetsBand)
    }

    public static func readReps(_ typed: String) -> Reading<Int> {
        whole(typed, band: repsBand, outOfBand: outOfRepsBand)
    }

    // Rounded onto the ladder's own grid, the way a typed load is at the rack.
    public static func readWeight(_ typed: String) -> Reading<Double> {
        let read = number(typed)
        guard read.refusal == nil else { return Reading(value: nil, refusal: read.refusal) }
        guard let value = read.value else { return Reading(value: nil, refusal: nil) }
        guard value != 0 else { return Reading(value: nil, refusal: zeroTarget) }
        guard abs(value) <= maxWeightKg else { return Reading(value: nil, refusal: overWeight) }
        return Reading(value: Ladder.round(value), refusal: nil)
    }

    // Whether the sets field may be emptied: an open line names no reps and no weight either, so the
    // other two are cleared first and the clear is refused until they are.
    public static func clearingSets(reps: String, weight: String) -> String? {
        guard blank(reps), blank(weight) else { return clearOthersFirst }
        return nil
    }

    private static func whole(_ typed: String, band: ClosedRange<Int>,
                              outOfBand: String) -> Reading<Int> {
        let read = number(typed)
        guard read.refusal == nil else { return Reading(value: nil, refusal: read.refusal) }
        guard let value = read.value else { return Reading(value: nil, refusal: nil) }
        guard value != 0 else { return Reading(value: nil, refusal: zeroTarget) }
        guard value == value.rounded(), let counted = Int(exactly: value.rounded()),
              band.contains(counted) else {
            return Reading(value: nil, refusal: outOfBand)
        }
        return Reading(value: counted, refusal: nil)
    }

    // `value` nil with no refusal is an empty field. Refusals come in the order a typist meets them.
    private static func number(_ typed: String) -> Reading<Double> {
        let raw = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return Reading(value: nil, refusal: nil) }
        let normalised = raw.replacingOccurrences(of: ",", with: ".")
        guard normalised.filter({ $0 == "." }).count <= 1 else {
            return Reading(value: nil, refusal: oneDecimalPoint)
        }
        let unsigned = normalised.hasPrefix("-") || normalised.hasPrefix("\u{2212}")
            ? String(normalised.dropFirst())
            : normalised
        guard !unsigned.isEmpty, unsigned.allSatisfy({ $0.isNumber || $0 == "." }),
              let value = Double(normalised.replacingOccurrences(of: "\u{2212}", with: "-")),
              value.isFinite else {
            return Reading(value: nil, refusal: notANumber)
        }
        return Reading(value: value, refusal: nil)
    }
}
