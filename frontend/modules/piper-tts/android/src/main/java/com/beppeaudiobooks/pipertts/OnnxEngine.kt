package com.beppeaudiobooks.pipertts

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.util.Log
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
 *
 * Execution provider (v2.2): CPU + XNNPACK only. NNAPI was attempted in
 * v2.1 but caused ORT_FAIL crashes on Realme/MediaTek phones running
 * Android 16; the few devices where it *did* load didn't show any
 * measurable inference speedup for VITS-style graphs. CPU EP with the
 * built-in XNNPACK kernels is the production path.
 */
class OnnxEngine(modelPath: String, private val voice: VoiceConfig) {
  private val env = OrtEnvironment.getEnvironment()
  private val session: OrtSession
  private val hasSpeakerInput: Boolean
  /** Reports back to JS which EP was effectively used (always "CPU" in v2.2). */
  val executionProvider: String = "CPU"

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

    Log.i(TAG, "Loading ONNX model from $modelPath (EP=CPU)")
    // Use the path-based createSession so ORT can mmap() the model file
    // directly instead of us reading the whole thing into a Java byte[].
    // This matters for medium/high-quality Piper models (60-100 MB) on
    // low-memory devices: byte[] would briefly DOUBLE the memory peak.
    session = env.createSession(modelPath, opts)
    hasSpeakerInput = session.inputNames.contains("sid")
    Log.i(TAG, "Model loaded. EP=$executionProvider inputs=${session.inputNames} hasSid=$hasSpeakerInput outputs=${session.outputNames}")
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
        val raw = outVal.value
        // Piper VITS models export with WILDLY different output shapes
        // depending on the converter used:
        //   • Standard rhasspy/piper:    [batch, channels, samples]
        //     -> Array<Array<FloatArray>>
        //   • Slimmed exports:           [batch, samples]
        //     -> Array<FloatArray>
        //   • Riccardo / older models:   [batch, 1, 1, samples]
        //     -> Array<Array<Array<FloatArray>>>
        //   • Some custom exports:       [samples]
        //     -> FloatArray
        // We unwrap recursively by walking down the [0] of every nested
        // Object[] array until we hit a FloatArray. This avoids the
        // brittle hand-coded "match the exact nesting depth" approach.
        pcm = unwrapPcm(raw)
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

    /**
     * Recursively walk the ONNX output tensor's nested representation
     * (in Kotlin, multi-dim float tensors come back as Object[] of
     * Object[] of … of FloatArray) and return the leaf FloatArray with
     * the actual PCM samples.
     *
     * Why this is needed: Piper exports its VITS model with shape
     *   [batch, channels, samples]
     * in the official rhasspy/piper toolchain, BUT custom converters
     * (e.g. Optimum, manual onnx-simplifier passes) sometimes produce:
     *   [batch, 1, 1, samples]  -- redundant unit-dim from squeeze ops
     *   [batch, samples]        -- 2D slim export
     *   [samples]               -- already-unbatched (rare)
     * The Riccardo bundled voice in our repo happens to have a 4D
     * output which used to crash with "float[][] cannot be cast to
     * float[]" because we tried `(a0[0] as FloatArray)` expecting 3D.
     *
     * This unwrapper is shape-agnostic: it just follows [0] until it
     * finds a FloatArray. For multi-batch outputs (rare in Piper) it
     * would discard everything except batch 0, which is the desired
     * behavior since we always call synth with batch=1.
     */
    @JvmStatic
    fun unwrapPcm(obj: Any?): FloatArray {
      var current: Any? = obj
      var depth = 0
      while (current is Array<*>) {
        if (current.isEmpty()) {
          throw RuntimeException(
            "ONNX output contained an empty array at depth=$depth")
        }
        current = current[0]
        depth += 1
        if (depth > 8) {
          // Safety against pathological inputs; no real Piper model is
          // ever this deep.
          throw RuntimeException(
            "ONNX output unwrap depth exceeded 8; refusing to recurse further")
        }
      }
      if (current is FloatArray) return current
      throw RuntimeException(
        "ONNX output leaf is not a FloatArray (got ${current?.javaClass}); " +
        "the model's output tensor is not compatible with Piper VITS expectations")
    }
  }
}
