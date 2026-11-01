package works.windmill.gym.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import works.windmill.gym.R

@Composable
fun EquipmentIcon(
    equipment: String,
    modifier: Modifier = Modifier,
    tint: Color = MaterialTheme.colorScheme.onSurface,
) {
    val resource = when (equipment) {
        "barbell" -> R.drawable.gym_equipment_barbell
        "dumbbell" -> R.drawable.gym_equipment_dumbbells
        "bodyweight" -> R.drawable.gym_equipment_bodyweight
        "machine" -> R.drawable.gym_equipment_machine
        else -> return
    }
    Icon(painterResource(resource), contentDescription = null, modifier = modifier.size(24.dp), tint = tint)
}
