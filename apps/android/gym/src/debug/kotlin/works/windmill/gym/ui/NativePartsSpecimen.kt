package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.R

@Composable
fun NativePartsSpecimen(specimen: String) {
    val skin = LocalGymColors.current
    val root = Modifier.fillMaxSize().background(skin.canvas)
    if (specimen == "board") {
        Column(root.padding(24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(48.dp)) {
                SpecimenGroup("FAB · NEW ROUTINE", Modifier.width(128.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        GymFab("New routine", {})
                        GymFab("Pressed new routine", {})
                    }
                }
                SpecimenGroup("EXTENDED FAB · WEIGH IN", Modifier.width(280.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        repeat(2) { GymExtendedFab("Weigh in", {}, painterResource(R.drawable.gym_native_monitor_weight)) }
                    }
                }
                SpecimenGroup("ERROR BUTTONS · ANDROID/SYSTEM/ERROR", Modifier.width(752.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        GymErrorButton("Discard", {}, Modifier.width(240.dp))
                        GymErrorTextButton("Delete weigh-in", {}, Modifier.width(240.dp))
                        GymErrorTextButton("Delete note", {}, Modifier.width(240.dp))
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(48.dp)) {
                SpecimenGroup("SWIPE ROW · REST → SWIPING → PAST THRESHOLD (GONE ON RELEASE)", Modifier.width(403.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SpecimenSwipe("Rest row")
                        SpecimenSwipe("Swiping row")
                        SpecimenSwipe("Threshold row")
                    }
                }
                SpecimenGroup("NUMBER STEPPER · DEFAULT · PRESSED · CHANGED · FOCUSED", Modifier.width(357.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (state in listOf("Default", "Pressed", "Changed", "Focused")) {
                            SpecimenNumber("80", "Load", "kg total", Modifier.width(320.dp)
                                .semantics { contentDescription = "$state stepper" })
                        }
                    }
                }
            }
        }
        return
    }
    var menu by remember { mutableStateOf(false) }
    Column(root.windowInsetsPadding(WindowInsets.safeDrawing).verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp)) {
        SpecimenGroup("DISPLAY · SIGNED DECIMAL") {
            SpecimenNumber(when (specimen) {
                "long-load" -> "-102.5"
                "bound-load" -> "-499.99"
                "fit-load" -> "24"
                else -> "-12.5"
            }, "Load", "kg added",
                size = NumberStepperSize.Display)
        }
        SpecimenGroup("REGULAR · COUNT") {
            SpecimenNumber(if (specimen == "refusal") "0" else "10", "Reps", "reps",
                refusal = if (specimen == "refusal") "Reps, 1 to 20." else null)
        }
        SpecimenGroup("SWIPE ROW") { SpecimenSwipe("Phone swipe row") }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            GymFab("New routine", {})
            GymExtendedFab("Weigh in", {}, painterResource(R.drawable.gym_native_monitor_weight))
        }
        GymErrorButton("Discard", {}, Modifier.fillMaxWidth())
        GymErrorTextButton("Delete note", {}, Modifier.fillMaxWidth())
        Box {
            TextButton({ menu = true }) { Text("Open specimen menu") }
            GymMenu(menu, { menu = false }) {
                GymMenuItem("Delete routine", painterResource(R.drawable.gym_native_delete),
                    { menu = false }, destructive = true)
            }
        }
    }
}

@Composable
private fun SpecimenGroup(caption: String, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(caption, color = LocalGymColors.current.inkDim, maxLines = 1,
            style = TextStyle(fontFamily = GymNativeType.mono, fontSize = 11.sp, lineHeight = 15.sp, letterSpacing = 0.sp))
        content()
    }
}

@Composable
private fun SpecimenNumber(initial: String, label: String, unit: String, modifier: Modifier = Modifier,
    size: NumberStepperSize = NumberStepperSize.Regular, refusal: String? = null) {
    var value by remember { mutableStateOf(initial) }
    NumberStepper(value, { value = it }, label, unit,
        onStep = { step ->
            val current = value.toDoubleOrNull()
            if (current == null || refusal != null) NumberEditResult.Refused
            else {
                val next = current + if (step == NumberStep.Increase) 1 else -1
                value = if (next % 1 == 0.0) next.toInt().toString() else next.toString()
                NumberEditResult.Changed
            }
        }, onCommit = { if (refusal == null) NumberEditResult.Unchanged else NumberEditResult.Refused },
        modifier = modifier, size = size, refusal = refusal,
        input = if (label == "Load") NumberStepperInput.SignedDecimal else NumberStepperInput.Count,
        commitEnabled = refusal == null)
}

@Composable
private fun SpecimenSwipe(label: String) {
    var visible by remember { mutableStateOf(true) }
    if (!visible) return
    val skin = LocalGymColors.current
    DeleteSwipeRow("Delete $label", { visible = false; true },
        Modifier.width(372.dp).semantics { contentDescription = label }) {
        Column(Modifier.fillMaxWidth().height(68.dp).background(skin.surface, RoundedCornerShape(16.dp))
            .padding(horizontal = 16.dp, vertical = 10.dp)) {
            Text("Push A", color = skin.ink, style = TextStyle(fontFamily = GymNativeType.sans,
                fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Bold))
            Text("Bench Press · Overhead Press", color = skin.inkDim,
                style = TextStyle(fontFamily = GymNativeType.sans, fontSize = 13.sp, lineHeight = 18.sp))
        }
    }
}
