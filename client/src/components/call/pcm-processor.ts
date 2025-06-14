interface ProcessorOptions {
  processorOptions: {
    ringBufferLength: number;
  };
}

class PCMProcessor extends AudioWorkletProcessor {
  private readonly ring: Float32Array;
  private write = 0;
  private read = 0;

  constructor(options?: ProcessorOptions) {
    super();
    const length = options?.processorOptions?.ringBufferLength ?? 48000 * 10;
    this.ring = new Float32Array(length);
    this.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const chunk = event.data;
      const ring = this.ring;
      const write = this.write;
      const len = ring.length;
      const tail = len - write;
      if (chunk.length <= tail) {
        ring.set(chunk, write);
      } else {
        ring.set(chunk.subarray(0, tail), write);
        ring.set(chunk.subarray(tail), 0);
      }
      this.write = (write + chunk.length) % len;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], _params: Record<string, Float32Array>): boolean {
    const output = outputs[0];
    for (let channel = 0; channel < output.length; channel++) {
      const outChan = output[channel];
      for (let i = 0; i < outChan.length; i++) {
        if (this.read !== this.write) {
          outChan[i] = this.ring[this.read];
          this.read = (this.read + 1) % this.ring.length;
        } else {
          outChan[i] = 0; // underrun
        }
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor("pcm-processor", PCMProcessor);
