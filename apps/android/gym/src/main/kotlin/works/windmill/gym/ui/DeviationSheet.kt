package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.DeviationOffer
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

@Composable
fun DeviationSheet(
    deviation: DeviationOffer,
    movement: String,
    onSave: () -> Unit,
    onToday: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(GymSkin.surface)
            .padding(WindmillSpace.x5),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
    ) {
        Text("Heavier than the plan", style = WindmillFont.display(22), color = GymSkin.ink)

        Text(
            deviation.sentence(movement),
            style = WindmillFont.body(16),
            color = GymSkin.inkDim,
            lineHeight = 25.sp,
        )

        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary)
                .clip(RoundedCornerShape(WindmillRadius.lg))
                .background(GymSkin.accent)
                .clickable(onClick = onSave),
            contentAlignment = Alignment.Center,
        ) {
            Text(deviation.saveLabel, style = WindmillFont.body(17, FontWeight.Bold), color = GymSkin.onAccent)
        }

        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum + 6.dp)
                .clickable(onClick = onToday),
            contentAlignment = Alignment.Center,
        ) {
            Text("Today only", style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.inkDim)
        }
    }
}
