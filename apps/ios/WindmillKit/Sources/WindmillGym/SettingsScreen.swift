import SwiftUI
import WindmillPlatform

// Every tap writes the whole preferences document: the route replaces it whole, so one field would reset the rest.

struct SettingsScreen: View {
    @ObservedObject var store: TrainingStore
    let web: URL
    let connected: ConnectedLogState
    let onConnectedLog: () -> Void
    let onNotes: () -> Void
    let say: (String?) -> Void

    @Environment(\.gymSkin) private var skin
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 9) {
                head
                units
                restTimer
                confirmation
                caption(Settings.coachReads)
                    .padding(.horizontal, WindmillSpace.x1)
                    .padding(.vertical, WindmillSpace.x2)
                doors
            }
            .padding(.horizontal, WindmillSpace.x4)
            .padding(.top, WindmillSpace.x8)
            .padding(.bottom, WindmillSpace.x8)
        }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("how the room behaves at the rack")
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
        }
        .padding(.bottom, WindmillSpace.x2)
    }

    // Kilograms are stored under either answer.
    private var units: some View {
        card {
            // Drawn, not inherited: a segmented `Picker` outside a Form or List renders no label at
            // all, so without this row the card is an unnamed `kg | lb` pair. Same shape as the two
            // cards below it.
            Text("Units")
                .font(WindmillFont.body(15, .bold))
                .foregroundStyle(skin.ink)
            // A stock segmented control measures 30.7pt on this OS — under the 46pt floor every other
            // control in this room keeps (`GymTap.minimum`), and the one thing on a settings screen a
            // thumb would have to aim at. `.controlSize(.large)` takes it to 48; a `.frame` does not
            // move it at all, because the control's height is its own and SwiftUI hands it through.
            Picker("Units", selection: Binding(get: { store.preferences.units },
                                               set: { write(store.preferences.with(units: $0)) })) {
                ForEach(Units.allCases, id: \.rawValue) { unit in
                    Text(unit.rawValue).tag(unit)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.large)
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
            Picker("Rest timer", selection: Binding(get: { store.preferences.restSeconds },
                                                    set: { write(store.preferences.resting($0)) })) {
                ForEach(Rest.choices, id: \.self) { seconds in
                    Text(Self.spell(seconds)).tag(seconds)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.large)
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
            Button(action: onNotes) {
                door(title: Notes.title, line: Notes.purpose, symbol: "note.text",
                     lit: false, away: false)
            }
            Link(destination: page("/#/settings")) {
                door(title: "Export", line: "sets, notes and weigh-ins as CSV · yours, always",
                     symbol: "tablecells", lit: false, away: true)
            }
            Link(destination: page("/#/gym/coach/threads")) {
                door(title: "Export conversations", line: "every Coach conversation as CSV",
                     symbol: "tablecells", lit: false, away: true)
            }
            Button(action: onConnectedLog) {
                door(title: ConnectedLog.stateTitle,
                     line: connected.settingsLine(now: Int64(Date().timeIntervalSince1970 * 1000))
                        ?? ConnectedLog.settingsFallback,
                     symbol: "link", lit: true, away: false)
            }
        }
    }

    // `away` draws the arrow that leaves this app for a browser; the chevron stays in the room.
    private func door(title: String, line: String, symbol: String, lit: Bool, away: Bool) -> some View {
        HStack(spacing: WindmillSpace.x3) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(lit ? skin.accent : skin.inkFaint)
                .frame(width: 22)
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

enum Settings {
    // Beside the dials, naming what Coach excludes rather than pointing at it.
    static let coachReads = "Coach reads your notes, not your settings."
}
