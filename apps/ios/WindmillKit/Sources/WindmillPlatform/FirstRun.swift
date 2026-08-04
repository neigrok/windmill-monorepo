import SwiftUI

// The journey — everything that happens once and then never again
// (`guidelines/superapp-shell.md` §9, from `templates/superapp-flow`).
//
//   cold launch → one question → straight into that app → the first real thing → the house, once
//
// It lives in one file because it is one feature: three pieces of device-local state and the two
// screens that spend them. All of it is deliberately device-local — the whole point is that none
// of this waits for an account, so none of it may live in one.

// A value, not an object: three flags and where they are kept. Being a struct is what lets the
// shell hold it in @State and read it on the very first frame — an observable object would have to
// load asynchronously, and a returning writer would see the one question flash before the room.
public struct Journey {
    public private(set) var asked: Bool           // the one question has been answered
    public private(set) var lastRoom: String?     // where they stood; nil means the hub
    public private(set) var houseShown: Bool      // the other rooms have been introduced

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        asked = defaults.bool(forKey: Key.asked)
        lastRoom = defaults.string(forKey: Key.lastRoom)
        houseShown = defaults.bool(forKey: Key.houseShown)
    }

    private enum Key {
        static let asked = "windmill.journey.asked"
        static let lastRoom = "windmill.journey.lastRoom"
        static let houseShown = "windmill.journey.houseShown"
    }

    public mutating func answeredFirstQuestion() {
        asked = true
        defaults.set(true, forKey: Key.asked)
    }

    // Where they stood, remembered so the next launch reopens it. Going home is itself an answer —
    // the hub is where they chose to be — so it clears rather than keeping the last room.
    public mutating func stood(in room: String?) {
        lastRoom = room
        if let room {
            defaults.set(room, forKey: Key.lastRoom)
        } else {
            defaults.removeObject(forKey: Key.lastRoom)
        }
    }

    public mutating func houseWasShown() {
        houseShown = true
        defaults.set(true, forKey: Key.houseShown)
    }

    // The house fires on the first capsule tap that happens AFTER something real exists, and never
    // again. This resolves the board's own contradiction — its map says the first capsule tap
    // reveals the other rooms, its screen caption says it fires after the first real thing — by
    // making both true at once, and it needs no polling and no channel out of a room: the shell
    // already has to answer a capsule tap, so it asks the products then.
    public func shouldIntroduceHouse(madeSomething: Bool, otherRooms: Int) -> Bool {
        !houseShown && madeSomething && otherRooms > 0
    }
}

// The one question — the whole of onboarding at the shell level. Not the hub: a hub of three empty
// rooms is a chore list, and an empty state is the worst first impression a superapp can make.
struct EntryQuestionView: View {
    let products: [any ProductModule]
    let onPick: (String) -> Void
    let onSkip: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Windmill")
                .font(WindmillFont.display(26, .heavy))
                .foregroundStyle(WindmillColor.textPrimary)
                .padding(.top, WindmillSpace.x2)

            Spacer(minLength: WindmillSpace.x6)

            // The question and the doors sit low, in thumb reach — the same rule the hub follows.
            Text("What do you want to do first?")
                .font(WindmillFont.display(27, .heavy))
                .foregroundStyle(WindmillColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, WindmillSpace.x4)

            VStack(spacing: WindmillSpace.x3) {
                ForEach(products, id: \.id) { product in
                    Button { onPick(product.id) } label: {
                        EntryCard(product: product)
                    }
                }
            }

            Button(action: onSkip) {
                Text("Just show me around")
                    .font(WindmillFont.body(13, .bold))
                    .foregroundStyle(WindmillColor.textTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, WindmillSpace.x4)
            }
        }
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.bottom, WindmillSpace.x8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .background(WindmillColor.surfaceCanvas.ignoresSafeArea())
    }
}

// A door, in plain verbs and in its product's own skin — so the card already tells you which room
// it opens onto, before you have ever seen one.
private struct EntryCard: View {
    let product: any ProductModule

    var body: some View {
        HStack(spacing: WindmillSpace.x3) {
            Text(String(product.label.prefix(1)))
                .font(WindmillFont.display(17, .heavy))
                .foregroundStyle(skin.label)
                .frame(width: 42, height: 42)
                .background(RoundedRectangle(cornerRadius: 13).fill(skin.chip))

            VStack(alignment: .leading, spacing: 2) {
                Text(product.entry.verb)
                    .font(WindmillFont.body(15.5, .bold))
                    .foregroundStyle(skin.headline)
                Text(product.entry.line)
                    .font(WindmillFont.body(12.5))
                    .foregroundStyle(skin.dim)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 20).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(skin.border, lineWidth: 1))
    }

    private var skin: EntrySkin { EntrySkin.of(product.id) }
}

private struct EntrySkin {
    let surface: Color, border: Color, chip: Color, label: Color, headline: Color, dim: Color

    static func of(_ id: String) -> EntrySkin {
        switch id {
        case "journal":
            return EntrySkin(surface: Color(hex: 0x0D1824), border: Color(hex: 0xE0B972).opacity(0.22),
                             chip: Color(hex: 0xE0B972).opacity(0.16), label: Color(hex: 0xE0B972),
                             headline: Color(hex: 0xF2ECDE), dim: Color(hex: 0x8A98AC))
        case "gym":
            return EntrySkin(surface: Color(hex: 0x16191D), border: Color.white.opacity(0.10),
                             chip: Color.white.opacity(0.08), label: Color(hex: 0x9FB0C4),
                             headline: Color(hex: 0xEDF1F5), dim: Color(hex: 0x76818F))
        default:
            return EntrySkin(surface: WindmillColor.surfaceCard, border: WindmillColor.borderSubtle,
                             chip: WindmillColor.neutral100, label: WindmillColor.neutral700,
                             headline: WindmillColor.textPrimary, dim: WindmillColor.textTertiary)
        }
    }
}

// The house, once. Introduced, never sold — and dismissing it returns you to work.
struct HouseSheet: View {
    let madeIn: any ProductModule
    let others: [any ProductModule]
    let onOpen: (String) -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(madeIn.entry.made) Windmill has \(others.count == 1 ? "one other room" : "two other rooms").")
                .font(WindmillFont.display(21, .bold))
                .foregroundStyle(WindmillColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            Text("Same account, same subscription, nothing to install. The W in the corner moves between them.")
                .font(WindmillFont.body(13.5))
                .foregroundStyle(WindmillColor.textSecondary)
                .lineSpacing(3)
                .padding(.top, WindmillSpace.x2)

            VStack(spacing: WindmillSpace.x2) {
                ForEach(others, id: \.id) { product in
                    Button { onOpen(product.id) } label: {
                        EntryCard(product: product)
                    }
                }
            }
            .padding(.top, WindmillSpace.x4)

            Button(action: onDismiss) {
                Text(madeIn.entry.back)
                    .font(WindmillFont.body(13.5, .bold))
                    .foregroundStyle(WindmillColor.textTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, WindmillSpace.x4)
            }
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WindmillColor.surfaceCard)
    }
}
