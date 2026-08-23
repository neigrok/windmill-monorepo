import SwiftUI

// Device-local: none of it waits for an account.
public struct Journey {
    public private(set) var asked: Bool
    public private(set) var lastRoom: String?     // nil means the hub
    public private(set) var houseShown: Bool

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

    // nil clears the remembered room.
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

    public func shouldIntroduceHouse(madeSomething: Bool, otherRooms: Int) -> Bool {
        !houseShown && madeSomething && otherRooms > 0
    }
}

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

private struct EntryCard: View {
    let product: any ProductModule

    var body: some View {
        HStack(alignment: .top, spacing: WindmillSpace.x3) {
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
                if let caveat = product.caveat {
                    Text(caveat)
                        .font(WindmillFont.mono(10.5))
                        .kerning(0.4)
                        .foregroundStyle(skin.dim)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, WindmillSpace.x2)
                }
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

// Shell chrome only — a product owns its own skin.
public enum Appearance: String, CaseIterable {
    case light, dark, system

    public static let storageKey = "windmill.appearance"

    public var label: String {
        switch self {
        case .light: return "Light"
        case .dark: return "Dark"
        case .system: return "System"
        }
    }

    public var symbol: String? {
        switch self {
        case .light: return "sun.max"
        case .dark: return "moon"
        case .system: return nil
        }
    }

    // nil hands the choice back to the OS.
    public var scheme: ColorScheme? {
        switch self {
        case .light: return .light
        case .dark: return .dark
        case .system: return nil
        }
    }
}
