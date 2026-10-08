// AudioWorklet: mono, 16 kHz, 16-bit PCM for the transcript, posted every 100 ms.
// Runs beside the recording (never in its path), so a hiccup here can't hurt the video.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // input samples per output sample
    this.next = 0;   // input position of the next output sample
    this.index = 0;  // input position of the current sample
    this.prev = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const a = input[0], b = input[1];
    for (let i = 0; i < a.length; i++) {
      const x = b ? (a[i] + b[i]) * 0.5 : a[i];
      // Linear interpolation between the previous and this sample.
      while (this.next <= this.index) {
        const frac = 1 - (this.index - this.next);
        const v = this.prev + (x - this.prev) * frac;
        this.out[this.n++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        if (this.n === this.out.length) {
          this.port.postMessage(this.out, [this.out.buffer]);
          this.out = new Int16Array(1600);
          this.n = 0;
        }
        this.next += this.ratio;
      }
      this.prev = x;
      this.index += 1;
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
