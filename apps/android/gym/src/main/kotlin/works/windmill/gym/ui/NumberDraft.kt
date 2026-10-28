package works.windmill.gym.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import works.windmill.gym.domain.NumberEntry
import works.windmill.gym.domain.Readout

internal class NumberDraft(val field: NumberEntry.Field, initial: Double) {
    var committed by mutableDoubleStateOf(initial)
        private set
    var text by mutableStateOf(NumberEntry.normaliseSign(Readout.weight(initial)))
        private set
    var refusal by mutableStateOf<String?>(null)
        private set
    var focused by mutableStateOf(false)
        private set

    val reading: NumberEntry.Reading get() = NumberEntry.read(text, this.field, committed)

    val isEdited: Boolean get() = text != NumberEntry.normaliseSign(Readout.weight(committed))

    fun edit(raw: String) {
        text = raw
        refusal = null
    }

    fun focus(active: Boolean) {
        focused = active
        if (!active) cancel()
    }

    fun read(): Double? {
        val result = reading
        refusal = result.message.takeUnless { result.isValid }
        return result.value
    }

    fun accept(value: Double): NumberEditResult {
        val changed = value != committed
        committed = value
        cancel()
        return if (changed) NumberEditResult.Changed else NumberEditResult.Unchanged
    }

    fun refuse(message: String): NumberEditResult {
        refusal = message
        return NumberEditResult.Refused
    }

    fun cancel() {
        text = NumberEntry.normaliseSign(Readout.weight(committed))
        refusal = null
    }
}

@Composable
internal fun rememberNumberDraft(key: String, field: NumberEntry.Field, value: Double): NumberDraft {
    val draft = rememberSaveable(key, field, saver = listSaver(
        save = { listOf(it.committed, it.text, it.refusal.orEmpty()) },
        restore = { NumberDraft(field, it[0] as Double).apply {
            edit(it[1] as String)
            (it[2] as String).takeIf(String::isNotEmpty)?.let(::refuse)
        } },
    )) { NumberDraft(field, value) }
    SideEffect { if (draft.committed != value) draft.accept(value) }
    return draft
}
