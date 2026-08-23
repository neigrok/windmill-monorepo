import SwiftUI
import WindmillPlatform

// Every tap writes the whole preferences document: the route replaces it whole, so one field would reset the rest.

struct SettingsScreen: View {
    @ObservedObject var store: TrainingStore
    let web: URL
    let connected: ConnectedLogState
    let onConnectedLog: () -> Void
    let say: (String?) -> Void

    @Environment(\.gymSkin) private var skin
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 9) {
                head
                units
                restTimer
                confirmation
                doors
            }
            .padding(.horizontal, WindmillSpace.x4)
            .padding(.top, WindmillSpace.x8)
            .padding(.bottom, WindmillSpace.x8)
        }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Gym")
                .font(WindmillFont.display(30))
                .foregroundStyle(skin.ink)
            Text("how the room behaves at the rack")
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
        }
        .padding(.bottom, WindmillSpace.x2)
    }

    // Kilograms are stored under either answer.
    private var units: some View {
        card {
            HStack(spacing: WindmillSpace.x3) {
                Text("Units")
                    .font(WindmillFont.body(15, .bold))
                    .foregroundStyle(skin.ink)
                Spacer(minLength: 0)
                HStack(spacing: 4) {
                    ForEach(Units.allCases, id: \.rawValue) { unit in
                        let chosen = unit == store.preferences.units
                        Button { write(store.preferences.with(units: unit)) } label: {
                            Text(unit.rawValue)
                                .font(GymType.numeral(12.5, .bold))
                                .foregroundStyle(chosen ? skin.onAccent : skin.inkDim)
                                .padding(.horizontal, WindmillSpace.x4)
                                .frame(minHeight: GymTap.minimum)
                                .background(Capsule().fill(chosen ? skin.accent : .clear))
                        }
                        .accessibilityAddTraits(chosen ? [.isSelected] : [])
                    }
                }
                .padding(4)
                .background(Capsule().fill(skin.canvas))
            }
            caption("Display only — nothing stored changes.")
            if store.preferences.units == .lb {
                caption("Not on this phone yet — this room still draws kg. Your answer is kept on the account.")
            }
        }
    }

    // A routine's own rest against a movement wins over this for that movement.
    private var restTimer: some View {
        card {
            HStack(spacing: WindmillSpace.x3) {
                Text("Rest timer")
                    .font(WindmillFont.body(15, .bold))
                    .foregroundStyle(skin.ink)
                Spacer(minLength: 0)
                Text(Self.spell(store.preferences.restSeconds))
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkDim)
            }
            HStack(spacing: 6) {
                ForEach(Array(Rest.choices.enumerated()), id: \.offset) { _, seconds in
                    let chosen = seconds == store.preferences.restSeconds
                    Button { write(store.preferences.resting(seconds)) } label: {
                        Text(Self.spell(seconds))
                            .font(GymType.numeral(12.5, chosen ? .bold : .regular))
                            .foregroundStyle(chosen ? skin.accent : skin.inkDim)
                            .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                            .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                                .fill(chosen ? skin.accentSoft : .clear))
                            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                                .strokeBorder(chosen ? skin.accent : skin.line, lineWidth: 1))
                    }
                    .accessibilityAddTraits(chosen ? [.isSelected] : [])
                }
            }
            switching("Sound when it ends", isOn: store.preferences.restSound) {
                write(store.preferences.with(restSound: $0))
            }
            caption("The sound needs the app awake: a rest that ends while the phone is locked ends quietly.")
        }
    }

    private var confirmation: some View {
        card {
            Text("Set confirmation")
                .font(WindmillFont.body(15, .bold))
                .foregroundStyle(skin.ink)
            switching("Haptic", isOn: store.preferences.confirmHaptic) {
                write(store.preferences.with(confirmHaptic: $0))
            }
            switching("Sound", isOn: store.preferences.confirmSound) {
                write(store.preferences.with(confirmSound: $0))
            }
        }
    }

    private var doors: some View {
        VStack(alignment: .leading, spacing: 9) {
            Link(destination: page("/#/settings")) {
                door(title: "Export", line: "every set as CSV · yours, always", lit: false, away: true)
            }
            Button(action: onConnectedLog) {
                door(title: ConnectedLog.stateTitle,
                     line: connected.settingsLine(now: Int64(Date().timeIntervalSince1970 * 1000))
                        ?? ConnectedLog.settingsFallback,
                     lit: true, away: false)
            }
        }
    }

    // `away` draws the arrow that leaves this app for a browser; the chevron stays in the room.
    private func door(title: String, line: String, lit: Bool, away: Bool) -> some View {
        HStack(spacing: WindmillSpace.x3) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(WindmillFont.body(15, .bold))
                    .foregroundStyle(lit ? skin.accent : skin.ink)
                Text(line)
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(lit ? skin.inkDim : skin.inkFaint)
            }
            Spacer(minLength: 0)
            Image(systemName: away ? "arrow.up.right" : "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(lit ? skin.accent : skin.inkFaint)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
            .strokeBorder(lit ? skin.accent : skin.line, lineWidth: 1))
    }

    private func switching(_ label: String, isOn: Bool, _ set: @escaping (Bool) -> Void) -> some View {
        Toggle(label, isOn: Binding(get: { isOn }, set: set))
            .font(WindmillFont.body(13.5))
            .foregroundStyle(skin.inkDim)
            .tint(skin.accent)
            .frame(minHeight: GymTap.minimum)
    }

    private func caption(_ line: String) -> some View {
        Text(line)
            .font(GymType.numeral(12.5))
            .foregroundStyle(skin.inkFaint)
            .lineSpacing(3)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2, content: content)
            .padding(WindmillSpace.x4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                .strokeBorder(skin.line, lineWidth: 1))
    }

    // nil spells `off`: there is no zero here and no `false`.
    static func spell(_ seconds: Int?) -> String {
        guard let seconds else { return "off" }
        return Readout.clock(Int64(seconds) * 1000)
    }

    private func page(_ path: String) -> URL {
        URL(string: path, relativeTo: web) ?? web
    }

    private func write(_ wanted: GymPreferences) {
        say(nil)
        Task {
            guard let why = await store.save(wanted) else { return }
            say(why.line("that setting is on this device, not on the log"))
        }
    }
}
