import SwiftUI
import WindmillPlatform

// GYM'S SETTINGS — five rows, and they are all about a barbell (§I). Everything here changes how the
// room behaves AT THE RACK: units, what plates exist, how long you rest, how a logged set confirms
// itself, and where the log goes when it leaves. Nothing here restates an account screen. Appearance,
// plan, sessions, devices, export-everything and delete live in You; this room has no theme switch of
// its own and draws no notification rows for pushes it does not send.
//
// WHERE IT IS REACHED FROM IS A GAP, NOT A DECISION. §I walks into it from You: gym registers a
// settings SECTION and the shell composes it, exactly as web/src/products/gym/routes.js registers
// `GymSettingsSection`. The native `ProductModule` seam has no such slot — `room`, `hubLine`, `entry`,
// `holdings`, and nothing about settings — and the shell is not this product's territory, so the door
// sits at the foot of Today until the seam exists. When it lands, this screen is what the section
// shows and the row on Today goes with it.
//
// EVERY TAP WRITES THE WHOLE DOCUMENT, because the route replaces it whole: `store.save` sends all
// seven answers, and a screen that sent one field would reset the six it did not touch to their
// defaults. Nothing here is a draft — a tap is the change, on the device first and on the log next,
// the same order every other write in this room takes.
//
// Every target is 46, which is the room's rule and six points more than the board draws: this screen
// is read in the same gym, by the same chalked hands.

struct SettingsScreen: View {
    @ObservedObject var store: TrainingStore
    let web: URL
    // What actually reaches this log, read once by the room. The row below NAMES it rather than
    // guessing at it — and says nothing at all when the read did not come back.
    let connected: ConnectedLogState
    let onConnectedLog: () -> Void
    let say: (String?) -> Void

    @Environment(\.gymSkin) private var skin
    @State private var barPadUp = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 9) {
                head
                units
                plateMath
                restTimer
                confirmation
                doors
            }
            .padding(.horizontal, WindmillSpace.x4)
            .padding(.top, WindmillSpace.x8)
            .padding(.bottom, WindmillSpace.x8)
        }
        .sheet(isPresented: $barPadUp) {
            // The pad the logger's numeral opens, spending it on the one other number in this product
            // a lifter types. Its own band is wider than a bar's, so what it hands back is checked
            // here and REFUSED out loud rather than clamped into range behind their back.
            KeypadSheet(mode: .weight, current: store.preferences.barWeightKg,
                        onCommit: { typed in
                            barPadUp = false
                            guard typed >= 0, typed <= 100 else {
                                say("a bar weighs from 0 to 100 kg — \(Readout.weight(typed)) isn’t one")
                                return
                            }
                            write(store.preferences.with(barWeightKg: typed))
                        },
                        onCancel: { barPadUp = false })
                .presentationBackground(skin.surface)
                .presentationDetents([.height(520)])
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

    // ROW 1 — the one setting that changes nothing this room draws, and says so. Kilograms are what
    // gym stores under either answer; what this records is how the lifter reads a number, kept on the
    // account for the surfaces that can spell it. This one cannot yet, and a caption is the honest
    // way to say that — the alternative is a toggle that moves and quietly does nothing.
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

    // ROW 2 — what your gym actually owns, and the one setting another screen reads: the line under
    // the logger's numeral is built from these. The chips are the standard set PLUS whatever else the
    // account holds, because a plate this screen does not offer is still one this gym owns — and a
    // plate with no chip would be a setting from another surface with no way back off it. That is
    // also what puts more chips on this screen than the log's twelve kinds: the thirteenth is refused
    // out loud rather than clamped away (`toggle`).
    private var plateMath: some View {
        card {
            HStack(spacing: WindmillSpace.x3) {
                Text("Plate math")
                    .font(WindmillFont.body(15, .bold))
                    .foregroundStyle(skin.ink)
                Spacer(minLength: 0)
                Button { barPadUp = true } label: {
                    Text("bar \(Readout.weight(store.preferences.barWeightKg)) kg")
                        .font(GymType.numeral(12.5))
                        .foregroundStyle(skin.inkDim)
                        .frame(minHeight: GymTap.minimum)
                }
                .accessibilityLabel("Bar weight")
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 62), spacing: 6, alignment: .leading)],
                      spacing: 6) {
                ForEach(chips, id: \.self) { plate in
                    let owned = store.preferences.owning(plate)
                    Button { toggle(plate) } label: {
                        Text(Readout.weight(plate))
                            .font(GymType.numeral(12, .bold))
                            .foregroundStyle(owned ? skin.accent : skin.inkFaint)
                            .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                            .background(Capsule().fill(owned ? skin.accentSoft : .clear))
                            .overlay(Capsule().strokeBorder(owned ? skin.accent : skin.lineStrong,
                                                            lineWidth: 1))
                    }
                    .accessibilityAddTraits(owned ? [.isSelected] : [])
                }
            }
            caption("What your gym owns, per side.")
        }
    }

    // ROW 3 — off by default, and that is the decision rather than an omission: a timer nobody asked
    // for, beeping in a gym, is the kind of thing this product does not do. A routine that writes its
    // own rest against a movement still wins over this for that movement.
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

    // ROW 4 — the intent is the account's; what a surface can honour is the surface's, and this one
    // has a haptic and uses it. The caption under it named that, and then named what the INSTALLED
    // WEB APP does instead — which is a sentence about another surface, on a screen a lifter opened
    // to change this one. It came off on 2026-08-12 with the rest of the room's explaining; the two
    // switches say what they do by being switches.
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

    // ROW 5 — the two doors out of the log. The export is still the web's, because a CSV is a file
    // this app has nowhere to put yet.
    //
    // THE CONNECTED LOG IS NO LONGER A LINK OUT, and what changed is that this client can now answer
    // the question. The row used to point at the web because the grant state was "an entitlements
    // read this client does not have" — it was never an entitlement, it is the account's own
    // credentials, `GET /v1/oauth/grants` and `GET /v1/mcp-keys`, and the room reads both. So the
    // row names the real state and opens the screen that spells out what a connection can and can
    // never do (§D13); the web keeps the two acts it owns, making a connection and ending one.
    //
    // WHAT THE LINE SAYS WHEN THE READ DID NOT COME BACK IS NOTHING about the state. A door is a
    // place to go rather than a claim, so it describes the destination and denies no connection.
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

    // The standard set, plus whatever else the account holds — a plate this screen does not offer is
    // still a plate this gym owns, and one it could not turn off would be a setting with no way back.
    private var chips: [Double] {
        Array(Set(GymPreferences.everyPlate + store.preferences.platesKg)).sorted(by: >)
    }

    // `away` is the glyph and the glyph is a promise about where the tap goes: the arrow leaves this
    // app for a browser, the chevron stays in the room. A door that wore the wrong one would be the
    // smallest lie on this screen and the one a thumb learns fastest.
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

    // The dial's own words, and `off` is one of them: there is no zero here, and no `false`.
    static func spell(_ seconds: Int?) -> String {
        guard let seconds else { return "off" }
        return Readout.clock(Int64(seconds) * 1000)
    }

    // The export resolves against the account's own host, so a debug build pointed at a local server
    // opens that one rather than windmill.works.
    private func page(_ path: String) -> URL {
        URL(string: path, relativeTo: web) ?? web
    }

    // A chip is turned on, or off, or REFUSED OUT LOUD — the same shape the bar keypad takes three
    // rows up, and for the same reason. The log holds twelve kinds of plate and says so; a chip that
    // took a tap and stayed dark, or that came on by quietly dropping the 0.5 this gym owns off the
    // end of the list, would be the screen lying about what it just did — and the readout under the
    // logger's numeral would stop naming a plate the lifter is standing next to. Turning one OFF is
    // never refused: it can only bring the count down.
    private func toggle(_ plate: Double) {
        guard store.preferences.hasRoomFor(plate) else {
            return say("a gym holds at most \(GymPreferences.maxPlateKinds) kinds of plate — turn one off to make room for \(Readout.weight(plate))")
        }
        write(store.preferences.toggling(plate))
    }

    private func write(_ wanted: GymPreferences) {
        say(nil)
        Task {
            guard let why = await store.save(wanted) else { return }
            say(why.line("that setting is on this device, not on the log"))
        }
    }
}
