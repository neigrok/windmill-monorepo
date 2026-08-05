import SwiftUI
import WindmillPlatform

// THE PICKER — type to filter, live, and a door out at the bottom of every empty result. A movement
// is a stable identity and never a typed string, so the only way to lift something the catalog has
// never heard of is to MINT it here; that is what keeps twelve weeks of "Bench Press" one movement
// instead of four spellings of one.
//
// The empty state is three different silences and they must not share a sentence. A lifter who typed
// a letter the catalog does not hold was once told their signal was out — the app reporting a failure
// that had not happened, and pointing them at the wrong thing to fix. Only an EMPTY catalog may
// mention signal. The native twin of web/src/products/gym/logger/movements.js.

public enum PickerOptions {
    public static let shown = 7

    public struct Result: Equatable {
        public let matches: [Exercise]
        public let empty: String?
        // The door out belongs to exactly one of the three silences: the one a NAME can answer. A
        // catalog that never loaded comes back with signal, and a catalog already entirely in the
        // session is answered by the jump sheet — minting a duplicate of a movement you are already
        // logging is the one thing the stable-identity rule exists to prevent.
        public let create: String?
    }

    public static func matching(query: String, catalog: [Exercise], taken: [String]) -> Result {
        let term = query.trimmingCharacters(in: .whitespaces)
        let available = catalog.filter { !taken.contains($0.id) }
        let matches = available
            .filter { term.isEmpty || $0.name.lowercased().contains(term.lowercased()) }
            .prefix(shown)
        guard matches.isEmpty else {
            return Result(matches: Array(matches), empty: nil, create: nil)
        }
        if catalog.isEmpty {
            return Result(matches: [], empty: "The catalog didn’t load. It comes back when you have signal.",
                          create: nil)
        }
        if available.isEmpty {
            return Result(matches: [], empty: "Every movement in the catalog is already in this session.",
                          create: nil)
        }
        // An empty query matches every available movement, so reaching here means something was
        // typed — the button can quote it without asking whether there is anything to quote.
        return Result(matches: [], empty: "No movement by that name.", create: "Create “\(term)”")
    }
}

struct MovementPicker: View {
    let catalog: [Exercise]
    let taken: [String]
    let onPick: (String) -> Void
    let onCreate: (String) -> Void
    let onClose: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var query = ""

    var body: some View {
        let options = PickerOptions.matching(query: query, catalog: catalog, taken: taken)
        return VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            HStack {
                Text("Movements")
                    .font(WindmillFont.display(20))
                    .foregroundStyle(skin.ink)
                Spacer()
                Button("Cancel", action: onClose)
                    .font(WindmillFont.body(16))
                    .foregroundStyle(skin.inkDim)
                    .frame(minHeight: GymTap.minimum)
            }

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
                VStack(spacing: 0) {
                    ForEach(options.matches) { movement in
                        Button { onPick(movement.id) } label: {
                            HStack {
                                Text(movement.name)
                                    .font(WindmillFont.body(17))
                                    .foregroundStyle(skin.ink)
                                Spacer()
                                // A movement the lifter minted behaves identically to a seeded one
                                // and is tagged only so they can recognise their own.
                                if movement.custom {
                                    Text("yours")
                                        .font(GymType.numeral(11))
                                        .foregroundStyle(skin.inkFaint)
                                }
                            }
                            .frame(minHeight: GymTap.minimum + 6)
                        }
                        Rectangle().fill(skin.line).frame(height: 1)
                    }
                }
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
                        .foregroundStyle(skin.onSteel)
                        .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.steel))
                }
            }
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(skin.surface)
    }
}
