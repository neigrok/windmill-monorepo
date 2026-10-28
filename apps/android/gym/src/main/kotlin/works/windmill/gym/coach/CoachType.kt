package works.windmill.gym.coach

import androidx.compose.ui.text.font.FontWeight
import works.windmill.gym.ui.GymNativeType
import works.windmill.platform.design.WindmillFont

internal object CoachType {
    fun body(size: Int, weight: FontWeight = FontWeight.Normal) =
        WindmillFont.body(size, weight).copy(fontFamily = GymNativeType.sans)
}
