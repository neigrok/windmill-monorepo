package works.windmill.gym.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.sharing.WorkoutShareActions
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.FinishOutcome
import works.windmill.platform.design.LocalWindmillDark

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SessionScreenPaintTests {
    private lateinit var contentView: View
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    // The four pixels 2 dp in from a row's corners: inside a 4 dp corner they are the row's own surface, and outside a
    // 12 dp corner they are the canvas the group sits on.
    private fun corners(row: Rect): List<Color> = compose.runOnIdle {
        val pixels = Bitmap.createBitmap(contentView.width, contentView.height, Bitmap.Config.ARGB_8888)
        contentView.draw(Canvas(pixels))
        val left = row.left.toInt() + 4
        val right = row.right.toInt() - 5
        val top = row.top.toInt() + 4
        val bottom = row.bottom.toInt() - 5
        listOf(left to top, right to top, left to bottom, right to bottom).map { (x, y) -> Color(pixels.getPixel(x, y)) }
    }

    @Test
    fun aMovementsSetsAreOneGroupRoundedOnlyAtItsOuterCorners() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            room.now = System.currentTimeMillis() - 60_000
            val server = EngineRoomFixture.server()
            runBlocking {
                room.select("u1")
                room.pull(server)
                room.startExternalWorkout()
                room.store.choose("bench-press")
                room.store.logSet(weightKg = 75.0, reps = 8)
                room.store.logSet(weightKg = 75.0, reps = 6)
                room.store.logSet(weightKg = 80.0, reps = 8)
                room.store.choose("overhead-press")
                room.store.logSet(weightKg = 47.5, reps = 6)
                room.now += 60_000
                assertTrue(room.store.finish() is FinishOutcome.Closed)
                room.sync(server)
                room.store.refreshEngine()
            }
            room.store.observeEngine()
            val summary = room.store.recent.single()
            var dark by mutableStateOf(true)
            compose.setContent {
                contentView = LocalView.current
                CompositionLocalProvider(LocalWindmillDark provides dark) {
                    GymMaterial {
                        SessionScreen(summary = summary, store = room.store,
                            sharing = WorkoutShareActions("https://windmill.works", { error("no link is minted here") },
                                { error("no link is revoked here") }),
                            backTo = "The log", onBack = {}, say = {}, onOpenMovement = {}, onDiscard = {})
                    }
                }
            }
            val rows = listOf("Set 1, 75 kg total, 8 reps", "Set 2, 75 kg total, 6 reps", "Set 3, 80 kg total, 8 reps",
                "Set 1, 47.5 kg total, 6 reps")
            for (skin in listOf(GymSkin.Instrument, GymSkin.Daylight)) {
                compose.runOnIdle { dark = skin == GymSkin.Instrument }
                val (canvas, row) = skin.canvas to skin.surface
                val painted = rows.map { spoken -> corners(compose.onNodeWithContentDescription(spoken).fetchSemanticsNode().boundsInRoot) }
                assertEquals(listOf(
                    listOf(canvas, canvas, row, row),
                    listOf(row, row, row, row),
                    listOf(row, row, canvas, canvas),
                    listOf(canvas, canvas, canvas, canvas),
                ).map { corner -> corner.map(Color::toArgb) }, painted.map { corner -> corner.map(Color::toArgb) })
            }
        } } finally { scope.cancel() }
    }
}
