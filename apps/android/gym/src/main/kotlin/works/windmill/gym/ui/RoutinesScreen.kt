package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Routine
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// ROUTINES — the written-down days of the program, and the third of the room's three tabs (§F). It
// is a list and a way in: a routine, what it asks for, and a tap that starts the one you are
// looking at.
//
// IT DRAWS NO EDITOR, NO `New` AND NO DUPLICATE, and that is a fact about this surface rather than a
// gap in this screen. Canon screen 5 gives all three a row action, and every one of them WRITES a
// routine — which is the web's half of the split (gym ARCHITECTURE.md §11: the phone owns the open
// session, the web owns the desk work). A control that opened nothing would be the defect this room
// refuses everywhere else. The two ways a routine is written from a phone both already exist, and
// both are at the moment they make sense: "Keep this as a routine" at the finish, and the change
// offer mid-session.
//
// The order is the log's own — trained most recently first, the same order the server sends
// (`ORDER BY last_trained_ms DESC NULLS LAST`) — so the footer line is a statement about this list
// and never a wish. It is restated here because the device's own unclaimed routines arrive after
// the server's and would otherwise sit at the bottom whatever their last session was.
@Composable
fun RoutinesScreen(store: TrainingStore, onStart: (String) -> Unit, onOpenMovement: (String) -> Unit) {
    val nowMs = System.currentTimeMillis()
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = WindmillSpace.x5)
            .padding(top = WindmillSpace.x10, bottom = WindmillSpace.x8),
    ) {
        Text("Routines", style = WindmillFont.display(32), color = GymSkin.ink)

        // The same sentence Today's empty state makes, because it is the same fact: this lifter
        // already has a program, and the app's job is to CATCH it rather than to make them type it
        // in first.
        if (store.routines.isEmpty()) {
            Text(
                "Nothing written down yet. Log a session and name it at the end — that is how a routine gets made here.",
                style = WindmillFont.body(16).copy(lineHeight = 24.sp),
                color = GymSkin.inkDim,
                modifier = Modifier.padding(top = WindmillSpace.x2),
            )
            return@Column
        }

        store.routines
            .sortedByDescending { it.lastTrainedAtMs ?: Long.MIN_VALUE }
            .forEach { routine -> RoutineTile(routine, store, nowMs, onStart, onOpenMovement) }

        Text(
            "Sorted by last trained, not by when you made them.",
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkFaint,
            modifier = Modifier.padding(top = WindmillSpace.x2),
        )
    }
}

// The tile starts the routine and each of its lines opens that movement's record (§H) — two
// meanings on one card, and the inner one wins where it is drawn, which is the whole line the
// movement's name sits on. The cost of confusing them is asymmetric and that is why they can
// share: a tap meant for Start that lands on a name opens a read-only page one chevron from here,
// where the reverse would be a workout somebody did not ask for.
@Composable
private fun RoutineTile(
    routine: Routine,
    store: TrainingStore,
    nowMs: Long,
    onStart: (String) -> Unit,
    onOpenMovement: (String) -> Unit,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum)
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .clickable { onStart(routine.id) }
            .padding(WindmillSpace.x4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(routine.name, style = WindmillFont.body(17, FontWeight.Bold), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            Text(Readout.routineLine(routine, nowMs), style = GymType.numeral(11), color = GymSkin.inkFaint)
        }
        routine.entries.sortedBy { it.position }.forEach { entry ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum)
                    .clickable { onOpenMovement(entry.exerciseId) },
            ) {
                Text(
                    Readout.movement(entry.exerciseId, store.catalog),
                    style = WindmillFont.body(14),
                    color = GymSkin.inkDim,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    Readout.target(entry.targetSets, entry.targetReps, entry.targetWeightKg),
                    style = GymType.numeral(12),
                    color = GymSkin.targetInk,
                )
            }
        }
    }
}
