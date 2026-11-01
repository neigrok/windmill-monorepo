package works.windmill.gym.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import works.windmill.gym.R
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.Session
import works.windmill.platform.design.WindmillFont

@Composable
fun WorkoutBar(session: Session, onOpen: () -> Unit) {
    val skin = LocalGymColors.current
    val routine = session.plan?.routine ?: Readout.noRoutine
    var nowMs by remember(session.id) { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(session.id) {
        while (true) {
            nowMs = System.currentTimeMillis()
            delay(1_000)
        }
    }
    Surface(onClick = onOpen, color = skin.surface, modifier = Modifier.fillMaxWidth()
        .drawWithContent { drawContent(); drawLine(skin.line, Offset(0f, 0.5.dp.toPx()), Offset(size.width, 0.5.dp.toPx()), 1.dp.toPx()) }
        .clearAndSetSemantics {
            contentDescription = "$routine, in progress"
            role = Role.Button
            onClick { onOpen(); true }
        }) {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 16.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(painterResource(R.drawable.gym_workout_notification), null, Modifier.size(24.dp), tint = skin.accent)
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                Text(routine, style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Text(" · ${Readout.clock(nowMs - session.startedAtMs)}", style = GymType.numeral(14), color = skin.inkDim,
                    maxLines = 1)
            }
            Icon(Icons.Rounded.KeyboardArrowUp, null, Modifier.size(48.dp).padding(12.dp), tint = skin.inkDim)
        }
    }
}
