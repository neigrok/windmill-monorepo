package works.windmill.gym.ui

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import kotlin.math.PI
import kotlin.math.pow
import kotlin.math.sin

// THERE ARE EXACTLY TWO SOUNDS IN WINDMILL GYM, EVER, AND THIS FILE IS THE WHOLE LIST. Nothing makes
// noise on finish, on undo, on a personal record, on an error or on a sync — a training log does not
// congratulate. The Android statement of web/src/products/gym/logger/sound.js, at the same two pitches.
//
// Sound carries the one confirmation the screen cannot: the rest landing while the phone is in a
// pocket. There are no haptics in this design's world, so everything else the product confirms it
// confirms visually — the set row appearing, the button saying the weight back at 64dp.
//
// Both halves of the iOS `.ambient` category are kept: USAGE_ASSISTANCE_SONIFICATION MIXES, so a
// lifter's music is never interrupted by a log, and the ringer check obeys the silence switch, so a
// silenced phone stays silent. Every call is wrapped, because a device that will not make a sound
// must never break a set.
//
// Main-thread by construction: reached from the one thread that taps buttons, so the handler below
// needs no lock and cannot be raced.
object GymSound {
    fun setLogged(context: Context) {
        play(context, hz = 760.0, seconds = 0.07)
    }

    fun restLanded(context: Context) {
        play(context, hz = 680.0, seconds = 0.13)
        handler.postDelayed({ play(context, hz = 1020.0, seconds = 0.2) }, 150)
    }

    private const val sampleRate = 44_100
    private val handler = Handler(Looper.getMainLooper())

    private fun play(context: Context, hz: Double, seconds: Double) {
        runCatching {
            val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (audio.ringerMode != AudioManager.RINGER_MODE_NORMAL) return
            val samples = tone(hz, seconds)
            val track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build())
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(sampleRate)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build())
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(samples.size * 2)
                .build()
            track.write(samples, 0, samples.size)
            track.play()
            handler.postDelayed({ runCatching { track.release() } }, (seconds * 1000).toLong() + 100)
        }
    }

    // A sine under an exponential decay — the same envelope the web ramps its gain along and iOS
    // fills its PCM buffer with, so the three surfaces make the same shape of sound rather than the
    // same frequency with different edges.
    private fun tone(hz: Double, seconds: Double): ShortArray {
        val frames = (sampleRate * seconds).toInt()
        return ShortArray(frames) { frame ->
            val progress = frame.toDouble() / frames
            val decay = 0.0001.pow(progress)
            (sin(2 * PI * hz * frame / sampleRate) * 0.35 * decay * Short.MAX_VALUE).toInt().toShort()
        }
    }
}
