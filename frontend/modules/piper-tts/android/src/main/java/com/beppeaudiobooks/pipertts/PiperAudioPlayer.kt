package com.beppeaudiobooks.pipertts

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Simple AudioTrack-based PCM player.
 *
 * Piper outputs FLOAT mono PCM in [-1, 1] at the model's sample rate. We
 * pass it to AudioTrack in ENCODING_PCM_FLOAT mode. AudioTrack handles
 * resampling to the device's output rate automatically.
 */
class PiperAudioPlayer {
  private var track: AudioTrack? = null
  private val playing = AtomicBoolean(false)
  private var currentSr = 0

  fun ensureTrack(sampleRate: Int) {
    if (track != null && currentSr == sampleRate) return
    release()
    currentSr = sampleRate

    val minBuf = AudioTrack.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_FLOAT,
    ).coerceAtLeast(sampleRate * 4 /* 1 sec at float */)

    track = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(sampleRate)
          .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .build()
      )
      .setBufferSizeInBytes(minBuf)
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()

    Log.i(TAG, "AudioTrack created: sr=$sampleRate buf=$minBuf")
  }

  /** Blocks until all samples are played OR stop() is called. */
  fun playPcmBlocking(pcm: FloatArray) {
    val t = track ?: return
    if (pcm.isEmpty()) return
    t.play()
    playing.set(true)
    // Write in chunks so stop() can interrupt promptly.
    val chunk = 1024
    var i = 0
    while (i < pcm.size && playing.get()) {
      val end = minOf(i + chunk, pcm.size)
      val w = t.write(pcm, i, end - i, AudioTrack.WRITE_BLOCKING)
      if (w < 0) {
        Log.e(TAG, "AudioTrack.write returned $w — aborting")
        break
      }
      i += w
    }
    if (playing.get()) {
      // Wait for tail samples to drain.
      try { t.stop() } catch (_: IllegalStateException) {}
    }
    playing.set(false)
  }

  fun stop() {
    playing.set(false)
    val t = track ?: return
    try {
      t.pause()
      t.flush()
      t.stop()
    } catch (_: IllegalStateException) { /* ignore */ }
  }

  fun release() {
    stop()
    track?.release()
    track = null
  }

  companion object { private const val TAG = "PiperAudioPlayer" }
}
