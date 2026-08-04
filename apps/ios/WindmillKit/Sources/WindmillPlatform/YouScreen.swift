import SwiftUI

// You & Pro — the shell's own two screens, and the only two it has besides the hub.
//
// Always clay, whatever room you came from, and always one tap away: the avatar on the hub, or the
// You seat at the end of any app's bar. Windmill One lives INSIDE You and nowhere else, so the
// switcher stays about rooms and never about billing.
//
// Two deliberate departures from the board, both toward honesty:
//
//  · It says "Windmill Pro". The name was settled as **Windmill One** on 2026-08-02 (the design
//    project's own consistency ledger, entry 0 — the backend, every legal surface and the live
//    Paddle product were all renamed). The board is behind; the name here is the settled one.
//  · The board shows a plan meter and an Appearance row. This client has no entitlements call and
//    the shell has no appearance of its own to set, so neither is drawn. A meter that invented a
//    number, or a control that changed nothing, would both be worse than the gap.

struct YouScreen: View {
    @ObservedObject var auth: AuthStore
    let products: [any ProductModule]

    @Environment(\.dismiss) private var dismiss
    @State private var doorOpen = false
    @State private var proUp = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: WindmillSpace.x4) {
                        AvatarDot(initial: initial, size: 46)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(auth.status.user?.name.isEmpty == false ? auth.status.user!.name : "Windmill")
                                .font(WindmillFont.display(19, .bold))
                                .foregroundStyle(WindmillColor.textPrimary)
                            Text(subtitle)
                                .font(WindmillFont.body(13))
                                .foregroundStyle(WindmillColor.textTertiary)
                        }
                    }
                    .padding(.vertical, WindmillSpace.x1)
                }

                Section {
                    Button { proUp = true } label: {
                        HStack {
                            Text("Windmill One").foregroundStyle(WindmillColor.textPrimary)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(WindmillColor.textTertiary)
                        }
                    }
                } footer: {
                    Text("Windmill is free. One buys tending — the AI that plants and reshapes your plans.")
                }

                // The honest version of a save-your-work nudge: it states what is actually at
                // stake, once, where someone came to look — instead of interrupting to say it.
                // Only while signed out; once there is an account the pages are in it.
                if auth.status.user == nil, !held.isEmpty {
                    Section("On this device") {
                        ForEach(held, id: \.0) { label, holdings in
                            LabeledContent(label, value: holdings.phrase)
                        }
                    }
                }

                Section {
                    Link("Connected tools · MCP", destination: URL(string: "https://windmill.works/#/connect")!)
                    Link("Sessions & data", destination: URL(string: "https://windmill.works/#/settings")!)
                } footer: {
                    Text("Sessions, connected tools, export and closing your account live on the web for now. Each app's own settings live inside it.")
                }

                Section {
                    if auth.status.user == nil {
                        Button("Sign in") { doorOpen = true }
                    } else {
                        Button("Sign out", role: .destructive) { Task { await auth.signOut() } }
                    }
                } footer: {
                    if auth.status.user == nil {
                        Text("Signing in claims what you've already written and syncs it to your other devices. Until then it lives on this device, and everything works.")
                    } else {
                        Text("Sign out and what you've written stays on this device, editable.")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(WindmillColor.surfaceCanvas)
            .navigationTitle("You")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
            .sheet(isPresented: $doorOpen) { SignInDoor(auth: auth) }
            .sheet(isPresented: $proUp) { ProScreen() }
        }
        .tint(WindmillColor.neutral900)
    }

    // Only products that actually hold something appear — a row reading "0 pages" would be the app
    // telling someone their empty room is at risk.
    private var held: [(String, Holdings)] {
        products.compactMap { product in
            let holdings = product.holdings(Account(api: auth.api, user: auth.status.user))
            return holdings.isEmpty ? nil : (product.label, holdings)
        }
    }

    private var subtitle: String {
        guard let user = auth.status.user else { return "Not signed in · everything works anyway" }
        return "\(user.email) · one account, all three apps"
    }

    private var initial: String {
        guard let user = auth.status.user else { return "" }
        if let first = user.name.first { return String(first) }
        return user.email.first.map(String.init) ?? ""
    }
}

// Windmill One — the superapp's only paywall, and it sells tending rather than re-selling a
// default. Every number and every line below is the pricing canon's.
struct ProScreen: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: WindmillSpace.x5) {
                    Text("One plan · all of Windmill")
                        .font(WindmillFont.mono(11.5))
                        .kerning(0.6)
                        .foregroundStyle(WindmillColor.textTertiary)

                    HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x2) {
                        Text("Windmill One")
                            .font(WindmillFont.display(26, .heavy))
                            .foregroundStyle(WindmillColor.textPrimary)
                        Spacer()
                        Text("$12")
                            .font(WindmillFont.display(26, .heavy))
                            .foregroundStyle(WindmillColor.textPrimary)
                        Text("/ month")
                            .font(WindmillFont.body(13))
                            .foregroundStyle(WindmillColor.textTertiary)
                    }

                    Text("Windmill is free — every app, every device, hand editing forever. One buys tending: the AI that plants and reshapes your plans, with a receipt for every run.")
                        .font(WindmillFont.body(15))
                        .lineSpacing(4)
                        .foregroundStyle(WindmillColor.textSecondary)

                    VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                        included("300 tendings a month", "Across Roadmap, Journal and Gym")
                        included("Every run is a visible receipt", nil)
                        included("Cancel anytime", nil)
                    }
                    .padding(.vertical, WindmillSpace.x1)

                    Text("Free keeps 30 tendings a month — a real allowance, not a teaser.")
                        .font(WindmillFont.body(13))
                        .foregroundStyle(WindmillColor.textTertiary)

                    Link(destination: URL(string: "https://windmill.works/pricing.html")!) {
                        Text("See the plan on the web")
                            .font(WindmillFont.body(16, .semibold))
                            .foregroundStyle(WindmillColor.neutral900)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, WindmillSpace.x3)
                            .background(Capsule().fill(WindmillColor.gold400))
                    }

                    Text("USD · before tax · one subscription, three apps")
                        .font(WindmillFont.body(12))
                        .foregroundStyle(WindmillColor.textTertiary)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
                .padding(WindmillSpace.x6)
            }
            .background(WindmillColor.surfaceCanvas)
            .navigationTitle("Windmill One")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
        .tint(WindmillColor.neutral900)
    }

    private func included(_ title: String, _ detail: String?) -> some View {
        HStack(alignment: .top, spacing: WindmillSpace.x3) {
            Image(systemName: "checkmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(WindmillColor.olive500)
                .padding(.top, 3)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(WindmillFont.body(15, .semibold))
                    .foregroundStyle(WindmillColor.textPrimary)
                if let detail {
                    Text(detail)
                        .font(WindmillFont.body(13))
                        .foregroundStyle(WindmillColor.textTertiary)
                }
            }
        }
    }
}
