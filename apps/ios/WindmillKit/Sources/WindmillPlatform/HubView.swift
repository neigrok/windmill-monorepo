import SwiftUI

struct HubView: View {
    let products: [any ProductModule]
    let account: Account
    let user: User?
    let onEnter: (String) -> Void
    let onYou: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Spacer(minLength: WindmillSpace.x6)
            doors
        }
        .padding(.horizontal, WindmillSpace.x5)
        .padding(.top, WindmillSpace.x4)
        .padding(.bottom, WindmillSpace.x8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .background(WindmillColor.surfaceCanvas.ignoresSafeArea())
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Windmill")
                    .font(WindmillFont.display(26, .heavy))
                    .foregroundStyle(WindmillColor.textPrimary)
                Text(greeting)
                    .font(WindmillFont.body(15))
                    .foregroundStyle(WindmillColor.textSecondary)
            }
            Spacer()
            Button(action: onYou) { AvatarDot(initial: initial, size: 34) }
                .accessibilityLabel("You")
        }
    }

    private var doors: some View {
        VStack(spacing: WindmillSpace.x3) {
            Text(Self.today())
                .font(WindmillFont.mono(11.5))
                .kerning(0.6)
                .foregroundStyle(WindmillColor.textTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, WindmillSpace.x1)

            ForEach(ordered, id: \.id) { product in
                Button { onEnter(product.id) } label: {
                    HubCard(product: product, line: product.hubLine(account))
                }
            }
        }
    }

    // Registry order is most-important-first; rendered reversed, so it lands lowest. Running sinks past all.
    private var ordered: [any ProductModule] {
        let lines = products.reversed().map { ($0, $0.hubLine(account)) }
        return lines.filter { !$0.1.running }.map(\.0) + lines.filter { $0.1.running }.map(\.0)
    }

    private var initial: String {
        guard let name = user?.name, let first = name.first else {
            guard let letter = user?.email.first else { return "" }
            return String(letter)
        }
        return String(first)
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let partOfDay = hour < 12 ? "Good morning" : (hour < 18 ? "Good afternoon" : "Good evening")
        guard let name = user?.name, !name.isEmpty else { return partOfDay }
        return "\(partOfDay), \(name)"
    }

    static func today(_ now: Date = Date(), calendar: Calendar = .current) -> String {
        let weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
        let months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
        let parts = calendar.dateComponents([.weekday, .month, .day], from: now)
        let weekday = weekdays[max(0, min(6, (parts.weekday ?? 1) - 1))]
        let month = months[max(0, min(11, (parts.month ?? 1) - 1))]
        return "\(weekday) · \(month) \(parts.day ?? 0)"
    }
}

private struct HubCard: View {
    let product: any ProductModule
    let line: HubLine

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            HStack(spacing: WindmillSpace.x2) {
                Text(product.label)
                    .font(WindmillFont.body(13, .bold))
                    .foregroundStyle(skin.label)
                Spacer(minLength: 0)
                Text(line.eyebrow)
                    .font(WindmillFont.mono(10.5))
                    .kerning(0.5)
                    .foregroundStyle(skin.eyebrow)
                if line.running {
                    Circle().fill(skin.accent).frame(width: 7, height: 7)
                }
            }

            Text(line.headline)
                .font(WindmillFont.display(19, .bold))
                .foregroundStyle(skin.headline)
                .multilineTextAlignment(.leading)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let meta = line.meta {
                Text(meta)
                    .font(WindmillFont.body(12.5))
                    .foregroundStyle(skin.eyebrow)
                    .lineLimit(1)
            }
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(skin.border, lineWidth: 1))
    }

    private var skin: HubSkin { HubSkin.of(product.id) }
}

private struct HubSkin {
    let surface: Color
    let border: Color
    let label: Color
    let eyebrow: Color
    let headline: Color
    let accent: Color

    static func of(_ productId: String) -> HubSkin {
        switch productId {
        case "journal":
            return HubSkin(surface: Color(hex: 0x0D1824), border: Color(hex: 0xE0B972).opacity(0.22),
                           label: Color(hex: 0xE0B972), eyebrow: Color(hex: 0x8A98AC),
                           headline: Color(hex: 0xF2ECDE), accent: Color(hex: 0xE0B972))
        case "gym":
            return HubSkin(surface: Color(hex: 0x16191D), border: Color.white.opacity(0.10),
                           label: Color(hex: 0x9FB0C4), eyebrow: Color(hex: 0x76818F),
                           headline: Color(hex: 0xEDF1F5), accent: WindmillColor.olive400)
        default:
            return HubSkin(surface: WindmillColor.surfaceCard, border: WindmillColor.borderSubtle,
                           label: WindmillColor.neutral600, eyebrow: WindmillColor.textTertiary,
                           headline: WindmillColor.textPrimary, accent: WindmillColor.olive500)
        }
    }
}
