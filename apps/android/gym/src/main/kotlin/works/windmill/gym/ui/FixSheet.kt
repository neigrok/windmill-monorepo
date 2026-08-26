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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
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
import androidx.compose.ui.semantics.Role
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
    // The rack's own pad, raised from the numeral it corrects. It takes the whole sheet rather than
    // opening a second one over it: a modal over a modal is a layer the phone does not need, and the
    // pad is a whole answer to the same question the sheet is asking.
    var typing by remember(set.id) { mutableStateOf<KeypadEntry.Mode?>(null) }

    val pad = typing
    if (pad != null) {
        KeypadSheet(
            mode = pad,
            current = if (pad == KeypadEntry.Mode.Weight) weightKg else reps.toDouble(),
            onCommit = {
                if (pad == KeypadEntry.Mode.Weight) weightKg = it else reps = it.toInt()
                typing = null
            },
            onCancel = { typing = null },
        )
        return
    }

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
            // −102.5 is the widest this readout holds; it shrinks rather than truncating. Tapping it
            // raises the pad, exactly as the logger's numeral does — a correction is one-handed too.
            BasicText(
                Readout.weight(weightKg),
                maxLines = 1,
                autoSize = TextAutoSize.StepBased(minFontSize = 40.sp, maxFontSize = 72.sp),
                style = GymType.weight.copy(
                    fontSize = 72.sp, lineHeight = 66.sp, color = GymSkin.weightInk),
                modifier = Modifier
                    .alignByBaseline()
                    .clickable(role = Role.Button, onClickLabel = "type a weight") {
                        typing = KeypadEntry.Mode.Weight
                    },
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
                        .clickable(role = Role.Button, onClickLabel = "change the weight by $label") {
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
                RepStep("−", "one rep fewer") { reps = Ladder.bumpReps(reps, direction = -1) }
                Box(
                    Modifier
                        .sizeIn(minWidth = 42.dp, minHeight = GymTap.minimum)
                        .clickable(role = Role.Button, onClickLabel = "type the reps") {
                            typing = KeypadEntry.Mode.Reps
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(reps.toString(), style = GymType.numeral(22, FontWeight.Bold), color = GymSkin.ink)
                }
                RepStep("+", "one rep more") { reps = Ladder.bumpReps(reps, direction = 1) }
            }
        }

        GymSegmented(
            options = SetKind.entries.map { it to it.wire },
            picked = kind,
            onPick = { kind = it },
        )

        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(GymSkin.accent)
                .clickable(role = Role.Button) {
                    onSave(SetFix(weightKg = weightKg, reps = reps, kind = kind))
                },
            contentAlignment = Alignment.Center,
        ) {
            Text("Save the fix", style = WindmillFont.body(17, FontWeight.Bold), color = GymSkin.onAccent)
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.heightIn(min = GymTap.minimum).clickable(role = Role.Button, onClick = onDelete),
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
private fun RepStep(glyph: String, said: String, onTap: () -> Unit) {
    Box(
        Modifier
            .size(GymTap.minimum)
            .clip(RoundedCornerShape(WindmillRadius.md))
            .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.md))
            .clickable(role = Role.Button, onClickLabel = said, onClick = onTap),
        contentAlignment = Alignment.Center,
    ) {
        Text(glyph, style = WindmillFont.display(19, FontWeight.SemiBold), color = GymSkin.ink)
    }
}
