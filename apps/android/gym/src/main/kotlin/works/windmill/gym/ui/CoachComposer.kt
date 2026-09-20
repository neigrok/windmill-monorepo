package works.windmill.gym.ui

import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import works.windmill.gym.R
import works.windmill.gym.domain.Ask
import works.windmill.gym.domain.CoachAttachment
import works.windmill.gym.domain.CoachDraft
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont

@Composable
internal fun CoachComposer(store: TrainingStore, key: String, seed: String, asking: Boolean,
    onSend: (String, CoachAttachment?) -> Unit, onStop: (() -> Unit)?, upload: Float?, retainDraft: Boolean,
) {
    val skin = LocalGymColors.current
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val scope = rememberCoroutineScope()
    var draft by remember(store.accountKey, key) { mutableStateOf(store.coachDraft(key)) }
    LaunchedEffect(store.accountKey, key) {
        if (draft.text.isEmpty() && draft.photo == null && seed.isNotEmpty()) {
            try { store.saveCoachDraft(key, CoachDraft(seed)); draft = CoachDraft(seed) }
            catch (_: Exception) { }
        }
    }
    LaunchedEffect(store.accountKey, key, store.coachDraftVersion) { draft = store.coachDraft(key) }
    var trouble by remember(store.accountKey, key) { mutableStateOf<String?>(null) }
    var preparing by remember { mutableStateOf(false) }
    fun keep(next: CoachDraft) {
        try { store.saveCoachDraft(key, next); draft = next; trouble = null }
        catch (_: Exception) { trouble = "Your draft couldn’t be saved. Try again." }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) scope.launch {
            preparing = true
            try { store.importCoachPhoto(key, context.contentResolver, uri); trouble = null }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { trouble = "Choose a supported photo." }
            finally { preparing = false }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        draft.photo?.takeIf { !asking || upload != null }?.let { photo ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                CoachPhoto(store, key, photo, Modifier.size(72.dp))
                if (!asking) TextButton(onClick = { keep(draft.copy(photo = null)) },
                    modifier = Modifier.padding(start = 12.dp).heightIn(min = 48.dp)) {
                    Text("Remove photo", style = WindmillFont.body(14), color = skin.inkDim)
                }
            }
        }
        if (preparing) Text("Preparing photo…", style = WindmillFont.body(12), color = skin.inkDim)
        upload?.let {
            LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Photo upload" })
        }
        trouble?.let { Text(it, style = WindmillFont.body(13), color = skin.inkDim) }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Bottom,
            modifier = Modifier.fillMaxWidth().background(skin.surface, RoundedCornerShape(28.dp)).padding(8.dp)) {
            IconButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                enabled = !asking && !preparing, modifier = Modifier.size(48.dp)) {
                Icon(painterResource(R.drawable.gym_photo), "Add photo", tint = skin.inkDim, modifier = Modifier.size(22.dp))
            }
            val visibleText = if (asking && upload == null) "" else draft.text
            BasicTextField(value = visibleText, onValueChange = { keep(draft.copy(text = it)) },
                textStyle = WindmillFont.body(16).copy(lineHeight = 22.sp, color = skin.ink), enabled = !asking && !preparing,
                cursorBrush = SolidColor(skin.accent), decorationBox = { input ->
                    Box(Modifier.heightIn(min = 48.dp).padding(vertical = 12.dp), contentAlignment = Alignment.CenterStart) {
                        if (visibleText.isEmpty()) Text(Ask.placeholder, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = skin.inkDim)
                        input()
                    }
                }, modifier = Modifier.weight(1f).heightIn(max = 160.dp).semantics { contentDescription = "Question" })
            val ready = !asking && !preparing && (Ask.sendable(draft.text) ||
                (draft.photo != null && draft.text.trim().toByteArray().size <= Ask.maxTurnBytes))
            Box(contentAlignment = Alignment.Center,
                modifier = Modifier.size(48.dp).clip(CircleShape).background(skin.raised)
                    .semantics { contentDescription = if (asking && onStop != null) if (upload != null) "Cancel upload" else "Stop response" else "Send" }
                    .clickable(enabled = ready || (asking && onStop != null), role = Role.Button) {
                        if (asking) onStop?.invoke()
                        else { focus.clearFocus(); keyboard?.hide(); onSend(draft.text.trim(), draft.photo); if (!retainDraft) keep(CoachDraft()) }
                    }) {
                Text(if (asking && onStop != null) "■" else "↑", style = WindmillFont.body(if (asking) 20 else 28),
                    color = if (ready || asking) skin.ink else skin.inkFaint)
            }
        }
    }
}

@Composable
internal fun CoachPhoto(store: TrainingStore, threadId: String, photo: CoachAttachment, modifier: Modifier = Modifier) {
    val skin = LocalGymColors.current
    var bitmap by remember(store.accountKey, threadId, photo.id) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var failure by remember(store.accountKey, threadId, photo.id) { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(store.accountKey, threadId, photo.id, attempt) {
        failure = false
        try {
            val bytes = store.coachPhoto(threadId, photo)
            bitmap = withContext(Dispatchers.Default) {
                var sample = 1
                while (photo.width / sample > 1024 || photo.height / sample > 1024) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                    ?: error("Invalid photo")
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { failure = true }
    }
    Box(modifier.clip(RoundedCornerShape(12.dp)).background(skin.surface)
        .clickable(role = Role.Button, onClickLabel = if (failure) "Retry photo" else "View photo") {
            if (failure) attempt++ else expanded = true
        }.semantics { contentDescription = if (failure) "Photo unavailable. Retry photo" else "Attached photo" }, contentAlignment = Alignment.Center) {
        val image = bitmap
        if (image != null) Image(image.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else Text(if (failure) "Retry photo" else "Photo", style = WindmillFont.body(12), color = skin.inkDim)
    }
    if (expanded && bitmap != null) Dialog(onDismissRequest = { expanded = false }) {
        Column(Modifier.background(skin.surface, RoundedCornerShape(16.dp)).padding(12.dp)) {
            Image(requireNotNull(bitmap).asImageBitmap(), "Attached photo", Modifier.fillMaxWidth().heightIn(min = 160.dp, max = 520.dp).aspectRatio(photo.width.toFloat() / photo.height), contentScale = ContentScale.Fit)
            CoachAction("Close", { expanded = false })
        }
    }
}
