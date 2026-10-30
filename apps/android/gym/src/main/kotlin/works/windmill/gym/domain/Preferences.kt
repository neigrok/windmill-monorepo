package works.windmill.gym.domain

import kotlinx.serialization.Serializable

@Serializable
data class GymPreferences(
    val confirmHaptic: Boolean = true,
    val confirmSound: Boolean = false,
)
