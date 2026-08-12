import SwiftUI
import WindmillPlatform

// THE RECORD — one exercise, one page, twelve weeks of it (§H), and a READ-ONLY screen a tab opens
// over itself rather than a place to stand: the room's at-rest places are its three tabs, and this
// is reached by tapping a movement's NAME — on Today's routine card, in the routines list, in a
// session read back. It carries the plain bar and no rail, for the same reason the logger does.
//
// It stands where the statistics screen used to. What a lifter wanted from that board is this page:
// best e1RM, the trend, every record with its date, then the recent sets. And it is the surface that
// makes stable exercise identity VISIBLE — rename Back Squat here and the history stays whole,
// because the id never moves and only the name a lifter reads does.
//
// It RENDERS what `Record.page` decided and computes nothing itself: no e1RM, no normalisation, no
// sorting, no arithmetic in a view body.
//
// A CHART ON A PHONE HAS NO SCRUB AND NO HOVER, so every number a mark would otherwise reveal on
// touch is printed beside it — the tiles carry the two standing bests and the axis line carries both
// ends of the series with their own values. A chart whose numbers can only be reached by a gesture
// the surface does not have is a decoration, and this product does not draw those.
//
// WHERE EPLEY IS UNDEFINED THERE IS NO E1RM ANYTHING. A bodyweight or band-assisted movement gets no
// best-e1RM tile and no chart — not a zero, not a dash in a chart frame — and the page says why in
// one line. FOUR DIFFERENT FACTS CAN LEAVE THAT CHART OUT and they may not share a sentence: the
// bar carried no load, the twelve weeks hold nothing, the movement was never worked in a working
// set at all, or this DEVICE answered and computes no estimate for anything. `Record.why` decides
// which; this screen only has the words for it.

struct RecordScreen: View {
    let exerciseId: String
    @ObservedObject var store: TrainingStore
    let isSignedIn: Bool

    @Environment(\.gymSkin) private var skin
    @State private var page: Record.Page?
    @State private var failure: TrainingStore.WriteFailure?
    @State private var renaming = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x4) {
                if let page {
                    head(page)
                    if page.neverLogged {
                        neverLogged
                    } else {
                        if page.best != nil || page.heaviest != nil { tiles(page) }
                        if let chart = page.chart {
                            self.chart(chart)
                        } else if let why = page.noChart {
                            Text(noChart(why))
                                .font(GymType.numeral(12))
                                .foregroundStyle(skin.inkFaint)
                                .lineSpacing(3)
                        }
                        if !page.records.isEmpty { records(page.records) }
                        if !page.days.isEmpty { days(page.days) }
                    }
                    // Outside the branch above, because the sentence is at its truest exactly where
                    // it was unreachable: a page the LOG answered with nothing at all, over a
                    // movement this device has a session of, is the one that owes the explanation.
                    if page.source == .theLog, store.unclaimed(exerciseId) { unclaimed }
                } else if let failure {
                    // In the log's own words when it sent any. A 500 that said "internal error" is
                    // not a phone with no signal, and this screen may not report it as one.
                    silence(failure.line("this record isn’t drawn"), retry: true)
                } else {
                    silence("reading your log…", retry: false)
                }
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
        // Read on the way in and shaped once, outside the body. There is no cache to key on a
        // collection's length and get wrong: a second visit asks again, and a set logged in between
        // counts the next time this page is opened.
        .task { await read() }
        .sheet(isPresented: $renaming) {
            RenameSheet(current: page?.name ?? "",
                        save: { await rename(to: $0) },
                        onClose: { renaming = false })
                .presentationBackground(skin.surface)
                .presentationDetents([.medium])
        }
    }

    // The name at 30, and the one action this page offers beside it. Rename sits INSIDE the scroll
    // rather than in a corner of the room's chrome: the top-left is the shell's capsule lane and the
    // top-right belongs to nobody, so a screen's own action rides with the thing it acts on.
    private func head(_ page: Record.Page) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                Text(page.name)
                    .font(WindmillFont.display(30))
                    .foregroundStyle(skin.ink)
                Spacer(minLength: 0)
                Button { renaming = true } label: {
                    Text("Rename")
                        .font(WindmillFont.body(13, .bold))
                        .foregroundStyle(skin.accent)
                        .frame(minHeight: GymTap.minimum)
                }
            }
            Text(page.subhead)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
        }
    }

    // The two standing bests, side by side. The best e1RM is the one gold number on the page — the
    // same gold the log's row and the finish screen use for a mark that was passed — and the heaviest
    // is stated in the room's own ink, because a load is a fact and not a celebration.
    private func tiles(_ page: Record.Page) -> some View {
        HStack(spacing: WindmillSpace.x2) {
            if let best = page.best { tile(best, ink: skin.prInk) }
            if let heaviest = page.heaviest { tile(heaviest, ink: skin.ink) }
        }
    }

    private func tile(_ tile: Record.Tile, ink: Color) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            Text(tile.caption.uppercased())
                .font(GymType.numeral(10.5))
                .tracking(0.7)
                .foregroundStyle(skin.inkFaint)
            Text(tile.value)
                .font(WindmillFont.display(34, .heavy).monospacedDigit())
                .foregroundStyle(ink)
            Text(tile.under)
                .font(GymType.numeral(11.5))
                .foregroundStyle(skin.inkFaint)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
    }

    // ONE CHART, and it plots e1RM per session — the only figure that compares a 5 × 100 to a
    // 3 × 110. Bars, not a line: a training log is discrete events, and a line between them implies
    // days that never happened.
    private func chart(_ chart: Record.Chart) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            HStack(alignment: .firstTextBaseline) {
                Text("E1RM PER SESSION")
                    .font(GymType.numeral(10.5))
                    .tracking(0.7)
                    .foregroundStyle(skin.inkFaint)
                Spacer(minLength: WindmillSpace.x3)
                Text(chart.window)
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
            }
            HStack(alignment: .bottom, spacing: 6) {
                ForEach(chart.bars) { bar in
                    RoundedRectangle(cornerRadius: 4)
                        .fill(ink(of: bar.mark))
                        .frame(height: max(0, bar.height) * 122)
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(height: 122, alignment: .bottom)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("e1RM per session, \(chart.opened) to \(chart.closed)")
            HStack {
                Text(chart.opened)
                Spacer(minLength: WindmillSpace.x3)
                Text(chart.closed)
            }
            .font(GymType.numeral(10.5))
            .foregroundStyle(skin.inkFaint)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
    }

    // Three tints and each one is a fact: the session holding the standing best is gold, a session
    // that passed every session before it is lit, and the rest are the room's own stone.
    private func ink(of mark: Record.Mark) -> Color {
        switch mark {
        case .best: return skin.prInk
        case .passed: return skin.accent
        case .ordinary: return skin.raised
        }
    }

    private func records(_ rows: [Record.Row]) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            caption("Personal records")
            // Newest first, and the newest one IS the standing best — so it wears the gold edge and
            // every mark under it is a step on the way there. A row's id is its PLACE on the ladder,
            // because two sessions can share a start instant and an id shared in a `ForEach` is
            // undefined behaviour.
            ForEach(rows) { row in
                let leading = row.id == 0
                HStack(spacing: WindmillSpace.x3) {
                    Text(row.effort)
                        .font(GymType.numeral(14, .bold))
                        .foregroundStyle(skin.ink)
                    if let estimate = row.estimate {
                        Text(estimate)
                            .font(GymType.numeral(11.5))
                            .foregroundStyle(skin.inkDim)
                    }
                    Spacer(minLength: WindmillSpace.x2)
                    Text(row.when)
                        .font(GymType.numeral(11.5))
                        .foregroundStyle(skin.inkFaint)
                }
                .padding(.horizontal, WindmillSpace.x3)
                .padding(.vertical, WindmillSpace.x3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                    .fill(leading ? skin.prInk.opacity(0.12) : skin.surface))
                .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                    .strokeBorder(leading ? skin.prInk : skin.line, lineWidth: 1))
            }
        }
    }

    // Grouped by the day they were lived in, warmups already dropped by the read — a warmup counts
    // toward nothing here, and one listed beside a working set would be showing a ramp-up as work.
    private func days(_ days: [Record.Day]) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            caption("Recent sets")
            ForEach(days) { day in
                HStack(alignment: .firstTextBaseline, spacing: WindmillSpace.x3) {
                    Text(day.when)
                        .foregroundStyle(skin.inkFaint)
                        .frame(width: 66, alignment: .leading)
                    Text(day.sets)
                        .foregroundStyle(skin.ink)
                }
                .font(GymType.numeral(13))
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text.uppercased())
            .font(GymType.numeral(10.5))
            .tracking(0.7)
            .foregroundStyle(skin.inkFaint)
            .padding(.top, WindmillSpace.x2)
    }

    // A movement in the catalog you have never lifted is a real and common case — the picker says
    // `never logged` for it — so the page says so and draws no chart furniture over nothing.
    private var neverLogged: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text("Never logged.")
                .font(WindmillFont.body(16))
                .foregroundStyle(skin.inkDim)
            Text("Log a working set of it and its record starts here. Warmups count toward nothing.")
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
    }

    // WHY THERE IS NO CHART, in the room's own voice — `Record.why` decided WHICH fact it is, and
    // these are the words for it. The four may not share a sentence: no estimate at all is a fact
    // about the barbell, a standing best with nothing recent is a fact about the window, a movement
    // worked only in drops is a fact about what counts, and a device answer is a fact about where
    // Epley is computed. Saying "no e1RM" under a tile printing one, or blaming a 40 kg drop set for
    // having no load, would each be this page contradicting itself two lines apart.
    //
    // The device's own case is the one that needs the room and not just the page: the remedy is to
    // sign in, or — already signed in, with the create still owed — to wait for the claim.
    private func noChart(_ why: Record.NoChart) -> String {
        switch why {
        case .onThisDevice:
            guard isSignedIn else {
                return "Your log is on this device. The estimate and the record ladder are computed on your account — sign in and they fill in here."
            }
            return "This movement is still on this device — the log hasn’t heard of it yet. The estimate and the record ladder fill in once it lands."
        case .outsideWindow:
            return "Nothing in the last \(Record.windowWeeks) weeks. The chart draws one bar per session inside that window."
        case .neverWorked:
            return "No working sets of this one yet. A warmup and a drop set are kept, and neither counts toward a record here or anywhere else in gym."
        case .unloaded:
            return "No e1RM for this one: an estimate needs a load above zero, and this movement has none."
        }
    }

    // What the page cannot see, said where it would otherwise be silently missing: a session this
    // device has not claimed yet is not on the log, and this page is the log's answer.
    //
    // It is asked PER MOVEMENT and never off the log's `deviceOnly`, which is a set of session ids:
    // one unclaimed Bench session would otherwise print a caveat about nothing on the Squat page,
    // and a caveat that is noise everywhere is read nowhere.
    private var unclaimed: some View {
        Text("Sessions this device hasn’t claimed yet aren’t counted here.")
            .font(GymType.numeral(12))
            .foregroundStyle(skin.inkFaint)
            .lineSpacing(3)
    }

    // Mono, quiet, never a spinner and never an alert — the room's one voice for a door that did not
    // open. The read is offered again rather than retried forever: this page is somewhere a lifter
    // chose to stand, and a poll behind it would spend a basement's signal on a chart.
    private func silence(_ line: String, retry: Bool) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text(line)
                .font(GymType.numeral(13))
                .foregroundStyle(skin.inkFaint)
            if retry {
                Button { Task { await read() } } label: {
                    Text("Try again")
                        .font(WindmillFont.body(16, .semibold))
                        .foregroundStyle(skin.accent)
                        .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                            .strokeBorder(skin.lineStrong, lineWidth: 1))
                }
            }
        }
    }

    // Shaped once, here, and never in the body: a page recomputed on every frame is the trend
    // recomputed on every keystroke elsewhere in the app, which is the banked lesson from Lift.
    private func read() async {
        failure = nil
        switch await store.record(of: exerciseId) {
        case .success(let answered):
            page = Record.page(answered.record, now: Int64(Date().timeIntervalSince1970 * 1000),
                               from: answered.source)
        case .failure(let why):
            failure = why
        }
    }

    // A rename that landed is re-read rather than patched into what is on screen: the log decides
    // what this account calls a movement, and a page that wrote the new name in itself would be
    // stating a fact it only asked for.
    private func rename(to name: String) async -> TrainingStore.WriteFailure? {
        guard let failed = await store.rename(exerciseId, to: name) else {
            renaming = false
            await read()
            return nil
        }
        return failed
    }
}

// THE DOOR ONTO THIS PAGE, drawn once and the same in the three places §H names — a session read
// back, a routine, and Today's card of the next one. A name means the same thing wherever it is
// printed, and a door drawn three ways is three doors.
//
// TWO OTHER SURFACES NAME A MOVEMENT AND ARE NOT DOORS, both on purpose. Inside a LIVE session the
// picker's tap is the pick and the logger's name is the movement in hand, and a live session
// outranks every read-only screen in this room — a door there would either do nothing or walk a
// lifter out of their workout mid-set. And the FINISH screen, whose record sentence, comparison rows
// and keep-as-routine preview all name movements: it outranks `showing` in `GymRoom.stage` for the
// same kind of reason — a workout that just ended owns the screen, and the offer on it dies when it
// leaves — so a door drawn there would open a page nobody could see.
//
// The chevron sits on the NAME rather than at the end of the row, because the other half of these
// rows is a target or a plan line and the door is not onto those.
struct MovementDoor: View {
    let exerciseId: String
    let name: String
    let font: Font
    let ink: Color
    let open: (String) -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        Button { open(exerciseId) } label: {
            HStack(spacing: WindmillSpace.x1) {
                Text(name)
                    .font(font)
                    .foregroundStyle(ink)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(skin.inkFaint)
            }
            .frame(minHeight: GymTap.minimum, alignment: .leading)
        }
        .accessibilityHint("opens this movement’s record")
    }
}

// RENAME — the identity proof, and the only write on this page. The id never moves, so every set,
// routine entry and frozen plan snapshot still points at the same movement: that is the whole reason
// the catalog exists and this is where a lifter gets to see it.
//
// The sheet stays up until the log answers. A rename that did not happen may not close as though it
// had, and the refusal is repeated in the log's own words where it sent any.
private struct RenameSheet: View {
    let save: (String) async -> TrainingStore.WriteFailure?
    let onClose: () -> Void

    @Environment(\.gymSkin) private var skin
    @State private var name: String
    @State private var failure: TrainingStore.WriteFailure?
    @State private var saving = false

    init(current: String, save: @escaping (String) async -> TrainingStore.WriteFailure?,
         onClose: @escaping () -> Void) {
        self.save = save
        self.onClose = onClose
        _name = State(initialValue: current)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            HStack {
                Text("Rename")
                    .font(WindmillFont.display(20))
                    .foregroundStyle(skin.ink)
                Spacer()
                Button("Cancel", action: onClose)
                    .font(WindmillFont.body(16))
                    .foregroundStyle(skin.inkDim)
                    .frame(minHeight: GymTap.minimum)
            }

            TextField("", text: $name, prompt: Text("Movement name").foregroundStyle(skin.inkFaint))
                .font(WindmillFont.body(17))
                .foregroundStyle(skin.ink)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.words)
                .padding(.horizontal, WindmillSpace.x4)
                .frame(height: GymTap.minimum + 4)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.raised))

            Text("Every set, every routine and every past session follows the new name. This stays one movement — the name is only what you call it.")
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)

            if let failure {
                Text(failure.line("the name didn’t change"))
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.alarmInk)
                    .lineSpacing(3)
            }

            // WHITESPACE AND NEWLINES BOTH, and the two must be the same trim. `.whitespaces` is
            // spaces and tabs and NOT `\n`, so a pasted newline passed this guard as a name — and on
            // a movement still on this device's shelf there is no server behind it to state the
            // emptiness rule, which left the room drawing a blank at 28pt. What a name may be is
            // still the log's to say; that it is not blank is a thing this sheet already claimed to
            // check, and it now checks it.
            Button {
                Task {
                    saving = true
                    failure = await save(name.trimmingCharacters(in: .whitespacesAndNewlines))
                    saving = false
                }
            } label: {
                Text(saving ? "Saving…" : "Save name")
                    .font(WindmillFont.body(17, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
            }
            .disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(WindmillSpace.x5)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(skin.surface)
    }
}
