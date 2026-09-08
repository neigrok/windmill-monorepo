import Foundation

// The routine target sheet's typed fields — the head (Sets · Reps · Weight, speaking about every set
// at once) and the ladder (one row per set) — and the six refusals they carry. `Draft` is the sheet's
// whole state; the view draws it and hands every keystroke back.
//
// These are the PLANNING sheet's bands, the ones `backend/products/gym/domain/Routine.cpp` enforces:
// sets 1–20, reps 1–100 per set, a load inside ±500 kg per set. The rack's keypad is a different
// control on a different screen and enforces the LIVE LOGGER's band instead — reps 1–99,
// `KeypadEntry.repsBand` — and the two are named apart here so neither can be read as the other.
//
// An empty field is not a blank: it is the null target, and the placeholder says what it means.
public enum TargetEntry {
    // A named set count keeps its band; naming none is `open`.
    public static let setsBand = 1...20
    // A named rep target keeps its band; naming none is `max`.
    public static let repsBand = 1...100
    // A load may be band-assisted, so the sign is legal and the magnitude is not.
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
    // The head's placeholder when the ladder's rows disagree: typing over it writes every row again.
    public static let varies = "varies"

    // The sign control a bodyweight movement's load fields carry — a chin-up planned at −20 kg is a
    // band-assisted target the rack already logs. It is `±` and never a bare `−`: a standalone minus
    // reads as *decrement* here, which is what it means in the logger's rep stepper, and it cannot
    // say "back to positive" (`15-the-routine.md`). An empty field has no sign to flip.
    public static func flipped(_ typed: String) -> String {
        let raw = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return typed }
        if raw.hasPrefix("-") || raw.hasPrefix("\u{2212}") { return String(raw.dropFirst()) }
        return "-" + raw
    }

    // The six pinned refusals of `docs/design/gym/briefs/15-the-routine.md`, drawn under the field or
    // the ladder row that carries the fault.
    public static let oneDecimalPoint = "One decimal point only."
    public static let notANumber = "That is not a number yet."
    public static let overWeight = "Over 500 kg — check the number."
    public static let outOfRepsBand = "Whole reps, 1 to 100."
    public static let outOfSetsBand = "Sets, 1 to 20."
    public static let zeroTarget = "A zero target is no target — clear the field instead."

    // Also the sheet's focus identity: the field a refusal belongs to and the field a keyboard is in
    // are the same things. Ladder rows are 0-based.
    public enum Field: Hashable {
        case sets, reps, weight
        case rowReps(Int), rowWeight(Int)
        case addSet
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

    // One ladder row as typed. The id is the row's identity across edits, never its ordinal.
    public struct Row: Equatable, Identifiable {
        public let id: String
        public var reps: String
        public var weight: String

        public init(reps: String = "", weight: String = "", id: String = UUID().uuidString) {
            self.id = id
            self.reps = reps
            self.weight = weight
        }

        public init(_ target: SetTarget) {
            self.init(reps: target.reps.map(String.init) ?? "",
                      weight: target.weightKg.map(Readout.weight) ?? "")
        }

        // A fresh row holding the same two texts, for the set added beneath this one.
        var copy: Row { Row(reps: reps, weight: weight) }
    }

    // The head's Sets text and the rows it counts over. Typing never shrinks `rows`: the count is the
    // visible prefix, so typing 5 → 1 → 12 on a ramp keeps rows 2–5 and copies row 5 into 6–12, Add set
    // reveals the next hidden row before it copies the last visible one, and only a swipe-Delete takes
    // a row out of the array. An empty Sets hides the ladder without discarding it; the commit slices
    // to the count, and only a commit of the open line drops the rows.
    public struct Draft: Equatable {
        public private(set) var sets: String
        public private(set) var rows: [Row]
        // Add set was tapped at twenty. Any keystroke clears it.
        public private(set) var addRefused: Bool

        public init(_ scheme: [SetTarget]) {
            sets = scheme.isEmpty ? "" : String(scheme.count)
            rows = scheme.map(Row.init)
            addRefused = false
        }

        // The ladder is hidden and Reps and Weight are disabled.
        public var isOpen: Bool { blank(sets) }

        public var ladder: [Row] { Array(rows.prefix(count)) }

        // The visible count: what Sets reads, every row while it reads nothing, none on the open line.
        private var count: Int {
            guard !isOpen else { return 0 }
            return readSets(sets).value ?? rows.count
        }

        // The common text of the ladder when every row agrees, else "" — under the `varies` placeholder.
        public var headReps: String { agreed(ladder.map(\.reps)) ?? "" }
        public var headWeight: String { agreed(ladder.map(\.weight)) ?? "" }
        public var repsPlaceholder: String { agreed(ladder.map(\.reps)) == nil ? varies : TargetEntry.repsPlaceholder }
        public var weightPlaceholder: String {
            agreed(ladder.map(\.weight)) == nil ? varies : TargetEntry.weightPlaceholder
        }

        // A readable count grows the ladder by copying its last row (an empty row when there is none);
        // an unreadable one leaves the rows alone and shows its refusal; "" opens the line.
        public mutating func typeSets(_ text: String) {
            addRefused = false
            sets = text
            guard let count = readSets(text).value else { return }
            while rows.count < count { rows.append(rows.last?.copy ?? Row()) }
        }

        // The head writes every ladder row.
        public mutating func typeReps(_ text: String) {
            addRefused = false
            for index in ladder.indices { rows[index].reps = text }
        }

        public mutating func typeWeight(_ text: String) {
            addRefused = false
            for index in ladder.indices { rows[index].weight = text }
        }

        public mutating func typeReps(_ text: String, row: Int) {
            addRefused = false
            guard ladder.indices.contains(row) else { return }
            rows[row].reps = text
        }

        public mutating func typeWeight(_ text: String, row: Int) {
            addRefused = false
            guard ladder.indices.contains(row) else { return }
            rows[row].weight = text
        }

        // One more row beneath the ladder: the next hidden row where a shrunken count left one, else the
        // last visible row again. Inert at twenty, where the refusal is drawn under it.
        public mutating func addSet() {
            addRefused = false
            let shown = count
            guard shown < setsBand.upperBound else {
                addRefused = true
                return
            }
            if rows.count <= shown { rows.append(rows.last?.copy ?? Row()) }
            sets = String(shown + 1)
        }

        // Takes the row out of the array and decrements the count; the hidden rows past the count stay.
        // Deleting the last row is the same act as clearing Sets and lands on the same open line.
        public mutating func delete(row index: Int) {
            addRefused = false
            guard ladder.indices.contains(index) else { return }
            let shown = count - 1
            rows.remove(at: index)
            sets = shown == 0 ? "" : String(shown)
        }

        public mutating func rampUp() {
            addRefused = false
            guard let scheme = ladderScheme else { return }
            write(TargetEntry.rampUp(scheme))
        }

        public mutating func matchSetOne() {
            addRefused = false
            guard let scheme = ladderScheme else { return }
            write(TargetEntry.matchSetOne(scheme))
        }

        // Ramp up has something to ramp between: a readable ladder of three or more whose ends differ —
        // on two rows there is nothing between the ends to write.
        public var canRamp: Bool {
            guard let scheme = ladderScheme, scheme.count >= 3,
                  let first = scheme.first, let last = scheme.last else { return false }
            return first != last
        }

        // The sheet's one refusal, fail-fast in the order a lifter meets it: the head's count, then the
        // refused Add set, then the ladder top to bottom, reps before weight. A fault every row shares is
        // the head's own — it was typed there — and is drawn under the head field rather than under row 1.
        public var refusal: Refusal? {
            if let said = readSets(sets).refusal { return Refusal(field: .sets, said: said) }
            if addRefused { return Refusal(field: .addSet, said: outOfSetsBand) }
            let shown = ladder
            for (index, row) in shown.enumerated() {
                if let said = readReps(row.reps).refusal {
                    let field: Field = agreed(shown.map(\.reps)) == nil ? .rowReps(index) : .reps
                    return Refusal(field: field, said: said)
                }
                if let said = readWeight(row.weight).refusal {
                    let field: Field = agreed(shown.map(\.weight)) == nil ? .rowWeight(index) : .weight
                    return Refusal(field: field, said: said)
                }
            }
            return nil
        }

        // nil while refused; [] on the open line.
        public var scheme: [SetTarget]? {
            guard refusal == nil else { return nil }
            guard !isOpen else { return [] }
            return ladderScheme
        }

        // `Set` alone while a refusal stands (the button is disabled with it) · `Set · open` ·
        // `Set · 5 × 5 · 80` when the rows agree · `Set · 5 sets` otherwise.
        public var commitLabel: String {
            guard refusal == nil else { return "Set" }
            if isOpen { return "Set · \(Readout.openTarget)" }
            if let scheme, SetTarget.agree(scheme) { return "Set · \(Readout.target(scheme))" }
            return "Set · \(Readout.setCount(ladder.count))"
        }

        // The ladder's rows as sets, nil while any row is unreadable.
        private var ladderScheme: [SetTarget]? {
            let readings = ladder.map { (reps: readReps($0.reps), weight: readWeight($0.weight)) }
            guard !readings.contains(where: { $0.reps.isRefused || $0.weight.isRefused }) else { return nil }
            return readings.map { SetTarget(reps: $0.reps.value, weightKg: $0.weight.value) }
        }

        // Writes a scheme back over the ladder's rows as text, keeping every row's identity.
        private mutating func write(_ scheme: [SetTarget]) {
            for (index, target) in scheme.enumerated() where rows.indices.contains(index) {
                let typed = Row(target)
                rows[index].reps = typed.reps
                rows[index].weight = typed.weight
            }
        }

        // The one text every row holds, nil when they disagree or there are none.
        private func agreed(_ texts: [String]) -> String? {
            guard let first = texts.first, texts.allSatisfy({ $0 == first }) else { return nil }
            return first
        }
    }

    // Interpolates reps and load from set 1 to set n across the rows between: the ends stay as typed,
    // each load between snaps onto its band's plate grid (`Ladder.snapped`), each rep count to the
    // nearest whole. A column whose either end is absent is left as it is; under three rows there is
    // nothing between the ends.
    public static func rampUp(_ sets: [SetTarget]) -> [SetTarget] {
        guard sets.count >= 3, let first = sets.first, let last = sets.last else { return sets }
        let span = Double(sets.count - 1)
        return sets.enumerated().map { index, set in
            guard index != sets.startIndex, index != sets.endIndex - 1 else { return set }
            let along = Double(index) / span
            var reps = set.reps
            if let from = first.reps, let to = last.reps {
                reps = Int((Double(from) + Double(to - from) * along).rounded())
            }
            var weight = set.weightKg
            if let from = first.weightKg, let to = last.weightKg {
                weight = Ladder.snapped(from + (to - from) * along)
            }
            return SetTarget(reps: reps, weightKg: weight)
        }
    }

    // Set 1's reps and load in every row — the way back from a ladder to a straight scheme.
    public static func matchSetOne(_ sets: [SetTarget]) -> [SetTarget] {
        guard let first = sets.first else { return sets }
        return sets.map { _ in first }
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
