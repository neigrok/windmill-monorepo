import SwiftUI
import WindmillPlatform

// THE PICKER — type to filter, live, and a door out at the bottom of every empty result. A movement
// is a stable identity and never a typed string, so the only way to lift something the catalog has
// never heard of is to MINT it here; that is what keeps twelve weeks of "Bench Press" one movement
// instead of four spellings of one.
//
// It is drawn in two places and they are one screen: over a running session as `MovementPicker`
// (§B7, the sheet the assembly list opens), and as the room's opening surface, `OpeningPicker`
// (§J22) — the picker already up over a session that started when the lifter arrived. Both spend
// `MovementList`, so the rows, the filter and the door out cannot drift apart.
//
// The empty state is three different silences and they must not share a sentence. A lifter who typed
// a letter the catalog does not hold was once told their signal was out — the app reporting a failure
// that had not happened, and pointing them at the wrong thing to fix. Only an EMPTY catalog may
// mention signal, and on this surface that silence is unreachable: the sixty-four seeds ship in the
// app (DeviceCatalog.seeded), so the room always has a catalog to filter. It stays because
// `PickerOptions` is a pure function and answers honestly for any input, and because the web's
// catalog really does come over the wire — the two surfaces keep one sentence for one silence.
// The native twin of web/src/products/gym/logger/movements.js.

public enum PickerOptions {
    public static let shown = 7

    // THE SIX (§J22). A CLIENT constant and never a server concept: the log has sixty-four movements
    // and no opinion about which matter, while this product is for a lifter on a written barbell
    // program, and these are the six that program is made of. They lead an unfiltered list and step
    // aside the moment anything is typed — a shortcut past the search field, not a category.
    //
    // Ids rather than names, because a name is what one account calls a movement and these rows are
    // the seeds every account starts from (backend/db/schema.sql).
    public static let six = ["back-squat", "bench-press", "deadlift",
                             "overhead-press", "barbell-row", "chin-up"]

    // A movement as this list draws it: the name, whether the lifter minted it, and the one line of
    // their own history under it. `meta` is optional and the distinction is the point — see `line`.
    public struct Row: Equatable, Identifiable {
        public let id: String
        public let name: String
        public let yours: Bool
        public let meta: String?
    }

    public struct Result: Equatable {
        // The six that are not already in the session, in the order §J22 lists them. Empty the
        // moment a query is typed: filtering is over the whole catalog and a pinned section on top
        // of a search result would be answering a question nobody asked.
        public let six: [Row]
        public let matches: [Row]
        public let empty: String?
        // The door out belongs to exactly one of the three silences: the one a NAME can answer. A
        // catalog that never loaded comes back with signal, and a catalog already entirely in the
        // session is answered by the assembly list — minting a duplicate of a movement you are
        // already logging is the one thing the stable-identity rule exists to prevent.
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
        let matches = available
            .filter { term.isEmpty || $0.name.lowercased().contains(term.lowercased()) }
            .filter { movement in !featured.contains { $0.id == movement.id } }
            .prefix(shown)
        guard matches.isEmpty, featured.isEmpty else {
            return Result(six: featured.map { row($0, lastSets: lastSets, now: now) },
                          matches: matches.map { row($0, lastSets: lastSets, now: now) },
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
        // An empty query matches every available movement, so reaching here means something was
        // typed — the button can quote it without asking whether there is anything to quote.
        return Result(six: [], matches: [], empty: "No movement by that name.",
                      create: "Create “\(term)”")
    }

    private static func row(_ movement: Exercise, lastSets: [String: LastSet]?, now: Int64) -> Row {
        Row(id: movement.id, name: movement.name, yours: movement.custom,
            meta: line(for: movement.id, lastSets: lastSets, now: now))
    }

    // THE ONE LINE OF HISTORY UNDER A NAME, and its silence is not `never logged`. The read is
    // sparse — a movement the lifter has trained has a line and no other movement has anything — so
    // an absent key is only an answer once the read itself has landed. Until then this says nothing:
    // telling a lifter of ten years they have never squatted, because a phone was in a basement, is
    // the product lying in the pixel the picker exists for.
    private static func line(for exerciseId: String, lastSets: [String: LastSet]?,
                             now: Int64) -> String? {
        guard let lastSets else { return nil }
        guard let last = lastSets[exerciseId] else { return "never logged" }
        return "last \(Readout.effort(weightKg: last.weightKg, reps: last.reps))"
            + " · \(Readout.ago(last.atMs, now: now))"
    }
}

// The rows, the field over them and the door out — everything both pickers share, and the only place
// any of it is drawn.
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
                    // A movement the lifter minted behaves identically to a seeded one and is
                    // tagged only so they can recognise their own.
                    if movement.yours {
                        Text("yours")
                            .font(GymType.numeral(10.5, .bold))
                            .textCase(.uppercase)
                            .kerning(0.6)
                            .foregroundStyle(skin.accent)
                    }
                    Spacer(minLength: 0)
                }
                // Absent while the log has not answered — see PickerOptions.line.
                if let meta = movement.meta {
                    Text(meta)
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.inkFaint)
                }
            }
            .padding(.horizontal, WindmillSpace.x3)
            .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6, alignment: .leading)
            // A card per movement, as both boards draw it: these rows carry two lines each now, and
            // a hairline between them would leave the name and the meta of one row reading as two.
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(skin.line, lineWidth: 1))
        }
    }
}

// §B7 — the picker over a running session, opened from the assembly list's "+ Add next movement".
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
                Text("Add exercise")
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
        // The room's ground, not the sheet's: these rows are cards and a card needs something to sit
        // on. It is the same list either picker draws, so it stands on the same colour in both.
        .background(skin.canvas)
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

// §J22 — GYM'S FIRST SURFACE, and the whole of what this room owes the shell's one question. It is
// not a tour: it is the real screen with its first move already made, which is why nobody pressed
// start. The session above is running, the picker is already up, and the six lead the list.
//
// It is also every later moment a session holds nothing — the last movement swiped away, a routine
// whose plan named nothing — because the sentence is true then too: this is what you are starting
// with.
//
// THE ONE ACCOUNT VERB IN THE ROOM is the card at the foot. Everything else here — every movement,
// every set, the whole log — works signed out forever, and the footer says so in the same breath.
// The verb opens the door at the tap and puts the lifter back on this screen, mid-session; signing
// in claims the session they already started, which the claim replay already does.
struct OpeningPicker: View {
    let catalog: [Exercise]
    let taken: [String]
    let lastSets: [String: LastSet]?
    let isSignedIn: Bool
    let onPick: (String) -> Void
    let onCreate: (String) -> Void
    // The one account verb, and nil is the whole of its rule — see `agent`.
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
            Text("Or just log freely — pick a movement and start. Nothing here needs an account.")
                .font(GymType.numeral(12.5))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
        }
    }

    // The verb changes with the account and the sentence changes with it, because only one of them
    // is ever true: signed out the agent needs an account, and signed in it needs a grant, which is
    // made at a computer — so this card opens the page holding the recipe rather than the room's own
    // invitation screen. It cannot open that one: the picker is drawn INSIDE a running session, and
    // a live workout outranks every away screen, so a tap that pushed one would land on nothing.
    //
    // AND IT IS WITHDRAWN THE MOMENT SOMETHING ALREADY REACHES THIS LOG — the room hands `onBuild`
    // over only while `connected.invites`, exactly as Routines gets `ConnectInvite`. An invitation
    // to do the thing you have already done is advertising, and this is the one solicitation a
    // lifter would meet every single session. Nothing here counts how many times it was passed over.
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
