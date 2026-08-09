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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import works.windmill.gym.domain.LiveLines
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// THIS SESSION, as a list — the only thing in the logger that moves the lifter between movements.
// Nothing advances on its own: not when a plan's set count is reached, not when a rest lands. The
// sheet says where everything stands and the choice stays theirs.
//
// The last row is the assembly surface the design is built on (screen 2): a movement appended here,
// on the bench, mid-rest, is how a routine gets written in this product — not in an editor, before
// the first set, standing up.
@Composable
fun JumpSheet(
    rows: List<LiveLines.JumpRow>,
    onJump: (String) -> Unit,
    onAdd: () -> Unit,
    onClose: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(GymSkin.surface)
            .padding(WindmillSpace.x5),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("This session", style = WindmillFont.display(20), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            Box(
                Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Text("Close", style = WindmillFont.body(16), color = GymSkin.inkDim)
            }
        }

        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = 380.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            rows.forEach { row ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = GymTap.minimum + 10.dp)
                        .clickable { onJump(row.id) },
                    verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically),
                ) {
                    Text(
                        row.name,
                        style = WindmillFont.body(17, if (row.isCurrent) FontWeight.SemiBold else FontWeight.Normal),
                        color = if (row.isCurrent) GymSkin.accent else GymSkin.ink,
                    )
                    Text(row.meta, style = GymType.numeral(12), color = GymSkin.inkFaint)
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(GymSkin.line))
            }
        }

        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary - 8.dp)
                .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.md))
                .clickable(onClick = onAdd),
            contentAlignment = Alignment.Center,
        ) {
            Text("+ Add next movement", style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.accent)
        }
    }
}
