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

// The dial is `remember` and not `rememberSaveable`: a recreation closes the sheet with nothing sent.
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
            // The log's own numbering where it has spoken — a delete leaves a gap — and the list
            // position is only the fallback.
            Text("$movement · set $setNumber", style = GymType.numeral(11), color = GymSkin.inkFaint)
        }

        Row(
            Modifier.fillMaxWidth().padding(top = WindmillSpace.x2),
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.Bottom,
        ) {
            // −102.5 is the widest this readout holds; it shrinks rather than truncating.
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
                Text("Delete set", style = WindmillFont.body(14, FontWeight.Bold), color = GymSkin.alarmInk)
            }
            Spacer(Modifier.weight(1f))
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
