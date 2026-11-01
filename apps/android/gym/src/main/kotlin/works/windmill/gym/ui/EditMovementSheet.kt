package works.windmill.gym.ui

import works.windmill.platform.design.WindmillType
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import works.windmill.gym.R
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.Program
import works.windmill.gym.domain.sync.ExerciseRules

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditMovementSheet(
    base: Exercise,
    name: String,
    equipment: String,
    loadCount: Int,
    refused: String?,
    onName: (String) -> Unit,
    onEquipment: (String) -> Unit,
    onSave: () -> Unit,
    saving: Boolean = false,
) {
    val colors = MaterialTheme.colorScheme
    val problem = Program.nameProblem(name)
    val changed = Program.renamed(base.name, name) != null || equipment != base.equipment ||
        equipment == "dumbbell" && loadCount != base.loadCount
    Column(Modifier.fillMaxWidth().imePadding().padding(horizontal = 20.dp).padding(top = 16.dp)) {
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Edit movement", style = WindmillType.sheetTitle, color = colors.onSurface)
            MovementFields(name, equipment, loadCount, onName, onEquipment, enabled = !saving, problem = problem)
            (refused ?: problem)?.let { sentence ->
                Text(sentence, style = WindmillType.detail, color = colors.error,
                    modifier = Modifier.semantics { error(sentence) })
            }
        }
        Button(onClick = onSave, enabled = changed && problem == null && !saving,
            modifier = Modifier.padding(top = 16.dp, bottom = 16.dp).fillMaxWidth().heightIn(min = 56.dp),
            shape = RoundedCornerShape(16.dp)) {
            Text(if (saving) "Saving…" else "Save", style = WindmillType.label)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MovementFields(
    name: String,
    equipment: String,
    loadCount: Int,
    onName: (String) -> Unit,
    onEquipment: (String) -> Unit,
    enabled: Boolean = true,
    problem: String? = null,
) {
    val colors = MaterialTheme.colorScheme
    var menu by remember { mutableStateOf(false) }
    val choice = ExerciseRules.loadingChoice(equipment, loadCount)
    val labels = mapOf("barbell" to "Barbell", "dumbbell" to "Dumbbells", "other" to "Other")
    NativeFieldType {
        OutlinedTextField(name, onValueChange = onName, enabled = enabled, label = { Text("Name", Modifier.clearAndSetSemantics {}) },
            singleLine = true, isError = problem != null,
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).semantics { contentDescription = "Movement name" })
        ExposedDropdownMenuBox(expanded = menu && enabled, onExpandedChange = { if (enabled) menu = it }) {
            OutlinedTextField(labels.getValue(choice), onValueChange = {}, enabled = enabled, readOnly = true,
                label = { Text("Equipment", Modifier.clearAndSetSemantics {}) },
                leadingIcon = if (choice == "other") null else { { EquipmentIcon(choice, Modifier.size(24.dp)) } },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = menu) },
                modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth()
                    .heightIn(min = 56.dp).semantics { contentDescription = "Equipment" })
            ExposedDropdownMenu(expanded = menu && enabled, onDismissRequest = { menu = false }, containerColor = colors.surfaceContainer,
                shape = RoundedCornerShape(16.dp)) {
                labels.keys.forEach { value ->
                    DropdownMenuItem(text = { Text(labels.getValue(value), style = WindmillType.supporting) },
                        leadingIcon = { Box(Modifier.size(20.dp)) { EquipmentIcon(value, Modifier.size(20.dp)) } },
                        trailingIcon = if (choice == value) {
                            { Icon(painterResource(R.drawable.gym_equipment_selected), contentDescription = "Selected", modifier = Modifier.size(20.dp)) }
                        } else null,
                        onClick = { menu = false; onEquipment(value) }, modifier = Modifier.heightIn(min = 48.dp))
                }
            }
        }
    }
}
