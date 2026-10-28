package works.windmill.gym.ui

import android.text.InputType
import android.view.inputmethod.EditorInfo
import androidx.compose.runtime.*
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.*
import works.windmill.gym.store.EngineRoomFixture

@OptIn(ExperimentalComposeUiApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class TargetSheetSignKeyTests {
    @get:Rule val compose = createComposeRule()
    @get:Rule val tmp = TemporaryFolder()

    private fun editor(room: EngineRoomFixture, opening: RoutineDraft, movement: String,
        inputs: MutableList<Int>? = null): () -> RoutineDraft {
        runBlocking { room.select(null) }
        var draft by mutableStateOf(opening)
        compose.setContent {
            GymMaterial {
                InterceptPlatformTextInput({ request, _ ->
                    val info = EditorInfo()
                    request.createInputConnection(info)
                    inputs?.add(info.inputType)
                    awaitCancellation()
                }) { RoutineBuilder(draft, room.store, false, { draft = it }, {}, {}, {}) }
            }
        }
        compose.onNodeWithText(movement).performClick()
        return { draft }
    }

    private fun noSignKey() {
        compose.onAllNodesWithContentDescription(bandAssistedSignDescription).assertCountEquals(0)
        compose.onAllNodesWithText("±").assertCountEquals(0)
    }

    @Test fun nativeSignedUniformEntryStagesEverySetAndPreservesLegacyEquipment() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, RoutineDraft(name = "Pull").adding("chin-up")
                .targeting("chin-up", List(3) { SetTarget(8, 20.0) }), "Chin Up")
            noSignKey()
            compose.onNodeWithContentDescription("Load, kg added").performTextReplacement("-12.5")
            compose.onNodeWithText("Done").performClick()
            assertEquals(List(3) { SetTarget(8, -12.5) }, draft().entry("chin-up")!!.sets)
            assertEquals("bodyweight", draft().movements.single().base!!.equipment)
            assertEquals("bodyweight", draft().movements.single().current.equipment)
            assertEquals(emptyList<works.windmill.gym.domain.Routine>(), room.training.program())
        } } finally { scope.cancel() }
    }

    @Test fun aBarbellFormAlsoHasNoSeparateSignControl() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            editor(room, RoutineDraft(name = "Push").adding("bench-press")
                .targeting("bench-press", List(3) { SetTarget(8, 60.0) }), "Bench Press")
            noSignKey()
            compose.onNodeWithContentDescription("Load, kg total").assertExists()
            compose.onNodeWithText("Vary by set").performScrollTo().performClick()
            noSignKey()
            compose.onNodeWithContentDescription("Set 3 load").assertExists()
        } } finally { scope.cancel() }
    }

    @Test fun aNativeMinusAndCommaInOneRowLeaveTheOtherRowsUnchanged() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, RoutineDraft(name = "Pull").adding("chin-up")
                .targeting("chin-up", listOf(SetTarget(8, -10.0), SetTarget(6, -5.0))), "Chin Up")
            noSignKey()
            compose.onNodeWithContentDescription("Set 2 load").performTextReplacement("−7,5")
            compose.onNodeWithText("Done").performClick()
            assertEquals(listOf(SetTarget(8, -10.0), SetTarget(6, -7.5)), draft().entry("chin-up")!!.sets)
        } } finally { scope.cancel() }
    }

    @Test fun uniformAndPerSetLoadConnectionsBothRequestTheNativeSignedDecimalKeyboard() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val inputs = mutableListOf<Int>()
            editor(room, RoutineDraft(name = "Pull").adding("chin-up")
                .targeting("chin-up", List(3) { SetTarget(8, -10.0) }), "Chin Up", inputs)
            compose.onNodeWithContentDescription("Load, kg added").performScrollTo().performClick()
            compose.waitUntil { inputs.isNotEmpty() }
            val uniform = inputs.last()
            compose.onNodeWithText("Vary by set").performScrollTo().performClick()
            val before = inputs.size
            compose.onNodeWithContentDescription("Set 1 load").performScrollTo().performClick()
            compose.waitUntil { inputs.size > before }
            for (input in listOf(uniform, inputs.last())) {
                assertEquals(InputType.TYPE_CLASS_NUMBER, input and InputType.TYPE_MASK_CLASS)
                assertEquals(InputType.TYPE_NUMBER_FLAG_SIGNED, input and InputType.TYPE_NUMBER_FLAG_SIGNED)
                assertEquals(InputType.TYPE_NUMBER_FLAG_DECIMAL, input and InputType.TYPE_NUMBER_FLAG_DECIMAL)
            }
            noSignKey()
        } } finally { scope.cancel() }
    }

    @Test fun anEmptyLoadRemainsUnspecifiedWhenDoneStagesTheMovement() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        try { EngineRoomFixture(tmp.newFolder(), scope).use { room ->
            val draft = editor(room, RoutineDraft(name = "Pull").adding("chin-up")
                .targeting("chin-up", List(3) { SetTarget(8) }), "Chin Up")
            noSignKey()
            assertEquals("", compose.onNodeWithContentDescription("Load, kg added").fetchSemanticsNode()
                .config[SemanticsProperties.EditableText].text)
            compose.onNodeWithText("Done").performClick()
            assertEquals(List(3) { SetTarget(8) }, draft().entry("chin-up")!!.sets)
        } } finally { scope.cancel() }
    }
}
