package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Ladder
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// FIX A SET — §G18, over the session read back. The same three controls the logger has, in the same
// order and at the same sizes, because a lifter who has learned one geometry should not have to
// learn a second to repair what it produced. THE LADDER IS THE LOGGER'S OWN (`Ladder`): a second
// copy of the step rule would be a screen where 82.5 and 85 are one tap apart on one surface and two
// on another.
//
// NOTHING HERE PROMISES RECOVERY. There is no trash, no "recoverable for 30 days" and no Settings
// destination — `Delete set` takes the row off the log, and the only way back is the window this
// sheet's caller holds open for a few seconds afterwards. The line beside it is about the program
// and not about the set: fixing what was lifted never moves what the routine asks for next week.
//
// The sheet's own dial is `remember` and not `rememberSaveable`, deliberately: an activity recreated
// mid-edit closes the sheet with nothing sent, so the only thing lost is a number that had not been
// saved — and the alternative, half-restoring an editor over a set the lifter can no longer see, is
// the shape that saves the wrong row.
@Composable
fun FixSheet(
    set: TrainingSet,
    movement: String,
    setNumber: Int,
    routine: String?,
    onSave: (SetFix) -> Unit,
    onDelete: () -> Unit,
) {
    var weightKg by remember(set.id) { mutableDoubleStateOf(set.weightKg) }
    var reps by remember(set.id) { mutableIntStateOf(set.reps) }
    var kind by remember(set.id) { mutableStateOf(set.kind) }

    Column(
        Modifier
            .fillMaxWidth()
            .background(GymSkin.surface)
            .padding(horizontal = WindmillSpace.x4)
            .padding(top = WindmillSpace.x5, bottom = WindmillSpace.x6),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
            Text("Fix this set", style = WindmillFont.display(22), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            // Which set, in the log's own numbering where the log has spoken for it — a delete
            // leaves a gap and the numbers after it do not close up, so the position in the list is
            // only ever the fallback for a session no account has numbered yet.
            Text("$movement · set $setNumber", style = GymType.numeral(11), color = GymSkin.inkFaint)
        }

        Row(
            Modifier.fillMaxWidth().padding(top = WindmillSpace.x2),
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.Bottom,
        ) {
            // A −102.5 is the widest thing this readout ever holds; it shrinks rather than
            // truncating, exactly as the logger's does — half a weight is worse than a small one.
            BasicText(
                Readout.weight(weightKg),
                maxLines = 1,
                autoSize = TextAutoSize.StepBased(minFontSize = 40.sp, maxFontSize = 72.sp),
                style = GymType.weight.copy(
                    fontSize = 72.sp, lineHeight = 66.sp, color = GymSkin.weightInk),
                modifier = Modifier.alignByBaseline(),
            )
            Text("kg", style = WindmillFont.body(18, FontWeight.Bold), color = GymSkin.inkFaint,
                 modifier = Modifier.alignByBaseline())
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Ladder.labels(weightKg).forEachIndexed { index, label ->
                Box(
                    Modifier
                        .weight(1f)
                        .heightIn(min = GymTap.minimum + 6.dp)
                        .clip(RoundedCornerShape(WindmillRadius.md))
                        .background(GymSkin.raised)
                        .border(1.dp, if (index == 0 || index == 3) GymSkin.line else GymSkin.lineStrong,
                                RoundedCornerShape(WindmillRadius.md))
                        .clickable {
                            weightKg = Ladder.bump(weightKg, direction = if (index < 2) -1 else 1,
                                                   big = index == 0 || index == 3)
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    // The fine step is the one a program is written in, so it reads a shade louder
                    // than the plate change either side of it — §G18 draws exactly that.
                    Text(
                        label,
                        style = GymType.numeral(if (index == 0 || index == 3) 15 else 16, FontWeight.SemiBold),
                        color = if (index == 0 || index == 3) GymSkin.inkDim else GymSkin.ink,
                    )
                }
            }
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Reps", style = WindmillFont.body(14), color = GymSkin.inkDim)
            Spacer(Modifier.weight(1f))
            Row(
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // The floor is a CLAMP INTO the range and never a hold at the value, and it is
                // `Ladder`'s rule rather than this screen's: the golden pins one answer per language.
                RepStep("−") { reps = Ladder.bumpReps(reps, direction = -1) }
                Text(reps.toString(), style = GymType.numeral(22, FontWeight.Bold), color = GymSkin.ink,
                     modifier = Modifier.widthIn(min = 42.dp))
                RepStep("+") { reps = Ladder.bumpReps(reps, direction = 1) }
            }
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            SetKind.entries.forEach { entry ->
                val chosen = entry == kind
                Box(
                    Modifier
                        .weight(1f)
                        .heightIn(min = GymTap.minimum)
                        .clip(RoundedCornerShape(WindmillRadius.md))
                        .background(if (chosen) GymSkin.accentSoft else Color.Transparent)
                        .border(1.dp, if (chosen) GymSkin.lineStrong else GymSkin.line,
                                RoundedCornerShape(WindmillRadius.md))
                        .clickable { kind = entry },
                    contentAlignment = Alignment.Center,
                ) {
                    // A warmup is drawn in the ink that says it counts toward nothing, whether or
                    // not it is the one chosen — the segment names a kind, not a state.
                    Text(
                        entry.wire,
                        style = GymType.numeral(12, if (chosen) FontWeight.Bold else FontWeight.SemiBold),
                        color = when {
                            entry == SetKind.Warmup -> GymSkin.warmupInk
                            chosen -> GymSkin.accent
                            else -> GymSkin.inkDim
                        },
                    )
                }
            }
        }

        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(GymSkin.accent)
                .clickable { onSave(SetFix(weightKg = weightKg, reps = reps, kind = kind)) },
            contentAlignment = Alignment.Center,
        ) {
            Text("Save the fix", style = WindmillFont.body(17, FontWeight.Bold), color = GymSkin.onAccent)
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onDelete),
                contentAlignment = Alignment.CenterStart,
            ) {
                // Alarm ink, which in this room means a write that failed — and a delete, which is
                // the one gesture that costs something. It is a word and not a button: the primary
                // action above is where the thumb lands, and this is not on the way to it.
                Text("Delete set", style = WindmillFont.body(14, FontWeight.Bold), color = GymSkin.alarmInk)
            }
            Spacer(Modifier.weight(1f))
            // THE CAPTION OF THE WHOLE SCREEN, said where the destructive gesture is: the log moves
            // and the routine does not. A session nobody planned has no program to reassure anyone
            // about, so the line is absent rather than addressed to a routine that does not exist.
            routine?.let {
                Text("$it keeps its own numbers", style = GymType.numeral(12), color = GymSkin.inkFaint)
            }
        }
    }
}

@Composable
private fun RepStep(glyph: String, onTap: () -> Unit) {
    Box(
        Modifier
            .size(GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.md))
            .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.md))
            .clickable(onClick = onTap),
        contentAlignment = Alignment.Center,
    ) {
        Text(glyph, style = WindmillFont.display(19, FontWeight.SemiBold), color = GymSkin.ink)
    }
}

// The row that stands where a deleted set was, for as long as it can still be taken back. The set
// is named because this is its last copy while the window is open — "47.5 × 4 deleted" is
// unrecoverable without knowing what was in it — and the offer disappears the moment the log is
// told, never as a button that would have to apologise.
@Composable
fun WithheldRow(set: TrainingSet, onUndo: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(GymTap.minimum),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "Deleted ${Readout.effort(set.weightKg, set.reps)}",
            style = GymType.numeral(12),
            color = GymSkin.inkDim,
        )
        Spacer(Modifier.weight(1f))
        Box(
            Modifier.widthIn(min = 60.dp).heightIn(min = GymTap.minimum).clickable(onClick = onUndo),
            contentAlignment = Alignment.CenterEnd,
        ) {
            Text("Undo", style = WindmillFont.body(14, FontWeight.SemiBold), color = GymSkin.accent)
        }
    }
}
