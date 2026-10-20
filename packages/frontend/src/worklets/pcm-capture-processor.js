/**
 * AudioWorklet processor: captures microphone input and outputs
 * PCM 16kHz mono Int16 chunks (3200 bytes = 100ms per chunk).
 *
 * Runs on the audio rendering thread — no DOM, no imports.
 */

const TARGET_SAMPLE_RATE = 16000
const CHUNK_SAMPLES = 1600 // 100ms at 16kHz
const BYTES_PER_SAMPLE = 2 // Int16

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buffer = new Float32Array(0)
    this._ratio = sampleRate / TARGET_SAMPLE_RATE
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0] || input[0].length === 0) return true

    const mono = input[0] // first channel

    // Downsample from source rate to 16kHz via linear interpolation
    const outLen = Math.floor(mono.length / this._ratio)
    const resampled = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * this._ratio
      const lo = Math.floor(srcIdx)
      const hi = Math.min(lo + 1, mono.length - 1)
      const frac = srcIdx - lo
      resampled[i] = mono[lo] * (1 - frac) + mono[hi] * frac
    }

    // Append to internal buffer
    const merged = new Float32Array(this._buffer.length + resampled.length)
    merged.set(this._buffer)
    merged.set(resampled, this._buffer.length)
    this._buffer = merged

    // Emit complete chunks
    while (this._buffer.length >= CHUNK_SAMPLES) {
      const chunk = this._buffer.subarray(0, CHUNK_SAMPLES)
      this._buffer = this._buffer.slice(CHUNK_SAMPLES)

      // Convert Float32 [-1,1] to Int16 [-32768,32767]
      const pcm = new Int16Array(CHUNK_SAMPLES)
      for (let i = 0; i < CHUNK_SAMPLES; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
      }

      this.port.postMessage(pcm.buffer, [pcm.buffer])
    }

    return true
  }
}

registerProcessor('pcm-capture-processor', PCMCaptureProcessor)
