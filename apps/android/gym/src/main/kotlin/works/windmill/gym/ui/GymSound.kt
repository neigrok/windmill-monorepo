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

// USAGE_ASSISTANCE_SONIFICATION mixes, so a lifter's music is never interrupted, and the ringer check
// obeys the silence switch. Every call is wrapped: a device that will not make a sound must not break a set.
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

    private fun tone(hz: Double, seconds: Double): ShortArray {
        val frames = (sampleRate * seconds).toInt()
        return ShortArray(frames) { frame ->
            val progress = frame.toDouble() / frames
            val decay = 0.0001.pow(progress)
            (sin(2 * PI * hz * frame / sampleRate) * 0.35 * decay * Short.MAX_VALUE).toInt().toShort()
        }
    }
}
