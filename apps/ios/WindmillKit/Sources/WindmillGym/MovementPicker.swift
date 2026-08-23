import SwiftUI
import WindmillPlatform

// The native twin of web/src/products/gym/logger/movements.js.

public enum PickerOptions {
    public static let shown = 7

    // A client constant, never a server concept. Ids, because a name is what one account calls a movement.
    public static let six = ["back-squat", "bench-press", "deadlift",
                             "overhead-press", "barbell-row", "chin-up"]

    // `was` is set only when the match came from an alias, on the row the typing actually found.
    public struct Row: Equatable, Identifiable {
        public let id: String
        public let name: String
        public let yours: Bool
        public let meta: String?
        public var was: String? = nil
    }

    public struct Result: Equatable {
        // Empty the moment a query is typed: filtering is over the whole catalog.
        public let six: [Row]
        public let matches: [Row]
        public let empty: String?
        public let create: String?
    }

    public static func matching(query: String, catalog: [Exercise], taken: [String],
                                lastSets: [String: LastSet]? = nil,
                                now: Int64 = 0) -> Result {
        let term = query.trimmingCharacters(in: .whitespaces)
        let available = catalog.filter { !taken.contains($0.id) }
        let featured = term.isEmpty
            ? six.compactMap { id in available.first { $0.id == id } }
            : []
        // The match is over the name and every alias this account gave it.
        let wanted = term.lowercased()
        let matches = available
            .filter { term.isEmpty || $0.name.lowercased().contains(wanted) || $0.answersTo(wanted) }
            .filter { movement in !featured.contains { $0.id == movement.id } }
            .prefix(shown)
        guard matches.isEmpty, featured.isEmpty else {
            return Result(six: featured.map { row($0, lastSets: lastSets, now: now) },
                          matches: matches.map { movement in
                              var found = row(movement, lastSets: lastSets, now: now)
                              if !movement.name.lowercased().contains(wanted), !wanted.isEmpty {
                                  found.was = movement.aliases.first { $0.lowercased().contains(wanted) }
                              }
                              return found
                          },
                          empty: nil, create: nil)
        }
        if catalog.isEmpty {
            return Result(six: [], matches: [],
                          empty: "The catalog didn’t load. It comes back when you have signal.",
                          create: nil)
        }
        if available.isEmpty {
            return Result(six: [], matches: [],
                          empty: "Every movement in the catalog is already in this session.",
                          create: nil)
        }
        return Result(six: [], matches: [], empty: "No movement by that name.",
                      create: "Create “\(term)”")
    }

    private static func row(_ movement: Exercise, lastSets: [String: LastSet]?, now: Int64) -> Row {
        Row(id: movement.id, name: movement.name, yours: movement.custom,
            meta: line(for: movement.id, lastSets: lastSets, now: now))
    }

    // The read is sparse: an absent key means `never logged` only once the read itself has landed, nil until then.
    private static func line(for exerciseId: String, lastSets: [String: LastSet]?,
                             now: Int64) -> String? {
        guard let lastSets else { return nil }
        guard let last = lastSets[exerciseId] else { return "never logged" }
        return "last \(Readout.effort(weightKg: last.weightKg, reps: last.reps))"
            + " · \(Readout.ago(last.atMs, now: now))"
    }
}

struct MovementList: View {
    let options: PickerOptions.Result
    let catalog: [Exercise]
    @Binding var query: String
    let onPick: (String) -> Void
    let onCreate: (String) -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            TextField("", text: $query,
                      prompt: Text("Search \(catalog.count) movements").foregroundStyle(skin.inkFaint))
                .font(WindmillFont.body(17))
                .foregroundStyle(skin.ink)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.words)
                .padding(.horizontal, WindmillSpace.x4)
                .frame(height: GymTap.minimum + 4)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.raised))

            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    if !options.six.isEmpty {
                        Text("The six")
                            .font(GymType.numeral(10.5))
                            .textCase(.uppercase)
                            .kerning(0.7)
                            .foregroundStyle(skin.inkFaint)
                            .padding(.top, WindmillSpace.x1)
                        ForEach(options.six) { movement in row(movement) }
                        Spacer(minLength: WindmillSpace.x3)
                    }
                    ForEach(options.matches) { movement in row(movement) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let empty = options.empty {
                Text(empty)
                    .font(WindmillFont.body(14))
                    .foregroundStyle(skin.inkDim)
                    .lineSpacing(3)
            }

            if let create = options.create {
                Button { onCreate(query.trimmingCharacters(in: .whitespaces)) } label: {
                    Text(create)
                        .font(WindmillFont.body(16, .semibold))
                        .foregroundStyle(skin.onAccent)
                        .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.accent))
                }
            }
        }
    }

    private func row(_ movement: PickerOptions.Row) -> some View {
        Button { onPick(movement.id) } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x2) {
                    Text(movement.name)
                        .font(WindmillFont.body(17))
                        .foregroundStyle(skin.ink)
                    if movement.yours {
                        Text("yours")
                            .font(GymType.numeral(10.5, .bold))
                            .textCase(.uppercase)
                            .kerning(0.6)
                            .foregroundStyle(skin.accent)
                    }
                    Spacer(minLength: 0)
                }
                if let was = movement.was {
                    Text("was “\(was)”")
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.accent)
                }
                if let meta = movement.meta {
                    Text(meta)
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.inkFaint)
                }
            }
            .padding(.horizontal, WindmillSpace.x3)
            .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(skin.line, lineWidth: 1))
        }
    }
}

struct MovementPicker: View {
    let catalog: [Exercise]
    let taken: [String]
    let lastSets: [String: LastSet]?
    let onPick: (String) -> Void
    let onCreate: (String) -> Void
    let onClose: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            HStack {
                Text("Add movement")
                    .font(WindmillFont.display(20))
                    .foregroundStyle(skin.ink)
                Spacer()
                Button("Cancel", action: onClose)
                    .font(WindmillFont.body(16))
                    .foregroundStyle(skin.inkDim)
                    .frame(minHeight: GymTap.minimum)
            }

            MovementList(options: PickerOptions.matching(query: query, catalog: catalog, taken: taken,
                                                         lastSets: lastSets, now: nowMs),
                         catalog: catalog, query: $query, onPick: onPick, onCreate: onCreate)
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(skin.canvas)
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

struct OpeningPicker: View {
    let catalog: [Exercise]
    let taken: [String]
    let lastSets: [String: LastSet]?
    let isSignedIn: Bool
    let onPick: (String) -> Void
    let onCreate: (String) -> Void
    let onBuildRoutine: (() -> Void)?

    @Environment(\.gymSkin) private var skin
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            VStack(alignment: .leading, spacing: WindmillSpace.x1) {
                Text("What are you starting with?")
                    .font(WindmillFont.display(26))
                    .foregroundStyle(skin.ink)
                Text("the session is already running")
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkFaint)
            }

            MovementList(options: PickerOptions.matching(query: query, catalog: catalog, taken: taken,
                                                         lastSets: lastSets, now: nowMs),
                         catalog: catalog, query: $query, onPick: onPick, onCreate: onCreate)

            agent
        }
    }

    // The room hands `onBuildRoutine` over only while nothing already reaches this log; nil withdraws the card.
    @ViewBuilder
    private var agent: some View {
        if let onBuildRoutine {
            Button(action: onBuildRoutine) {
                VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                    Text(isSignedIn
                         ? "Following a written program? Your agent can build the routine from it — connect it to this log."
                         : "Following a written program? Your agent can build the routine from it — that one needs an account.")
                        .font(WindmillFont.body(14))
                        .foregroundStyle(skin.inkDim)
                        .lineSpacing(3)
                        .multilineTextAlignment(.leading)
                    Text("Build my routine →")
                        .font(WindmillFont.body(14, .bold))
                        .foregroundStyle(skin.accent)
                }
                .padding(WindmillSpace.x4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
                .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                    .foregroundStyle(skin.accent))
            }
        }
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
