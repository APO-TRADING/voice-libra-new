package com.beppeaudiobooks.pipertts

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Minimal WAV file writer for 16-bit signed PCM mono audio.
 *
 * Pipes:
 *   FloatArray  ([-1, 1])  -->  PCM Int16  -->  file:///cache/.../*.wav
 *
 * Why 16-bit Int instead of 32-bit Float? ExoPlayer (the audio backend
 * react-native-track-player uses under the hood on Android) supports
 * both, but 16-bit is universally well-tested and halves the WAV size.
 * For Piper TTS quality (16 kHz @ x_low, 22 kHz @ medium, 24 kHz @ high)
 * the human-audible difference vs Float32 is zero.
 *
 * Header layout (44 bytes, little-endian where applicable):
 *   00-03: "RIFF"
 *   04-07: file_size - 8                       (uint32 LE)
 *   08-11: "WAVE"
 *   12-15: "fmt "
 *   16-19: subchunk1 size = 16                 (uint32 LE)
 *   20-21: audio format = 1 (PCM)              (uint16 LE)
 *   22-23: num channels = 1                    (uint16 LE)
 *   24-27: sample rate (e.g. 16000, 22050)     (uint32 LE)
 *   28-31: byte rate = sr * 1 * 2              (uint32 LE)
 *   32-33: block align = 1 * 2 = 2             (uint16 LE)
 *   34-35: bits per sample = 16                (uint16 LE)
 *   36-39: "data"
 *   40-43: data size = numSamples * 2          (uint32 LE)
 *   44+  : PCM samples
 */
object WavWriter {
  /**
   * Write `pcm` as a 16-bit mono WAV at `outFile`.
   * Overwrites if the file already exists.
   *
   * @return the absolute path of the written file.
   */
  fun writeMono16(pcm: FloatArray, sampleRate: Int, outFile: File): String {
    if (sampleRate <= 0) error("sampleRate must be > 0")
    outFile.parentFile?.mkdirs()

    val dataSize = pcm.size * 2
    val fileSize = 44 + dataSize

    // Build the 44-byte header.
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    header.put("RIFF".toByteArray(Charsets.US_ASCII))
    header.putInt(fileSize - 8)
    header.put("WAVE".toByteArray(Charsets.US_ASCII))
    header.put("fmt ".toByteArray(Charsets.US_ASCII))
    header.putInt(16)              // PCM fmt chunk size
    header.putShort(1)             // PCM format code
    header.putShort(1)             // mono
    header.putInt(sampleRate)
    header.putInt(sampleRate * 1 * 2) // byte rate
    header.putShort((1 * 2).toShort()) // block align
    header.putShort(16)            // bits per sample
    header.put("data".toByteArray(Charsets.US_ASCII))
    header.putInt(dataSize)

    // Write header + samples in a single output stream.
    // RandomAccessFile is convenient because we can patch sizes later if
    // needed, but here we already know everything upfront.
    RandomAccessFile(outFile, "rw").use { raf ->
      raf.setLength(0L)
      raf.write(header.array())
      // Convert FloatArray [-1, 1] to Int16 PCM and write in chunks.
      val chunkSize = 8192
      val buf = ByteBuffer.allocate(chunkSize * 2).order(ByteOrder.LITTLE_ENDIAN)
      var i = 0
      while (i < pcm.size) {
        buf.clear()
        val end = minOf(i + chunkSize, pcm.size)
        for (j in i until end) {
          val s = pcm[j]
          val clamped = when {
            s >  1f ->  1f
            s < -1f -> -1f
            else    -> s
          }
          val v = (clamped * 32767f).toInt()
          buf.putShort(v.toShort())
        }
        raf.write(buf.array(), 0, (end - i) * 2)
        i = end
      }
    }
    return outFile.absolutePath
  }
}
