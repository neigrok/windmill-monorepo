package works.windmill.gym.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.compose.ui.platform.LocalView

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.store.Deletion
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.store.DeviceCopy
import works.windmill.gym.store.LocalBodyweight
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.LocalPreferences
import works.windmill.gym.store.SetQueue
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.Account
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.net.WindmillApi

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PlanningSwipePaintTests {
    private lateinit var contentView: View
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private fun store(scope: CoroutineScope): TrainingStore {
        val store = TrainingStore(
            queue = SetQueue(File(tmp.root, "queue.json")),
            deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
            localLog = LocalLog(File(tmp.root, "local.json")),
            localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
            localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
            scope = scope, sync = { null },
        )
        runBlocking { store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), null)) }
        return store
    }

    private fun assertPixel(point: Offset, expected: Color) {
        compose.runOnIdle {
            val pixels = Bitmap.createBitmap(contentView.width, contentView.height, Bitmap.Config.ARGB_8888)
            contentView.draw(Canvas(pixels))
            val actual = pixels.getPixel(point.x.toInt(), point.y.toInt())
            for (channel in listOf(24, 16, 8, 0)) {
                assertEquals("pixel channel $channel", ((expected.toArgb() ushr channel) and 255).toDouble(),
                    ((actual ushr channel) and 255).toDouble(), 1.0)
            }
        }
    }

    @Test
    fun routineRowsCoverDeleteAtRestRevealItDuringSwipeAndCoverItAgainAfterUndo() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope)
        runBlocking { store.saveRoutine(RoutineDraft(name = "Push Day").adding("bench-press")) }
        var dark by mutableStateOf(true)
        compose.setContent {
            contentView = LocalView.current
            CompositionLocalProvider(LocalWindmillDark provides dark) {
                GymMaterial {
                    RoutinesScreen(store, true, emptySet(), "S", {}, {}, {},
                        { store.withhold(Deletion.Routine(it, "Push Day")) }, {}, {}, {})
                }
            }
        }
        for (skin in listOf(GymSkin.Instrument, GymSkin.Daylight)) {
            compose.runOnIdle { dark = skin == GymSkin.Instrument }
            val row = compose.onNode(hasText("Push Day") and hasClickAction())
            val bounds = row.fetchSemanticsNode().boundsInRoot
            val point = Offset(bounds.right - 48f, bounds.top + 28f)
            assertPixel(point, skin.canvas)
            row.performTouchInput {
                down(center)
                moveBy(Offset(-96f, 0f), delayMillis = 300)
            }
            assertPixel(point, skin.alarmInk.copy(alpha = 0.18f).compositeOver(skin.canvas))
            row.performTouchInput { cancel() }
            compose.waitForIdle()
            assertPixel(point, skin.canvas)
            row.performTouchInput { swipeLeft() }
            row.assertDoesNotExist()
            compose.runOnIdle { assertEquals(store.allRoutines.single().id, store.keepWithheld()?.subjectId) }
            row.assertIsDisplayed()
            assertPixel(point, skin.canvas)
        }
        scope.cancel()
    }

    @Test
    fun editorRowsKeepTheirOpaqueCanvasWhileTheDeleteLaneRemainsReachable() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val store = store(scope)
        var draft by mutableStateOf(RoutineDraft(name = "Push Day").adding("bench-press"))
        compose.setContent {
            contentView = LocalView.current
            GymMaterial { RoutineBuilder(draft, store, false, { draft = it }, {}, {}, {}) }
        }
        val row = compose.onNode(hasText("Bench Press") and hasClickAction())
        val bounds = row.fetchSemanticsNode().boundsInRoot
        val point = Offset(bounds.right - 48f, bounds.top + 28f)
        assertPixel(point, GymSkin.Instrument.canvas)
        row.performTouchInput {
            down(center)
            moveBy(Offset(-96f, 0f), delayMillis = 300)
        }
        assertPixel(point, GymSkin.Instrument.alarmInk.copy(alpha = 0.18f).compositeOver(GymSkin.Instrument.canvas))
        row.performTouchInput { cancel() }
        compose.waitForIdle()
        assertPixel(point, GymSkin.Instrument.canvas)
        row.performTouchInput { swipeLeft() }
        row.assertDoesNotExist()
        assertEquals(emptyList<works.windmill.gym.domain.RoutineEntry>(), draft.entries)
        scope.cancel()
    }
}
