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

// RENAMING (§N) — one sheet, and it is one sheet on purpose: a movement renames from its record page
// (screen 32) and a routine renames from its own header (screen 30), and building the field twice is
// how the two would start disagreeing about a name.
//
// A NAME IS A LABEL ON A STABLE ID. Renaming is not destructive and never forks a record: every set,
// every routine line and every frozen plan snapshot still points at the same movement afterwards,
// because none of them stores a name. The block below is that promise with the numbers behind it, and
// every one of those numbers is a READ — a constant on the one screen whose whole job is proof would
// be the product asserting something it did not check.
//
// A ROUTINE'S RENAME CARRIES NO BLOCK, and that is not an omission. The counts a movement can show
// are counts of training; a routine renamed has nothing of the kind to show, and inventing
// `12 sessions · unchanged` for it would be exactly the constant this sheet exists to refuse.
//
// `from` IS WHAT THE THING IS CALLED NOW, and the button is dead until the field disagrees with it.
// A rename that changes nothing is not a cheap write on a routine: it is a whole-document PUT, so it
// moves the revision and supersedes the proposal that was waiting on that day — a lifter who opened
// this sheet, thought better of it and tapped the accent word would have paid an agent's diff for it.
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

    // The keyboard is up on arrival for the reason it is up on screen 28: there is exactly one thing
    // to do here, and a sheet that made a lifter tap the field first would be asking them to find
    // the question.
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

        // A rename that did not land is said where the field is, in alarm ink — which fires on a
        // write that failed and on nothing else in this room.
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

// `✓ Everything follows the name`, and then the reads that make it true. Each row is a label and a
// fact, and a row with nothing behind it was already dropped by the domain — so what is drawn here
// is exactly what this account's log could answer.
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
