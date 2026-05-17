package com.beppeaudiobooks.pipertts

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.util.Log
import java.io.File
import java.nio.FloatBuffer
import java.nio.LongBuffer

/**
 * Wraps the ONNX Runtime session for a single Piper voice and exposes a
 * synthesize(ipaText, speed) -> FloatArray (PCM mono) method.
 *
 * Piper VITS model graph (all standard Piper releases):
 *   Inputs:
 *     - input          : INT64 [batch, T]      phoneme ID sequence
 *     - input_lengths  : INT64 [batch]         length of phoneme seq
 *     - scales         : FLOAT [3]             [noise_scale, length_scale, noise_w]
 *     - sid (optional) : INT64 [batch]         speaker id (multi-speaker models)
 *   Output:
 *     - output         : FLOAT [batch, 1, n]   raw mono audio at sampleRate
 *
 * Microsoft ONNX Runtime Android supports FP32, FP16, INT8 weights natively
 * via its kernel set — we do NOT need to write any quantization logic.
 */
class OnnxEngine(modelPath: String, private val voice: VoiceConfig) {
  private val env = OrtEnvironment.getEnvironment()
  private val session: OrtSession
  private val hasSpeakerInput: Boolean

  init {
    val opts = OrtSession.SessionOptions().apply {
      // Optimize aggressively (default is ORT_ENABLE_ALL but the Android
      // build defaults to BASIC — explicitly request ALL).
      setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
      // Use 2 inter-op threads. Most phones are 4-8 cores; 2 strikes a
      // good balance between latency and battery. The user can tweak via
      // the `threads` arg later if exposed.
      setInterOpNumThreads(2)
      setIntraOpNumThreads(4)
    }
    Log.i(TAG, "Loading ONNX model from $modelPath")
    val modelBytes = File(modelPath).readBytes()
    session = env.createSession(modelBytes, opts)
    hasSpeakerInput = session.inputNames.contains("sid")
    Log.i(TAG, "Model loaded. inputs=${session.inputNames} hasSid=$hasSpeakerInput outputs=${session.outputNames}")
  }

  /**
   * Run inference. Returns raw mono PCM as FloatArray in range [-1, 1].
   * @param phonemeIds the output of VoiceConfig.textToInputIds(ipa)
   * @param speed playback speed multiplier (1.0=default; <1=slower, >1=faster)
   * @param speakerId for multi-speaker models (default 0)
   */
  fun synthesize(phonemeIds: IntArray, speed: Float, speakerId: Int = 0): FloatArray {
    val t0 = System.currentTimeMillis()
    val n = phonemeIds.size
    if (n == 0) return FloatArray(0)

    // Build input tensor: shape [1, N], dtype int64.
    val inputBuf = LongBuffer.allocate(n)
    for (id in phonemeIds) inputBuf.put(id.toLong())
    inputBuf.rewind()
    val inputTensor = OnnxTensor.createTensor(env, inputBuf, longArrayOf(1L, n.toLong()))

    // input_lengths : [1], int64
    val lenTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(longArrayOf(n.toLong())), longArrayOf(1L))

    // scales : [3], float32. length_scale = voice default / speed.
    val effLen = (voice.lengthScale / speed.coerceAtLeast(0.1f))
    val scalesArr = floatArrayOf(voice.noiseScale, effLen, voice.noiseW)
    val scalesTensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(scalesArr), longArrayOf(3L))

    val inputs = HashMap<String, OnnxTensor>(4)
    inputs["input"] = inputTensor
    inputs["input_lengths"] = lenTensor
    inputs["scales"] = scalesTensor
    if (hasSpeakerInput) {
      val sidTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(longArrayOf(speakerId.toLong())), longArrayOf(1L))
      inputs["sid"] = sidTensor
    }

    val pcm: FloatArray
    try {
      session.run(inputs).use { result ->
        // The model output name is typically "output" but Piper variants
        // exist that name it differently. Use the first output regardless.
        val outVal = result.get(0)
        @Suppress("UNCHECKED_CAST")
        // Output shape is [batch=1, channels=1, samples] OR [batch=1, samples].
        val raw = outVal.value
        pcm = when (raw) {
          is Array<*> -> {
            // could be Array<Array<FloatArray>> or Array<FloatArray>
            val a0 = raw[0]
            when (a0) {
              is Array<*> -> (a0[0] as FloatArray)
              is FloatArray -> a0
              else -> error("unexpected nested output type ${a0?.javaClass}")
            }
          }
          is FloatArray -> raw
          else -> error("unexpected ONNX output type: ${raw?.javaClass}")
        }
      }
    } finally {
      inputs.values.forEach { runCatching { it.close() } }
    }

    val durMs = System.currentTimeMillis() - t0
    Log.i(TAG, "synthesize: ${phonemeIds.size} ids → ${pcm.size} samples in ${durMs}ms")
    return pcm
  }

  fun close() {
    runCatching { session.close() }
  }

  companion object {
    private const val TAG = "PiperOnnxEngine"
  }
}
