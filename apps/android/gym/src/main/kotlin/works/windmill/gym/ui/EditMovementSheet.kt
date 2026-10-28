package works.windmill.gym.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.R
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Program
import works.windmill.gym.domain.sync.ExerciseRules
import works.windmill.platform.design.WindmillFont

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
    val skin = LocalGymColors.current
    val problem = Program.nameProblem(name)
    val changed = Program.renamed(base.name, name) != null || equipment != base.equipment ||
        equipment == "dumbbell" && loadCount != base.loadCount
    var menu by remember { mutableStateOf(false) }
    val choice = ExerciseRules.loadingChoice(equipment, loadCount)
    val labels = mapOf("barbell" to "Barbell", "dumbbell" to "Dumbbells", "other" to "Other")
    Column(Modifier.fillMaxWidth().imePadding().padding(horizontal = 20.dp).padding(top = 16.dp)) {
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Edit movement", style = WindmillFont.body(26, FontWeight.ExtraBold).copy(lineHeight = 32.sp), color = skin.ink)
            MaterialTheme(typography = MaterialTheme.typography.copy(
                bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 16.sp, lineHeight = 24.sp, letterSpacing = .5.sp),
                bodySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = .4.sp),
            )) {
                OutlinedTextField(name, onValueChange = onName, enabled = !saving, label = { Text("Name") },
                    singleLine = true, isError = problem != null,
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).semantics { contentDescription = "Movement name" })
                ExposedDropdownMenuBox(expanded = menu && !saving, onExpandedChange = { if (!saving) menu = it }) {
                    OutlinedTextField(labels.getValue(choice), onValueChange = {}, enabled = !saving, readOnly = true,
                        label = { Text("Equipment") },
                        leadingIcon = if (choice == "other") null else { { EquipmentIcon(choice, Modifier.size(24.dp)) } },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = menu) },
                        modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth()
                            .heightIn(min = 56.dp).semantics { contentDescription = "Equipment" })
                    ExposedDropdownMenu(expanded = menu && !saving, onDismissRequest = { menu = false }, containerColor = skin.surface,
                        shape = RoundedCornerShape(16.dp)) {
                        labels.keys.forEach { value ->
                            DropdownMenuItem(text = { Text(labels.getValue(value), style = WindmillFont.body(14)) },
                                leadingIcon = { Box(Modifier.size(20.dp)) { EquipmentIcon(value, Modifier.size(20.dp)) } },
                                trailingIcon = if (choice == value) {
                                    { Icon(painterResource(R.drawable.gym_equipment_selected), contentDescription = "Selected", modifier = Modifier.size(20.dp)) }
                                } else null,
                                onClick = { menu = false; onEquipment(value) }, modifier = Modifier.heightIn(min = 48.dp))
                        }
                    }
                }
            }
            (refused ?: problem)?.let { sentence ->
                Text(sentence, style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = skin.error,
                    modifier = Modifier.semantics { error(sentence) })
            }
        }
        Button(onClick = onSave, enabled = changed && problem == null && !saving,
            modifier = Modifier.padding(top = 16.dp, bottom = 16.dp).fillMaxWidth().heightIn(min = 56.dp),
            shape = RoundedCornerShape(16.dp)) {
            Text(if (saving) "Saving…" else "Save", style = WindmillFont.body(16, FontWeight.Bold))
        }
    }
}
