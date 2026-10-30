package works.windmill.gym.coach

import works.windmill.gym.ui.LocalGymColors
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
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
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import works.windmill.gym.R
import works.windmill.platform.design.WindmillFont
import works.windmill.gym.coach.onboarding.CoachOnboardingLimits

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CoachComposer(store: CoachStore, key: String, seed: String, asking: Boolean,
    onSend: (String, CoachAttachment?) -> Unit, onStop: (() -> Unit)?, upload: Float?, retainDraft: Boolean, enabled: Boolean = true,
    photoRequest: Int = 0,
) {
    val skin = LocalGymColors.current
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val scope = rememberCoroutineScope()
    val account = store.accountKey
    val hidden by rememberUpdatedState(asking && upload == null)
    val editor = remember(account, key) { CoachDraftEditor(store, key, hidden) }
    DisposableEffect(editor) { onDispose { editor.sync(hidden) } }
    LaunchedEffect(editor) {
        snapshotFlow { Triple(editor.field.text.toString(), store.draftVersion, hidden) }
            .collect { editor.sync(hidden) }
    }
    LaunchedEffect(account, key) {
        if (store.accountKey != account) return@LaunchedEffect
        val current = store.draft(key)
        if (current.text.isEmpty() && current.photo == null && seed.isNotEmpty()) {
            try { store.saveDraft(key, CoachDraft(seed)) }
            catch (_: Exception) { }
        }
    }
    var preparing by remember(account, key) { mutableStateOf(false) }
    fun canSend(next: CoachDraft) = next.text.trim().toByteArray().size <=
        (if (store.anonymous) CoachOnboardingLimits.textBytes else Ask.maxTurnBytes) && (Ask.sendable(next.text) || next.photo != null)
    var pickerOwner by rememberSaveable { mutableStateOf<String?>(null) }
    var pickerChat by rememberSaveable { mutableStateOf<String?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        val targetOwner = pickerOwner
        val targetChat = pickerChat
        pickerOwner = null
        pickerChat = null
        if (uri != null && targetChat != null && targetOwner == store.accountKey) scope.launch {
            if (targetOwner != store.accountKey) return@launch
            preparing = true
            try {
                store.importPhoto(targetChat, context.contentResolver, uri)
                if (targetChat == key && targetOwner == store.accountKey) editor.trouble = null
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                if (targetChat == key && targetOwner == store.accountKey) editor.trouble = "Choose a supported photo."
            } finally { preparing = false }
        }
    }
    fun pickPhoto() {
        pickerOwner = account
        pickerChat = key
        picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }
    LaunchedEffect(photoRequest) {
        if (photoRequest > 0 && enabled && !asking && !preparing) pickPhoto()
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        editor.draft.photo?.takeIf { !asking || upload != null }?.let { photo ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                CoachPhoto(store, key, photo, Modifier.size(72.dp))
                if (!asking) TextButton(onClick = {
                    if (editor.sync(hidden)) editor.keep(editor.draft.copy(photo = null))
                },
                    enabled = enabled && !preparing, modifier = Modifier.padding(start = 12.dp).heightIn(min = 48.dp)) {
                    Text("Remove photo", style = WindmillFont.body(14), color = if (enabled) skin.inkDim else skin.ink.copy(alpha = 0.38f))
                }
            }
        }
        if (preparing) Text("Preparing photo…", style = WindmillFont.body(12), color = skin.inkDim)
        upload?.let {
            LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Photo upload" })
        }
        editor.trouble?.let { Text(it, style = WindmillFont.body(13), color = skin.inkDim) }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, top = 8.dp, bottom = 8.dp)) {
            IconButton(onClick = ::pickPhoto,
                enabled = enabled && !asking && !preparing, modifier = Modifier.size(48.dp)) {
                Icon(painterResource(R.drawable.gym_coach_image), "Add photo", tint = if (enabled) skin.inkDim else skin.ink.copy(alpha = 0.38f), modifier = Modifier.size(24.dp))
            }
            val inputEnabled = enabled && !asking && !preparing
            val interaction = remember(editor) { MutableInteractionSource() }
            val fieldColors = TextFieldDefaults.colors(
                    focusedContainerColor = skin.raised, unfocusedContainerColor = skin.raised, disabledContainerColor = if (enabled) skin.raised else skin.ink.copy(alpha = 0.04f),
                    focusedTextColor = skin.ink, unfocusedTextColor = skin.ink, disabledTextColor = if (enabled) skin.ink else skin.ink.copy(alpha = 0.38f),
                    focusedPlaceholderColor = skin.inkDim, unfocusedPlaceholderColor = skin.inkDim, disabledPlaceholderColor = if (enabled) skin.inkDim else skin.ink.copy(alpha = 0.38f),
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
                    cursorColor = skin.accent)
            BasicTextField(state = editor.field,
                textStyle = CoachType.body(16).copy(lineHeight = 24.sp, letterSpacing = 0.5.sp,
                    color = if (enabled) skin.ink else skin.ink.copy(alpha = 0.38f)),
                enabled = inputEnabled, cursorBrush = SolidColor(skin.accent), interactionSource = interaction,
                decorator = { input ->
                    TextFieldDefaults.DecorationBox(value = editor.field.text.toString(), innerTextField = input,
                        enabled = inputEnabled, singleLine = false, visualTransformation = VisualTransformation.None,
                        interactionSource = interaction, shape = RoundedCornerShape(28.dp), colors = fieldColors,
                        placeholder = { Text(Ask.placeholder, style = CoachType.body(16).copy(lineHeight = 24.sp, letterSpacing = 0.5.sp)) })
                }, modifier = Modifier.weight(1f).heightIn(min = 56.dp, max = 160.dp).semantics { contentDescription = "Question" })
            val ready = enabled && !asking && !preparing && canSend(editor.draft.copy(text = editor.field.text.toString()))
            if (asking || editor.field.text.isNotEmpty() || editor.draft.photo != null) {
                Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                    FilledIconButton(enabled = ready || (asking && onStop != null), modifier = Modifier.size(40.dp),
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = skin.accent, contentColor = skin.onAccent),
                        onClick = {
                            if (asking) onStop?.invoke()
                            else if (editor.sync(hidden, retry = true)) {
                                val next = editor.draft
                                if (canSend(next)) {
                                    focus.clearFocus()
                                    keyboard?.hide()
                                    onSend(next.text.trim(), next.photo)
                                    if (!retainDraft) editor.keep(CoachDraft())
                                }
                            }
                        }) {
                        Icon(painterResource(if (asking) R.drawable.gym_coach_stop else R.drawable.gym_coach_send),
                            if (asking) if (upload != null) "Cancel upload" else "Stop response" else "Send", Modifier.size(24.dp))
                    }
                }
            }
        }
    }
}

private class CoachDraftEditor(private val store: CoachStore, private val key: String, private var hidden: Boolean) {
    private val account = store.accountKey
    var draft by mutableStateOf(store.draft(key))
        private set
    val field = TextFieldState(if (hidden) "" else draft.text)
    var trouble by mutableStateOf<String?>(null)

    fun sync(hidden: Boolean, retry: Boolean = false): Boolean {
        if (store.accountKey != account) return false
        val current = store.draft(key)
        if (retry && !store.draftSaved(key)) return keep(current.copy(text = field.text.toString()))
        val refresh = current.text != draft.text || this.hidden != hidden
        draft = current
        this.hidden = hidden
        if (refresh) {
            val text = if (hidden) "" else current.text
            if (field.text.toString() != text) field.setTextAndPlaceCursorAtEnd(text)
            return true
        }
        if (hidden || field.text.toString() == current.text) return store.draftSaved(key)
        return keep(current.copy(text = field.text.toString()))
    }

    fun keep(next: CoachDraft): Boolean {
        if (store.accountKey != account) return false
        try {
            store.saveDraft(key, next)
            draft = next
            val text = if (hidden) "" else next.text
            if (field.text.toString() != text) field.setTextAndPlaceCursorAtEnd(text)
            trouble = null
            return true
        } catch (_: Exception) {
            trouble = "Your draft couldn’t be saved. Try again."
            return false
        }
    }
}

@Composable
internal fun CoachPhoto(store: CoachStore, threadId: String, photo: CoachAttachment, modifier: Modifier = Modifier) {
    val skin = LocalGymColors.current
    var bitmap by remember(store.accountKey, threadId, photo.id) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var failure by remember(store.accountKey, threadId, photo.id) { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(store.accountKey, threadId, photo.id, attempt) {
        failure = false
        try {
            val bytes = store.photo(threadId, photo)
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
