package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.store.Older
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// THE LOG — every finished session, newest first, folded into weeks. It answers the question Today
// cannot: what has the last three months actually looked like.
//
// IT IS NOT A CALENDAR. A month grid answers "which days did I train", which this lifter already
// answers with a program — and there is no adherence percentage anywhere on it, because that is a
// number that scores somebody against a plan they changed on purpose.
//
// A session nobody planned is named by `Readout.noRoutine`, with every other phrase this product
// spells exactly once.

// The fold, with no Compose in it: which week a session fell in, what a row says, and the one rule
// that keeps a divider honest. Weeks are the CLIENT's — they are a presentation fold over the page
// already in hand, and a week endpoint would be a second place in the product deciding what a week
// is. They start Monday, in the zone the lifter trained in: a Sunday-night session belongs to the
// week they lived it in, not to whatever UTC calls it.
object LogFold {
    // Every field is optional exactly where the fact may be missing, and a missing one draws
    // NOTHING — never a dash, never a zero standing in for a read that did not happen.
    data class Row(
        val summary: SessionSummary,
        val title: String,
        val at: String,
        val working: String?,
        val tonnage: String?,
        val estimate: String?,
        val onThisDeviceOnly: Boolean,
        // §G's gold dot: a personal record happened in this workout. The log judges it against
        // itself AS IT IS NOW and not frozen at finish, so a correction that moves a record moves
        // the dot with it — a dot that lied after a fix would be worse than none. A row the log
        // never spoke for draws none, which is an omission and not a denial.
        val record: Boolean,
    )

    data class Week(val label: String, val tonnage: String?, val rows: List<Row>)

    // `complete` is whether the log has been read to its bottom. It exists for one honesty rule:
    // paging is newest-first, so every loaded week is whole EXCEPT possibly the oldest one — half a
    // week's sessions are in hand and the rest are one tap away. That week's divider therefore says
    // nothing about its tonnage until the rest arrives, for the same reason a zero says nothing.
    //
    // An OPEN session is not in the log. It is the workout the lifter is standing in, its numbers
    // change under them, and the logger is where it lives.
    fun weeks(
        sessions: List<SessionSummary>,
        onThisDevice: Set<String>,
        complete: Boolean,
        nowMs: Long,
    ): List<Week> {
        val buckets = sessions
            .filter { !it.session.isOpen }
            .sortedByDescending { it.startedAtMs }
            .groupBy { monday(it.startedAtMs) }
        val oldest = buckets.keys.lastOrNull()
        return buckets.map { (start, sessionsInWeek) ->
            Week(
                label = Readout.weekOf(start),
                // A week whose sum is unknowable prints nothing rather than a total that is quietly
                // short: one session the log sent no tonnage for takes the whole caption with it.
                tonnage = when {
                    start == oldest && !complete -> null
                    sessionsInWeek.any { it.tonnageKg == null } -> null
                    else -> Readout.tonnes(sessionsInWeek.sumOf { it.tonnageKg ?: 0.0 })
                },
                rows = sessionsInWeek.map { summary ->
                    Row(
                        summary = summary,
                        title = summary.plan?.routine ?: Readout.noRoutine,
                        at = Readout.whenLogged(summary.startedAtMs, nowMs),
                        working = summary.workingSetCount?.let(Readout::workingSets),
                        tonnage = summary.tonnageKg?.let(Readout::tonnes),
                        estimate = summary.topE1rm?.let(Readout::estimate),
                        onThisDeviceOnly = summary.id in onThisDevice,
                        record = summary.record,
                    )
                },
            )
        }
    }

    private fun monday(ms: Long): Long {
        val zone = ZoneId.systemDefault()
        val date = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        val monday = date.minusDays(((date.dayOfWeek.value + 6) % 7).toLong())
        return monday.atStartOfDay(zone).toInstant().toEpochMilli()
    }
}

@Composable
fun LogScreen(store: TrainingStore, onOpenSession: (SessionSummary) -> Unit) {
    val scope = rememberCoroutineScope()
    val nowMs = System.currentTimeMillis()
    // A row the shelf holds is saved on this device and nowhere else — signed out that is the whole
    // log, and it is true rather than a warning: the lifter owns it, and the claim card on Today is
    // where signing in is offered.
    val onThisDevice = store.shelved.map { it.id }.toSet()
    val weeks = LogFold.weeks(store.recent, onThisDevice, complete = store.older == Older.End, nowMs = nowMs)
    val load: () -> Unit = { scope.launch { store.loadOlder() } }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(top = WindmillSpace.x10, bottom = WindmillSpace.x8),
    ) {
        Text("The log", style = WindmillFont.display(32), color = GymSkin.ink)
        headLine(weeks, store.older)?.let {
            Text(
                it,
                style = GymType.numeral(13),
                color = GymSkin.inkFaint,
                modifier = Modifier.padding(top = WindmillSpace.x1),
            )
        }

        // THREE DIFFERENT SILENCES, and only one of them is "you have no sessions". The log said so;
        // the log failed, which is the foot's own sentence and gets no rows above it; or the log has
        // not answered yet, and this screen claims nothing at all — a boot that drew "No sessions
        // yet" over an account with two hundred of them would be the worst sentence in the product.
        if (weeks.isEmpty()) {
            when (store.older) {
                Older.End -> Empty()
                Older.Failed -> LogFoot(Older.Failed, first = null, onLoad = load)
                else -> Unit
            }
            return@Column
        }

        weeks.forEach { week ->
            WeekDivider(week)
            Column(
                verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                modifier = Modifier.padding(bottom = WindmillSpace.x2),
            ) {
                week.rows.forEach { row -> SessionRow(row, onOpen = { onOpenSession(row.summary) }) }
            }
        }

        LogFoot(
            older = store.older,
            first = weeks.lastOrNull()?.rows?.lastOrNull()?.summary,
            onLoad = load,
        )
    }
}

@Composable
private fun WeekDivider(week: LogFold.Week) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = WindmillSpace.x4, bottom = WindmillSpace.x2),
    ) {
        // Upper case and tracked out, which is the divider's own treatment in §G16 and the one place
        // this room uses it: it has to read as a rule across the list rather than as a row in it.
        Text(
            week.label.uppercase(),
            style = GymType.numeral(11).copy(letterSpacing = 0.07.em),
            color = GymSkin.inkFaint,
        )
        Box(
            Modifier
                .weight(1f)
                .height(1.dp)
                .background(GymSkin.line),
        )
        week.tonnage?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkDim) }
    }
}

// FOUR FACTS AND NO FIFTH: what it was, when it was, how much working there was in it, and the
// heaviest thing that happened. The tonnage and the estimate are each drawn only where there is one
// — a bodyweight session moved no external load, and a session claimed by no account has no e1RM
// because no phone computes one.
//
// Beside the title, one gold dot on the ~ten rows in two hundred that hold a personal record. It is
// the log's own verdict, replayed against the log as it stands now, which is why nothing on this
// phone tries to compute one: a cheaper dot that is sometimes wrong is worse than no dot at all.
//
// THE DOT IS THE WHOLE CLAIM AND THE NUMBERS UNDER IT STAY IRON, which is where this row differs
// from the design's mock. `record` is one bool over THREE rules — best e1RM, most reps at a weight,
// heaviest load for any reps — and the wire does not say which one was earned. Colouring the
// estimate gold would read as "this figure is the record", and it is that for only one of the
// three: a session that beat its own reps at 100 kg can carry a top e1RM well under the standing
// one. §G asks for a dot meaning "a PR happened in there", which is exactly what a dot says and no
// more. iOS says it the same way. If the row is ever to point at the number, the kind has to ride
// on the wire first.
@Composable
private fun SessionRow(row: LogFold.Row, onOpen: () -> Unit) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .clickable(onClick = onOpen)
            .padding(horizontal = WindmillSpace.x4, vertical = WindmillSpace.x3),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(row.title, style = WindmillFont.body(15, FontWeight.Bold), color = GymSkin.ink)
            // Filled, because a record is a thing that happened. It shares the slot the hollow ring
            // uses and cannot collide with it: an unclaimed row is one no account has judged, so it
            // never carries a verdict.
            if (row.record) {
                Box(
                    Modifier
                        .size(7.dp)
                        .background(GymSkin.prInk, CircleShape),
                )
            }
            // Hollow, because the session is real and only its second home is missing.
            if (row.onThisDeviceOnly) {
                Box(
                    Modifier
                        .size(7.dp)
                        .border(1.5.dp, GymSkin.unsyncedInk, CircleShape),
                )
            }
            Spacer(Modifier.weight(1f))
            Text(row.at, style = GymType.numeral(12), color = GymSkin.inkFaint)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
            row.working?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkDim) }
            row.tonnage?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkDim) }
            row.estimate?.let { Text(it, style = GymType.numeral(12), color = GymSkin.inkDim) }
        }
    }
}

// THE FOOT, in the order a scroll meets it. `Load older` is a tap and never an infinite scroll,
// because twelve weeks back is a destination and a scroll that keeps going has no arrival. Loading
// is the same box dimmed — no spinner, and no skeleton rows pretending to be sessions somebody did
// not lift. The bottom is a DATE rather than an empty box: it is the one fact worth arriving at.
// And alarm ink fires here on a failed read and on nothing else.
@Composable
private fun LogFoot(older: Older, first: SessionSummary?, onLoad: () -> Unit) {
    if (older == Older.End) {
        if (first == null) return
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .padding(top = WindmillSpace.x3),
        ) {
            Text(
                "first session · ${Readout.date(first.startedAtMs)}",
                style = GymType.numeral(12),
                color = GymSkin.inkFaint,
            )
        }
        return
    }
    if (older == Older.Failed) {
        FootBox("That read failed · retry", GymSkin.alarmInk, GymSkin.alarmInk, onLoad)
        return
    }
    if (older == Older.Loading) {
        // The same box one shade quieter, and a dot rather than a spinner: nothing in this room
        // animates to say it is waiting, it says it.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .padding(top = WindmillSpace.x3)
                .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
                .padding(horizontal = WindmillSpace.x4),
        ) {
            Spacer(Modifier.weight(1f))
            Box(
                Modifier
                    .size(7.dp)
                    .background(GymSkin.inkFaint, CircleShape),
            )
            Text("Loading", style = WindmillFont.body(15, FontWeight.SemiBold), color = GymSkin.inkFaint)
            Spacer(Modifier.weight(1f))
        }
        return
    }
    FootBox("Load older", GymSkin.inkDim, GymSkin.lineStrong, onLoad)
}

@Composable
private fun FootBox(label: String, ink: Color, line: Color, onTap: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .padding(top = WindmillSpace.x3)
            .border(1.dp, line, RoundedCornerShape(WindmillRadius.lg))
            .clickable(onClick = onTap),
    ) {
        Text(label, style = WindmillFont.body(15, FontWeight.SemiBold), color = ink)
    }
}

@Composable
private fun Empty() {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1),
        modifier = Modifier.padding(top = WindmillSpace.x6),
    ) {
        Text("No sessions yet.", style = WindmillFont.body(16), color = GymSkin.inkDim)
        Text(
            "The first one you log lands here, newest first.",
            style = WindmillFont.body(15),
            color = GymSkin.inkFaint,
        )
    }
}

// Both halves are counts of what is IN HAND, which is the work the word at the end of the line is
// doing. The log has no total to ask for — the wire answers pages — and a number claiming to be the
// whole account's would be a number nobody read. With nothing in hand there is no count to state:
// the sentence under the title is either the read still running or nothing at all.
private fun headLine(weeks: List<LogFold.Week>, older: Older): String? {
    if (weeks.isEmpty()) {
        if (older == Older.End || older == Older.Failed) return null
        return "opening the log…"
    }
    val sessions = Readout.sessionCount(weeks.sumOf { it.rows.size })
    if (weeks.size == 1) return "$sessions · 1 week loaded"
    return "$sessions · ${weeks.size} weeks loaded"
}
