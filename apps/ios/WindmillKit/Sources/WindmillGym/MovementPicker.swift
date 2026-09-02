import SwiftUI
import WindmillPlatform

// The native twin of web/src/products/gym/logger/movements.js.

public enum PickerOptions {
    // The cap belongs to a TYPED query and to nothing else: an empty query shows the six and then the
    // whole catalogue, because a picker that shows only six has removed the ability to find the
    // seventh (`15-the-routine.md`, ledger `2j`).
    public static let shown = 7
    public static let featured = 6

    // The six are counted over a FIXED depth of the log and never over more, so a phone that has
    // paged further back does not rank differently from one that has not.
    public static let trainedWindow = 50

    // The cut a picker makes ONCE and then holds for as long as it is up (C18). The log behind an open
    // picker keeps moving — a claim replays a device's sessions, the mirror's poll lands a finished one
    // — and the six may not reshuffle under a thumb already reaching for one of them.
    //
    // The cut is made on the first NON-EMPTY read and not on the first render (C20): `held` is what
    // the picker has already frozen, and an empty one has frozen nothing yet. A picker opened in the
    // moment before the log answers would otherwise keep the generic openers for its whole life —
    // which is the one screen a lifter with a hundred sessions must never be shown.
    public static func window(of log: [SessionSummary],
                              held: [SessionSummary] = []) -> [SessionSummary] {
        guard held.isEmpty else { return held }
        return Array(log.prefix(trainedWindow))
    }

    // What a log-less account opens on, and what a short ranking is topped up from, in this order.
    // A client constant, never a server concept. Ids, because a name is what one account calls a movement.
    public static let openers = ["back-squat", "bench-press", "deadlift",
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

    // Most-used, off the log THIS DEVICE holds: a session summary names every movement in it, so the
    // count is sessions that named it rather than working sets — the wire ranks nothing by use and
    // this invents no read. A session the LOG served names its movements by name and one this device
    // wrote names them by id (`LocalLog.summaries()`), so a movement is counted by either spelling of
    // itself. What the log cannot fill is filled from the openers, in their own order, so a fresh
    // account still sees six. The twin of Android's `PickerOptions.mostTrained`.
    public static func mostTrained(available: [Exercise], sessions: [SessionSummary]) -> [Exercise] {
        var counted: [String: Int] = [:]
        for session in sessions.prefix(trainedWindow) {
            for named in Set(session.exercises) { counted[named, default: 0] += 1 }
        }
        let timesTrained = { (movement: Exercise) in
            (counted[movement.id] ?? 0) + (counted[movement.name] ?? 0)
        }
        // Sorted on the count and then on the place in the catalog, because `sorted` is not stable
        // here: movements trained equally often keep catalog order rather than an arbitrary one.
        let ranked = available.enumerated()
            .filter { timesTrained($0.element) > 0 }
            .sorted { first, second in
                let counts = (timesTrained(first.element), timesTrained(second.element))
                guard counts.0 == counts.1 else { return counts.0 > counts.1 }
                return first.offset < second.offset
            }
            .prefix(featured)
            .map(\.element)
        guard ranked.count < featured else { return Array(ranked) }
        let rest = openers
            .compactMap { opener in available.first { $0.id == opener } }
            .filter { opener in !ranked.contains { $0.id == opener.id } }
        return Array((ranked + rest).prefix(featured))
    }

    public static func matching(query: String, catalog: [Exercise], taken: [String],
                                lastSets: [String: LastSet]? = nil,
                                now: Int64 = 0,
                                sessions: [SessionSummary] = []) -> Result {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let available = catalog.filter { !taken.contains($0.id) }
        let six = term.isEmpty ? mostTrained(available: available, sessions: sessions) : []
        // The match is over the name and every alias this account gave it.
        let wanted = term.lowercased()
        let found = available
            .filter { term.isEmpty || $0.name.lowercased().contains(wanted) || $0.answersTo(wanted) }
            .filter { movement in !six.contains { $0.id == movement.id } }
        let matches = term.isEmpty ? found : Array(found.prefix(shown))
        guard matches.isEmpty, six.isEmpty else {
            return Result(six: six.map { row($0, lastSets: lastSets, now: now) },
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

// The rows only. The search field is the platform's, placed by `.searchable` on whatever stack the
// caller stands in — never a text field drawn to look like one.
struct MovementList: View {
    let options: PickerOptions.Result
    let query: String
    let onPick: (String) -> Void
    let onCreate: (String) -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        if options.six.isEmpty, options.matches.isEmpty, let empty = options.empty {
            ContentUnavailableView {
                Label(empty, systemImage: "magnifyingglass")
                    .foregroundStyle(skin.inkDim)
            } actions: {
                if let create = options.create {
                    // The room's own primary chrome rather than `.borderedProminent`, which fills
                    // itself with the ambient tint and then paints its OWN label colour over it —
                    // a pairing nothing in this room controls. `onAccent` on `accent` is 6.18:1.
                    Button { onCreate(query.trimmingCharacters(in: .whitespacesAndNewlines)) } label: {
                        Text(create)
                            .font(WindmillFont.body(16, .semibold))
                            .foregroundStyle(skin.onAccent)
                            .padding(.horizontal, WindmillSpace.x5)
                            .frame(minHeight: GymTap.minimum)
                            .background(Capsule().fill(skin.accent))
                    }
                    .buttonStyle(.plain)
                }
            }
        } else {
            List {
                if !options.six.isEmpty {
                    Section {
                        ForEach(options.six) { movement in row(movement) }
                    } header: {
                        Text("The six").foregroundStyle(skin.inkFaint)
                    }
                }
                // One label and then a gap: `The six` names the short list, and the rest of the
                // catalogue is what everything under the gap plainly is (C11).
                if !options.matches.isEmpty {
                    Section {
                        ForEach(options.matches) { movement in row(movement) }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, GymTap.minimum)
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
            .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(skin.surface)
    }
}

struct MovementPicker: View {
    let catalog: [Exercise]
    let taken: [String]
    let lastSets: [String: LastSet]?
    // The log as the screen behind holds it RIGHT NOW, which keeps moving. It is read only until the
    // window below has been cut from it; after that the cut is what the six are ranked from.
    let sessions: [SessionSummary]
    let onPick: (String) -> Void
    // The write itself. What is done with the movement it made is `onPick`'s, so minting one and
    // picking one are the same act on the screen behind.
    let onCreate: (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>
    let onClose: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var query = ""
    @State private var minting: MintStep?
    // Newest first. What the six are ranked from; an empty log still answers with the openers. Frozen
    // on the first read that HELD anything and never re-read after that while the picker is up (C18,
    // C20) — `@State` keeps that value however often the screen behind hands this view a longer log.
    @State private var opened: [SessionSummary]

    init(catalog: [Exercise], taken: [String], lastSets: [String: LastSet]?,
         sessions: [SessionSummary],
         onPick: @escaping (String) -> Void,
         onCreate: @escaping (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>,
         onClose: @escaping () -> Void) {
        self.catalog = catalog
        self.taken = taken
        self.lastSets = lastSets
        self.sessions = sessions
        self.onPick = onPick
        self.onCreate = onCreate
        self.onClose = onClose
        _opened = State(initialValue: PickerOptions.window(of: sessions))
    }

    var body: some View {
        NavigationStack {
            MovementList(options: PickerOptions.matching(query: query, catalog: catalog, taken: taken,
                                                         lastSets: lastSets, now: nowMs,
                                                         sessions: opened),
                         query: query, onPick: onPick,
                         onCreate: { minting = MintStep(opening: $0) })
                .background(skin.canvas)
                .navigationTitle("Add movement")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Cancel", action: onClose)
                    }
                }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: Text("Search \(catalog.count) movements"))
        .autocorrectionDisabled()
        .seeding($opened, from: sessions)
        .minting($minting, onCreate: onCreate, onPick: onPick)
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

// The half of the freeze that cannot be made in an initialiser: a picker opened in the moment before
// the log answers seeds an EMPTY window, and an empty window is not a cut — it is the absence of one.
// So the window is taken again on every read until one of them holds a session, and never again after
// that (C20). `isEmpty` is the whole trigger, because that is the only transition the rule turns on.
private extension View {
    func seeding(_ held: Binding<[SessionSummary]>, from log: [SessionSummary]) -> some View {
        onChange(of: log.isEmpty) { _, nowEmpty in
            guard !nowEmpty else { return }
            held.wrappedValue = PickerOptions.window(of: log, held: held.wrappedValue)
        }
    }
}

// The create step is drawn OVER the picker that opened it and never in place of it: the picker stays
// mounted, so Cancel returns the rows under the finger with the typed query still in the field
// (`15-the-routine.md`). The step stays up until the log answers and the refusal is said on it, so
// the in-flight and refusal states live here with it — and a movement that was minted is picked, which
// is what `Create and add` says.
private struct MintStep: Identifiable {
    let opening: String

    var id: String { opening }
}

private struct Minting: ViewModifier {
    @Binding var step: MintStep?
    let onCreate: (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>
    let onPick: (String) -> Void

    @Environment(\.gymSkin) private var skin
    @State private var creating = false
    @State private var failure: String?

    func body(content: Content) -> some View {
        content.sheet(item: $step, onDismiss: { creating = false; failure = nil }) { open in
            CreateMovementSheet(opening: open.opening, creating: creating, failure: failure,
                                onCreate: { said, equipment in mint(said, loadedAs: equipment) },
                                onCancel: { step = nil })
                .presentationBackground(skin.canvas)
                .presentationDetents([.large])
        }
    }

    private func mint(_ name: String, loadedAs equipment: String) {
        creating = true
        failure = nil
        Task {
            switch await onCreate(name, equipment) {
            case .success(let made):
                creating = false
                step = nil
                onPick(made.id)
            case .failure(let why):
                creating = false
                failure = why.line("“\(name)” wasn’t created")
            }
        }
    }
}

private extension View {
    func minting(_ step: Binding<MintStep?>,
                 onCreate: @escaping (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>,
                 onPick: @escaping (String) -> Void) -> some View {
        modifier(Minting(step: step, onCreate: onCreate, onPick: onPick))
    }
}

struct OpeningPicker: View {
    let catalog: [Exercise]
    let taken: [String]
    let lastSets: [String: LastSet]?
    // The moving log, read only until the window below has been cut from it.
    let sessions: [SessionSummary]
    let isSignedIn: Bool
    let onPick: (String) -> Void
    let onCreate: (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>
    let onBuildRoutine: (() -> Void)?

    @Environment(\.gymSkin) private var skin
    @State private var query = ""
    @State private var minting: MintStep?
    // The same freeze the sheet picker makes (C18, C20), and the one that needs it most: this picker
    // stands for the whole opening of a session, with the log polling behind it the entire time — and
    // it is the first screen a signed-in lifter reaches, often before the first read has landed.
    @State private var opened: [SessionSummary]

    init(catalog: [Exercise], taken: [String], lastSets: [String: LastSet]?,
         sessions: [SessionSummary], isSignedIn: Bool,
         onPick: @escaping (String) -> Void,
         onCreate: @escaping (String, String) async -> Result<Exercise, TrainingStore.WriteFailure>,
         onBuildRoutine: (() -> Void)?) {
        self.catalog = catalog
        self.taken = taken
        self.lastSets = lastSets
        self.sessions = sessions
        self.isSignedIn = isSignedIn
        self.onPick = onPick
        self.onCreate = onCreate
        self.onBuildRoutine = onBuildRoutine
        _opened = State(initialValue: PickerOptions.window(of: sessions))
    }

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
                                                         lastSets: lastSets, now: nowMs,
                                                         sessions: opened),
                         query: query, onPick: onPick,
                         onCreate: { minting = MintStep(opening: $0) })

            agent
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: Text("Search \(catalog.count) movements"))
        .autocorrectionDisabled()
        .seeding($opened, from: sessions)
        .minting($minting, onCreate: onCreate, onPick: onPick)
    }

    // The room hands `onBuildRoutine` over only while nothing already reaches this log; nil withdraws the card.
    @ViewBuilder
    private var agent: some View {
        if let onBuildRoutine {
            Button(action: onBuildRoutine) {
                VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                    Text(isSignedIn
                         ? "Have a written program? An agent can build it — connect it to this log."
                         : "Have a written program? An agent can build it — sign in first.")
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
