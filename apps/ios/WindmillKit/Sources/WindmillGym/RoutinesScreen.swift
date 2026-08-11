import SwiftUI
import WindmillPlatform

// ROUTINES — the written-down days of the program, and the third of the room's three tabs (§F). It
// is a list and a way in: a routine, what it asks for, and a Start on the one you are looking at.
//
// IT DRAWS NO EDITOR, NO `New` AND NO DUPLICATE, and that is a fact about this surface rather than a
// gap in this screen. §B screen 5 gives all three a row action, and every one of them writes a
// routine — which is the web's half of the split (canon §11: the phone owns the open session, the
// web owns the desk work). A control that opened nothing would be the defect this room refuses
// everywhere else. The two ways a routine is written from a phone both already exist and are both
// at the moment they make sense: "Keep this as a routine" at the finish, and the change offer
// mid-session.
//
// The order is the log's own — trained most recently first — so the footer line is a statement about
// this list and not a wish: `Routine.byLastTrained` puts the device's unclaimed routines in the same
// order the server sends the rest.

struct RoutinesScreen: View {
    @ObservedObject var store: TrainingStore
    let onStart: (String) -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                head
                if store.routines.isEmpty {
                    nothingYet
                } else {
                    ForEach(store.routines) { routine in row(routine) }
                    Text("Sorted by last trained, not by when you made them.")
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkFaint)
                        .lineSpacing(3)
                        .padding(.top, WindmillSpace.x2)
                }
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
    }

    private var head: some View {
        Text("Routines")
            .font(WindmillFont.display(32))
            .foregroundStyle(skin.ink)
            .padding(.bottom, WindmillSpace.x1)
    }

    // The same sentence Today's empty state makes, because it is the same fact: this lifter already
    // has a program and the app's job is to catch it, not to make them type it in first.
    private var nothingYet: some View {
        Text("Nothing written down yet. Log a session and name it at the end — that is how a routine gets made here.")
            .font(WindmillFont.body(16))
            .foregroundStyle(skin.inkDim)
            .lineSpacing(5)
            .padding(.top, WindmillSpace.x2)
    }

    private func row(_ routine: Routine) -> some View {
        Button { onStart(routine.id) } label: {
            VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                    Text(routine.name)
                        .font(WindmillFont.body(17, .bold))
                        .foregroundStyle(skin.ink)
                    Spacer(minLength: 0)
                    Text(meta(routine))
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.inkFaint)
                }
                // Keyed on POSITION and never on the movement: a routine may name one twice — bench
                // heavy then bench back-off is the case the domain's `Routine` calls out by name —
                // and two rows sharing an id is undefined behaviour in a ForEach.
                ForEach(routine.entries.sorted { $0.position < $1.position }, id: \.position) { entry in
                    HStack(spacing: WindmillSpace.x3) {
                        Text(Readout.movement(entry.exerciseId, in: store.catalog))
                            .font(WindmillFont.body(14))
                            .foregroundStyle(skin.inkDim)
                        Spacer(minLength: WindmillSpace.x2)
                        Text(Readout.target(sets: entry.targetSets, reps: entry.targetReps,
                                            weightKg: entry.targetWeightKg))
                            .font(GymType.numeral(12.5))
                            .foregroundStyle(skin.targetInk)
                    }
                }
            }
            .padding(WindmillSpace.x4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
        }
    }

    private func meta(_ routine: Routine) -> String {
        let count = routine.entries.count
        let movements = count == 1 ? "1 exercise" : "\(count) exercises"
        guard let trained = routine.lastTrainedAtMs else { return "\(movements) · never trained" }
        return "\(movements) · trained \(Readout.ago(trained, now: Int64(Date().timeIntervalSince1970 * 1000)))"
    }
}
