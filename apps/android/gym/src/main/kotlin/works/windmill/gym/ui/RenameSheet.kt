package works.windmill.gym.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Program
import works.windmill.platform.design.WindmillFont

@Composable
fun RenameSheet(
    title: String,
    from: String,
    value: String,
    keepsAlias: Boolean,
    refused: String?,
    onValue: (String) -> Unit,
    onRename: () -> Unit,
    saving: Boolean = false,
) {
    val skin = LocalGymColors.current
    val problem = Program.nameProblem(value)
    val changed = Program.renamed(from, value) != null
    Column(Modifier.fillMaxWidth().imePadding().padding(horizontal = 20.dp)) {
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(title, style = WindmillFont.body(26, FontWeight.Bold).copy(lineHeight = 36.sp), color = skin.ink)
            Text("Name", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            OutlinedTextField(value, onValueChange = onValue, enabled = !saving,
                singleLine = true, isError = refused != null || problem != null,
                textStyle = WindmillFont.body(18).copy(lineHeight = 24.sp),
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                shape = RoundedCornerShape(20.dp),
                colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = skin.raised,
                    unfocusedContainerColor = skin.raised, disabledContainerColor = skin.raised,
                    focusedBorderColor = skin.accent, unfocusedBorderColor = Color.Transparent,
                    focusedTextColor = skin.ink, unfocusedTextColor = skin.ink, cursorColor = skin.accent),
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp))
            Program.counter(value)?.let { Text(it, style = WindmillFont.body(14), color = skin.inkDim) }
            (refused ?: problem)?.let { Text(it, style = WindmillFont.body(14), color = skin.alarmInk) }
            Text("Renames this movement everywhere.", style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.ink)
            Text("Your logged sets and records keep the same movement.", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
            if (keepsAlias) Text("Old name: $from\nSearchable as an alias.",
                style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
        }
        Box(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
            androidx.compose.material3.Button(onClick = onRename, enabled = changed && problem == null && !saving,
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp), shape = RoundedCornerShape(16.dp)) {
                Text(if (saving) "Renaming…" else "Rename", style = WindmillFont.body(16, FontWeight.Bold))
            }
        }
    }
}
