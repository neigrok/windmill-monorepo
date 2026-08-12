import Foundation

// WHAT GOES ON THE BAR — and what to say when this gym's plates cannot make the number. §I's plate
// row is the input; the line under §K's numeral is the only consumer, and no other screen reads this.
//
// THE LADDER DOES NOT READ IT, which is the one contradiction the wave had to rule on. §I said the
// fine step came from the plate inventory; the ladder is a pure function of the weight, pinned across
// three languages by packages/api-contract/gym-ladder.json, and a step that depended on one lifter's
// plates could not be pinned that way — the drift gate that has already caught two real defects would
// stop working. So the buttons do not change, and THIS LINE tells the truth instead: a lifter who
// owns no 1.25s still gets the +2.5, and reads "102.5 won't load with these plates — 100 or 105"
// under it. A button that silently refused to offer a weight would be a product deciding what someone
// is allowed to lift; log the set anyway if they tap, because they might be at a different gym.
//
// EXACT, NEVER GREEDY. Greedy loading is wrong for real inventories: a gym owning only 25s and 20s
// loads 40 per side as 20 + 20, and greedy takes the 25, cannot place the last 15 and reports a weight
// it can plainly load as impossible. A readout whose whole job is to be true may not make that
// mistake, so the reachable loads are SOLVED — one pass over the plate multiples, in units of the
// plates' own greatest common divisor, which for the standard set is 1.25 kg and 34 steps for a 105 kg
// squat.
public enum Plates {
    public struct Plate: Equatable, Sendable {
        public let weightKg: Double
        public let count: Int
    }

    public enum Loading: Equatable, Sendable {
        case bare                                       // the bar, and nothing on it
        case loaded([Plate])                            // per side, heaviest first
        case impossible(under: Double?, over: Double?)  // the nearest totals that CAN be loaded
    }

    // A load past this is not a barbell, and the walk below is bounded by it rather than by a plate
    // count nobody chose. Nil is "there is nothing true to say", which is a state the readout draws
    // as no line at all.
    private static let heaviestBarbell = 2000.0
    private static let longestWalk = 20_000

    public static func loading(totalKg: Double, under preferences: GymPreferences) -> Loading? {
        // A bar of zero is a machine or a pair of dumbbells: the lifter has said there is no bar, so
        // there is nothing to say about what goes on one. Neither is a load at or below nothing —
        // bodyweight sits at zero and band-assisted work below it, and both are points on the number
        // line rather than something you load.
        guard preferences.barWeightKg > 0, totalKg.isFinite,
              totalKg > 0, totalKg <= heaviestBarbell else { return nil }
        let bar = cents(preferences.barWeightKg)
        let total = cents(totalKg)
        guard total != bar else { return .bare }
        guard total > bar else { return .impossible(under: nil, over: preferences.barWeightKg) }

        let plates = preferences.platesKg.map(cents).filter { $0 > 0 }.sorted(by: >)
        guard let heaviest = plates.first else {
            return .impossible(under: preferences.barWeightKg, over: nil)
        }
        // The finest change this gym can make on one side. Everything below counts in it, which is
        // what keeps the walk short for a real plate set and bounded for an absurd one.
        let step = plates.reduce(0, gcd)
        let perSide = (total - bar) / 2
        let target = perSide / step
        let ceiling = target + heaviest / step
        guard ceiling <= longestWalk else { return nil }
        let reach = reachable(coins: plates.map { $0 / step }, upTo: ceiling)

        // Three ways the target misses: an odd remainder cannot be split between two sides, a per-side
        // load off the plate grid cannot be reached at all, and a load on the grid still may not be
        // buildable from these kinds.
        guard (total - bar) % 2 == 0, perSide % step == 0, reach.count[target] != Int.max else {
            return .impossible(under: largest(reach.count, atOrUnder: target)
                                   .map { kilograms(bar + 2 * $0 * step) },
                               over: smallest(reach.count, over: target)
                                   .map { kilograms(bar + 2 * $0 * step) })
        }
        return .loaded(stacked(reach.taken, from: target, step: step))
    }

    // The design's own line (§K): `20 + 25·2 + 15 + 2.5 per side`. It is the whole sentence under the
    // numeral, so the two things it can say — what to load, and that this cannot be loaded — read in
    // the same voice and in the same place.
    public static func readout(totalKg: Double, under preferences: GymPreferences) -> String? {
        guard let loading = loading(totalKg: totalKg, under: preferences) else { return nil }
        switch loading {
        case .bare:
            return "\(Readout.weight(preferences.barWeightKg)) · bar only"
        case .loaded(let plates):
            let side = plates.map {
                $0.count == 1 ? Readout.weight($0.weightKg) : "\(Readout.weight($0.weightKg))·\($0.count)"
            }
            return "\(Readout.weight(preferences.barWeightKg)) + \(side.joined(separator: " + ")) per side"
        case .impossible(let under, let over):
            let near = [under, over].compactMap { $0 }.map(Readout.weight)
            guard !near.isEmpty else { return nil }
            return "\(Readout.weight(totalKg)) won’t load with these plates — \(near.joined(separator: " or "))"
        }
    }

    // Fewest plates to each load on one side, and the plate that got there. Coins arrive heaviest
    // first and the comparison is strict, so a tie is broken by the heavier plate — the way a bar is
    // actually loaded.
    private static func reachable(coins: [Int], upTo ceiling: Int) -> (count: [Int], taken: [Int]) {
        var count = [Int](repeating: Int.max, count: ceiling + 1)
        var taken = [Int](repeating: 0, count: ceiling + 1)
        count[0] = 0
        for load in 1...ceiling {
            for coin in coins where coin <= load {
                guard count[load - coin] != Int.max, count[load - coin] + 1 < count[load] else { continue }
                count[load] = count[load - coin] + 1
                taken[load] = coin
            }
        }
        return (count, taken)
    }

    private static func stacked(_ taken: [Int], from target: Int, step: Int) -> [Plate] {
        var load = target
        var picked: [Int] = []
        while load > 0 {
            picked.append(taken[load])
            load -= taken[load]
        }
        var stack: [Plate] = []
        for coin in picked.sorted(by: >) {
            let weight = kilograms(coin * step)
            guard let last = stack.last, last.weightKg == weight else {
                stack.append(Plate(weightKg: weight, count: 1))
                continue
            }
            stack[stack.count - 1] = Plate(weightKg: weight, count: last.count + 1)
        }
        return stack
    }

    // Nothing on the bar is always reachable, so a load above the bar always has something below it to
    // name. Above is bounded by the heaviest plate and cannot miss: the largest reachable load at or
    // under the target, plus the lightest plate, is reachable and past it.
    private static func largest(_ count: [Int], atOrUnder target: Int) -> Int? {
        stride(from: min(target, count.count - 1), through: 0, by: -1).first { count[$0] != Int.max }
    }

    private static func smallest(_ count: [Int], over target: Int) -> Int? {
        guard target + 1 < count.count else { return nil }
        return (target + 1..<count.count).first { count[$0] != Int.max }
    }

    // Hundredths, because a plate set is decimal and the arithmetic below has to be exact: 2.5 + 1.25
    // in Double does not land where a lifter would put it.
    private static func cents(_ kg: Double) -> Int {
        Int((kg * 100).rounded())
    }

    private static func kilograms(_ cents: Int) -> Double {
        Double(cents) / 100
    }

    private static func gcd(_ left: Int, _ right: Int) -> Int {
        right == 0 ? left : gcd(right, left % right)
    }
}
