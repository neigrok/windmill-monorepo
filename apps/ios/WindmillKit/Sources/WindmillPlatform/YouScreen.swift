import SwiftUI

struct YouScreen: View {
    @ObservedObject var auth: AuthStore
    let products: [any ProductModule]

    @Environment(\.dismiss) private var dismiss
    @AppStorage(Appearance.storageKey) private var appearance = Appearance.system.rawValue
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
                    Text("Windmill is free. One buys the AI — tending in Roadmap, Talk and echoes in Journal. Coach in Gym answers ten questions a day without it; a plan only raises the AI ceiling behind it. It is not on sale yet.")
                }

                if auth.status.user == nil, !held.isEmpty {
                    Section("On this device") {
                        ForEach(held, id: \.0) { label, holdings in
                            LabeledContent(label, value: holdings.phrase)
                        }
                    }
                }

                Section {
                    Picker("Appearance", selection: $appearance) {
                        ForEach(Appearance.allCases, id: \.rawValue) { choice in
                            Text(choice.label).tag(choice.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets(top: WindmillSpace.x3, leading: WindmillSpace.x4,
                                              bottom: WindmillSpace.x3, trailing: WindmillSpace.x4))
                } header: {
                    Text("Appearance")
                } footer: {
                    Text("Sets the shell — hub, switcher, You, and every sheet. Rooms keep their own skin: journal’s night-or-day choice lives in journal.")
                }

                Section {
                    Link("Connected tools · MCP", destination: URL(string: "https://windmill.works/#/connect")!)
                    Link("Sessions & data", destination: URL(string: "https://windmill.works/#/settings")!)
                } footer: {
                    Text("Sessions, connected tools, export and closing your account live on the web for now. Each app’s own settings live inside it.")
                }

                Section {
                    if auth.status.user == nil {
                        Button("Sign in") { doorOpen = true }
                    } else {
                        Button("Sign out", role: .destructive) { Task { await auth.signOut() } }
                    }
                } footer: {
                    if auth.status.user == nil {
                        Text("Signing in claims what you’ve already written and syncs it to your other devices. Until then it lives on this device — though not every room opens without an account.")
                    } else {
                        Text("Sign out and what you’ve written stays on this device, editable.")
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

    private var held: [(String, Holdings)] {
        products.compactMap { product in
            let holdings = product.holdings(Account(api: auth.api, user: auth.status.user,
                                                     verified: auth.status.verified))
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

                    Text("Windmill is free — every app, every device, hand editing forever. One buys the AI: tending in Roadmap, Talk and echoes in Journal. Coach in Gym answers ten questions a day without it; a plan only raises the AI ceiling behind it. It is not on sale yet.")
                        .font(WindmillFont.body(15))
                        .lineSpacing(4)
                        .foregroundStyle(WindmillColor.textSecondary)

                    VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                        included("300 tendings a month", "In Roadmap, where tending lives")
                        included("Every run is a visible receipt", nil)
                    }
                    .padding(.vertical, WindmillSpace.x1)

                    Text("Free keeps 30 tendings a month in Roadmap — a real allowance, not a teaser. Tending is not switched on yet.")
                        .font(WindmillFont.body(13))
                        .foregroundStyle(WindmillColor.textTertiary)

                    Link(destination: URL(string: "https://windmill.works/pricing.html")!) {
                        Text("See the plan on the web")
                            .font(WindmillFont.body(16, .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, WindmillSpace.x3)
                            .actionCapsule(.primary)
                    }

                    Text("USD · before tax · one subscription, three apps · not on sale yet")
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
