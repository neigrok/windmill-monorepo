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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.Record
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

@Composable
fun RenameSheet(
    title: String,
    from: String,
    value: String,
    proof: List<Record.Proof>,
    refused: String?,
    onValue: (String) -> Unit,
    onCancel: () -> Unit,
    onRename: () -> Unit,
) {
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val changed = Program.renamed(from, value) != null

    LaunchedEffect(Unit) {
        focus.requestFocus()
        keyboard?.show()
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(GymSkin.surface)
            .imePadding()
            .padding(WindmillSpace.x5),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
    ) {
        Text(title, style = WindmillFont.display(22), color = GymSkin.ink)

        Row(verticalAlignment = Alignment.CenterVertically) {
            BasicTextField(
                value = value,
                onValueChange = { onValue(Program.capped(it)) },
                singleLine = true,
                textStyle = WindmillFont.body(19).copy(color = GymSkin.ink),
                cursorBrush = SolidColor(GymSkin.accent),
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = GymTap.minimum)
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(GymSkin.raised)
                    .focusRequester(focus)
                    .padding(horizontal = WindmillSpace.x3, vertical = WindmillSpace.x2),
            )
            Text(
                Program.counter(value),
                style = GymType.numeral(12),
                color = GymSkin.inkFaint,
                modifier = Modifier.padding(start = WindmillSpace.x3),
            )
        }

        refused?.let { Text(it, style = GymType.numeral(12), color = GymSkin.alarmInk) }

        if (proof.isNotEmpty()) ProofBlock(proof)

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(if (changed) GymSkin.accent else GymSkin.raised)
                .clickable(enabled = changed, onClick = onRename),
        ) {
            Text(
                "Rename",
                style = WindmillFont.body(17, FontWeight.Bold),
                color = if (changed) GymSkin.onAccent else GymSkin.inkFaint,
            )
        }

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum + 6.dp)
                .clickable(onClick = onCancel),
        ) {
            Text("Cancel", style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.inkDim)
        }
    }
}

@Composable
private fun ProofBlock(proof: List<Record.Proof>) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.raised, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        ) {
            Text("✓", style = GymType.numeral(13, FontWeight.Bold), color = GymSkin.setDone)
            Text(
                "Everything follows the name",
                style = WindmillFont.body(14, FontWeight.SemiBold),
                color = GymSkin.ink,
            )
        }
        proof.forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3)) {
                Text(
                    row.label,
                    style = GymType.numeral(11).copy(letterSpacing = 0.07.em),
                    color = GymSkin.inkFaint,
                    modifier = Modifier.width(72.dp),
                )
                Text(row.value, style = GymType.numeral(12), color = GymSkin.inkDim)
                Spacer(Modifier.weight(1f))
            }
        }
    }
}
