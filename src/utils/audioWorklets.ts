/**
 * Off-main-thread AudioWorklet processors for Anaïs · L'Agence X.
 *
 * 1. `anais-voice-player`: Continuous 32-second FIFO ring-buffer PCM player
 *    with fractional linear upsampling (24kHz -> native hardware sampleRate),
 *    adaptive jitter pre-buffering, smooth 5ms cosine-like fade-in/out, and
 *    exact speaker-drain notification. Eliminates chunk-boundary clicks,
 *    resampler resets, GC stutters, and main-thread playback drift.
 *
 * 2. `anais-mic-capture`: Anti-aliased box-filter downsampler (native hardware
 *    sampleRate -> exact 16kHz mono PCM) emitting 1024-sample (64ms) frames
 *    off the main thread with zero-copy ArrayBuffer transfer.
 */

export const VOICE_PLAYER_WORKLET_SOURCE = `
class AnaisVoicePlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 24000 * 32; // 32 seconds at 24kHz
    this.ring = new Float32Array(this.capacity);
    this.writeIndex = 0;
    this.readPos = 0;
    this.available = 0;
    this.step = 24000 / sampleRate;

    this.basePreBuffer = Math.round(24000 * 0.15); // 150ms initial jitter cushion
    this.maxPreBuffer = Math.round(24000 * 0.26);  // 260ms max adaptive cushion
    this.preBufferTarget = this.basePreBuffer;
    this.buffering = true;
    this.turnComplete = false;
    this.hasPlayedInTurn = false;
    this.hadUnderrun = false;

    this.gain = 0;
    this.gainStep = 1 / Math.max(32, Math.round(sampleRate * 0.006)); // ~6ms smooth ramp
    this.clearing = false;
    this.isPlaying = false;
    this.silentOutputSamples = 0;
    this.endTurnSilenceCutoff = Math.max(384, Math.round(sampleRate * 0.04)); // 40ms at end of turn
    this.midTurnSilenceCutoff = Math.max(1536, Math.round(sampleRate * 0.26)); // 260ms protects natural mid-turn pauses

    this.levelSamples = 0;
    this.levelSqSum = 0;
    this.levelInterval = Math.max(512, Math.round(sampleRate * 0.085)); // ~11Hz

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'push' && msg.samples) {
        const samples = msg.samples;
        const len = samples.length;
        if (len === 0) return;

        // If a previous clear finished or new turn arrived, accept cleanly
        this.clearing = false;
        this.turnComplete = false;

        // Guard against ring overflow (keep latest audio if somehow > 32s queued)
        const freeSpace = this.capacity - Math.ceil(this.available) - 2;
        if (len > freeSpace) {
          const drop = Math.min(Math.floor(this.available), len - freeSpace);
          this.readPos = (this.readPos + drop) % this.capacity;
          this.available = Math.max(0, this.available - drop);
        }

        const firstPart = Math.min(len, this.capacity - this.writeIndex);
        this.ring.set(samples.subarray(0, firstPart), this.writeIndex);
        if (firstPart < len) {
          this.ring.set(samples.subarray(firstPart), 0);
        }
        this.writeIndex = (this.writeIndex + len) % this.capacity;
        this.available += len;
      } else if (msg.type === 'turn_complete') {
        this.turnComplete = true;
        if (this.available < this.step + 1) {
          this._finishTurnIfDrained();
        }
      } else if (msg.type === 'clear') {
        this.clearing = true;
        this.turnComplete = false;
        this.hasPlayedInTurn = false;
        this.hadUnderrun = false;
        this.preBufferTarget = this.basePreBuffer;
      }
    };
  }

  _setPlaying(active) {
    if (this.isPlaying !== active) {
      this.isPlaying = active;
      this.port.postMessage({ type: 'playing', active });
    }
  }

  _resetRing() {
    this.writeIndex = 0;
    this.readPos = 0;
    this.available = 0;
    this.buffering = true;
    this.clearing = false;
    this.silentOutputSamples = 0;
    this._setPlaying(false);
  }

  _finishTurnIfDrained() {
    this.hasPlayedInTurn = false;
    this.turnComplete = false;
    if (!this.hadUnderrun && this.preBufferTarget > this.basePreBuffer) {
      this.preBufferTarget = Math.max(
        this.basePreBuffer,
        this.preBufferTarget - 480
      );
    }
    this.hadUnderrun = false;
    this._resetRing();
    this.port.postMessage({ type: 'drained' });
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;

    const frameLen = out.length;

    if (this.clearing) {
      for (let i = 0; i < frameLen; i++) {
        this.gain = Math.max(0, this.gain - this.gainStep * 1.5);
        out[i] = 0;
      }
      if (this.gain <= 0.001) {
        this._resetRing();
      }
      return true;
    }

    // Decide whether we have enough pre-buffered audio to open the playback gate
    if (this.buffering) {
      if (
        this.available >= this.preBufferTarget ||
        (this.turnComplete && this.available >= this.step + 1)
      ) {
        this.buffering = false;
      } else if (this.turnComplete && this.available < this.step + 1) {
        for (let i = 0; i < frameLen; i++) {
          this.gain = Math.max(0, this.gain - this.gainStep);
          out[i] = 0;
        }
        if (this.gain <= 0.001) {
          this._finishTurnIfDrained();
        }
        return true;
      }
    }

    if (this.buffering) {
      for (let i = 0; i < frameLen; i++) {
        this.gain = Math.max(0, this.gain - this.gainStep);
        out[i] = 0;
      }
      if (this.gain <= 0.001) {
        this._setPlaying(false);
      }
      return true;
    }

    for (let i = 0; i < frameLen; i++) {
      if (this.available >= this.step + 1) {
        const idx0 = Math.floor(this.readPos);
        const idx1 = idx0 + 1 >= this.capacity ? 0 : idx0 + 1;
        const frac = this.readPos - idx0;
        const rawSample = this.ring[idx0] + (this.ring[idx1] - this.ring[idx0]) * frac;

        this.readPos += this.step;
        if (this.readPos >= this.capacity) {
          this.readPos -= this.capacity;
        }
        this.available -= this.step;

        this.gain = Math.min(1, this.gain + this.gainStep);
        const sample = rawSample * this.gain;
        out[i] = sample;
        this.hasPlayedInTurn = true;
        this.levelSqSum += sample * sample;
        this.levelSamples += 1;

        if (Math.abs(sample) >= 0.014) {
          this.silentOutputSamples = 0;
          this._setPlaying(true);
        } else {
          this.silentOutputSamples += 1;
          const cutoff = this.turnComplete
            ? this.endTurnSilenceCutoff
            : this.midTurnSilenceCutoff;
          if (this.silentOutputSamples >= cutoff) {
            this._setPlaying(false);
          }
        }
      } else {
        // Buffer ran dry: fade out smoothly with zero click
        this.gain = Math.max(0, this.gain - this.gainStep);
        out[i] = 0;

        if (this.gain <= 0.001) {
          this._setPlaying(false);
          if (this.turnComplete) {
            this._finishTurnIfDrained();
          } else if (this.hasPlayedInTurn) {
            // Buffer emptied before turn_complete arrived: pause cleanly and unlock mic
            this.buffering = true;
            this.hadUnderrun = true;
            this.preBufferTarget = Math.min(
              this.maxPreBuffer,
              this.preBufferTarget + 960 // +40ms
            );
          }
        }
      }
    }

    if (this.levelSamples >= this.levelInterval) {
      const rms = Math.sqrt(this.levelSqSum / this.levelSamples);
      this.levelSqSum = 0;
      this.levelSamples = 0;
      this.port.postMessage({ type: 'level', rms });
    }

    return true;
  }
}

registerProcessor('anais-voice-player', AnaisVoicePlayerProcessor);
`;

export const MIC_CAPTURE_WORKLET_SOURCE = `
class AnaisMicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    this.frameSize = 1024;
    this.outBuffer = new Float32Array(this.frameSize);
    this.outOffset = 0;
    this.acc = 0;
    this.accCount = 0;
    this.phase = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;

    if (Math.abs(this.ratio - 1) < 0.001) {
      for (let i = 0; i < input.length; i++) {
        this.outBuffer[this.outOffset++] = input[i];
        if (this.outOffset >= this.frameSize) {
          const frame = this.outBuffer;
          this.port.postMessage(frame, [frame.buffer]);
          this.outBuffer = new Float32Array(this.frameSize);
          this.outOffset = 0;
        }
      }
      return true;
    }

    // Anti-aliased box-filter downsampling from hardware sampleRate -> 16000Hz
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.accCount += 1;
      this.phase += 1;

      if (this.phase >= this.ratio) {
        this.outBuffer[this.outOffset++] = this.acc / this.accCount;
        this.phase -= this.ratio;
        this.acc = 0;
        this.accCount = 0;

        if (this.outOffset >= this.frameSize) {
          const frame = this.outBuffer;
          this.port.postMessage(frame, [frame.buffer]);
          this.outBuffer = new Float32Array(this.frameSize);
          this.outOffset = 0;
        }
      }
    }

    return true;
  }
}

registerProcessor('anais-mic-capture', AnaisMicCaptureProcessor);
`;
