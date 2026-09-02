import SwiftUI
import WindmillPlatform

// Every tap writes the whole preferences document: the route replaces it whole, so one field would reset the rest.
// The platform's own form: one section per group, the group's one caption as its footer, and the
// controls inside it the system's.

struct SettingsScreen: View {
    @ObservedObject var store: TrainingStore
    let web: URL
    let connected: ConnectedLogState
    let onConnectedLog: () -> Void
    let onNotes: () -> Void
    let say: (String?) -> Void

    @Environment(\.gymSkin) private var skin
    var body: some View {
        Form {
            units
            restTimer
            confirmation
            doors
        }
        .scrollContentBackground(.hidden)
        .background(skin.canvas)
    }

    // Kilograms are stored under either answer.
    private var units: some View {
        Section {
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
        } header: {
            Text("Units")
        } footer: {
            Text(unitsCaption)
        }
        .listRowBackground(skin.surface)
    }

    // The one honest limitation, said under the control at the moment of the choice, and only when
    // the choice is the one this phone does not apply.
    private var unitsCaption: String {
        guard store.preferences.units == .lb else { return "" }
        return Settings.stillKg
    }

    private var restTimer: some View {
        Section {
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
        } header: {
            Text("Rest timer")
        } footer: {
            Text("A rest that ends while the phone is locked ends quietly.")
        }
        .listRowBackground(skin.surface)
    }

    private var confirmation: some View {
        Section {
            switching("Haptic", isOn: store.preferences.confirmHaptic) {
                write(store.preferences.with(confirmHaptic: $0))
            }
            switching("Sound", isOn: store.preferences.confirmSound) {
                write(store.preferences.with(confirmSound: $0))
            }
        } header: {
            Text("Set confirmation")
        }
        .listRowBackground(skin.surface)
    }

    private var doors: some View {
        Section {
            Button(action: onNotes) {
                door(title: Notes.title, line: Notes.purpose, symbol: "note.text",
                     lit: false, away: false)
            }
            Link(destination: page("/#/settings")) {
                door(title: "CSV export", line: "on the web",
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
        .listRowBackground(skin.surface)
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
        .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
    }

    private func switching(_ label: String, isOn: Bool, _ set: @escaping (Bool) -> Void) -> some View {
        Toggle(label, isOn: Binding(get: { isOn }, set: set))
            .font(WindmillFont.body(13.5))
            .foregroundStyle(skin.inkDim)
            .tint(skin.accent)
            .frame(minHeight: GymTap.minimum)
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
    // Under the Units control, lb only: the same bytes on every surface.
    static let stillKg = "This phone still draws kg."
}
