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

internal class NumberDraft(val field: NumberEntry.Field, initial: Double, initialFloor: Double? = null) {
    var committed by mutableDoubleStateOf(initial)
        private set
    var text by mutableStateOf(Readout.weight(initial))
        private set
    var refusal by mutableStateOf<String?>(null)
        private set
    var focused by mutableStateOf(false)
        private set
    var floor by mutableStateOf(initialFloor)

    val reading: NumberEntry.Reading get() = NumberEntry.read(text, this.field, committed, floor)

    val shownRefusal: String? get() = refusal ?: reading.message.takeIf { reading.belowFloor }

    val isEdited: Boolean get() = text != Readout.weight(committed)

    val canDecrease: Boolean get() = floor.let { it == null || standing > it }

    fun edit(raw: String) {
        text = raw
        refusal = null
    }

    // Leaving commits what was typed, as Done does; a refusal keeps the committed value, shown again when unexplained.
    fun focus(active: Boolean, commit: () -> NumberEditResult) {
        focused = active
        if (!active && isEdited && commit() == NumberEditResult.Refused && refusal == null) cancel()
    }

    // The value this field stands for while another field commits: its reading, else what it last committed.
    val standing: Double get() = reading.value ?: committed

    fun read(): Double? {
        val result = reading
        refusal = result.message.takeUnless { result.isValid }
        return result.value
    }

    fun bumped(direction: Int, big: Boolean): Double? = read()?.let { NumberEntry.bumped(it, direction, big, floor) }

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
        text = Readout.weight(committed)
        refusal = null
    }
}

@Composable
internal fun rememberNumberDraft(key: String, field: NumberEntry.Field, value: Double, floor: Double? = null): NumberDraft {
    val draft = rememberSaveable(key, field, saver = listSaver(
        save = { listOf(it.committed, it.text, it.refusal.orEmpty()) },
        restore = { NumberDraft(field, it[0] as Double, floor).apply {
            edit(it[1] as String)
            (it[2] as String).takeIf(String::isNotEmpty)?.let(::refuse)
        } },
    )) { NumberDraft(field, value, floor) }
    SideEffect {
        draft.floor = floor
        if (draft.committed != value) draft.accept(value)
    }
    return draft
}
