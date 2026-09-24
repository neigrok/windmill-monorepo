package works.windmill.gym.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import java.text.BreakIterator
import works.windmill.gym.domain.AskGeneration

private const val nanosPerSecond = 1e9
private const val floorCharsPerSecond = 40.0
private const val intervalWeight = 0.3

// Paces the live answer between the transport's snapshots, which land about once a second carrying
// a few lines each: what is pending is spread over the measured inter-arrival interval, so the text
// reads as typing instead of lines dropping in, and a stalled stream shows what it has and stops.
// Text present when the reveal is made is shown at once; only what lands afterwards is paced.
// Every stamp is a frame time, so the one clock that draws the answer also paces it.
internal class CoachReveal(initial: String) {
    private var received = initial
    private var revealed = initial.length.toDouble()
    private var anchor = revealed
    private var anchorNanos = 0L
    private var charsPerSecond = floorCharsPerSecond
    private var interval = 1.0
    private var arrivedNanos: Long? = null
    private val graphemes: BreakIterator = BreakIterator.getCharacterInstance().apply { setText(initial) }

    val settled: Boolean get() = revealed >= received.length

    fun receive(text: String, atNanos: Long) {
        advance(atNanos)
        val kept = received.commonPrefixWith(text).length
        if (kept < received.length) revealed = minOf(revealed, kept.toDouble())
        if (text.length > kept) {
            arrivedNanos?.let { last ->
                val sample = ((atNanos - last) / nanosPerSecond).coerceIn(0.2, 2.0)
                interval += intervalWeight * (sample - interval)
            }
            arrivedNanos = atNanos
        }
        received = text
        graphemes.setText(text)
        anchor = revealed
        anchorNanos = atNanos
        charsPerSecond = maxOf(floorCharsPerSecond, (received.length - revealed) / interval)
    }

    fun shown(atNanos: Long): String {
        advance(atNanos)
        val at = revealed.toInt()
        val cut = if (graphemes.isBoundary(at)) at else graphemes.preceding(at).coerceAtLeast(0)
        return received.substring(0, cut)
    }

    // One product from the last anchor, never a sum of per-frame steps that would drift below whole
    // characters.
    private fun advance(atNanos: Long) {
        val elapsed = (atNanos - anchorNanos).coerceAtLeast(0) / nanosPerSecond
        revealed = minOf(received.length.toDouble(), anchor + charsPerSecond * elapsed)
    }
}

// The running answer as the reader sees it this frame. It mounts settled on the text already there,
// so a room revisited mid-stream never re-types. Arrival stamps and advancement both take the frame
// clock, so the test clock drives the whole reveal.
@Composable
internal fun rememberRevealedText(messageKey: String, generation: AskGeneration): String {
    val reveal = remember(messageKey) { CoachReveal(generation.answer) }
    var shown by remember(messageKey) { mutableStateOf(generation.answer) }
    LaunchedEffect(reveal, generation.answer) {
        withFrameNanos { frame ->
            reveal.receive(generation.answer, frame)
            shown = reveal.shown(frame)
        }
        while (!reveal.settled) withFrameNanos { frame -> shown = reveal.shown(frame) }
    }
    return shown
}
