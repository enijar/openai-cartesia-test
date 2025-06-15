export default class AudioPlayer {
  private readonly audioCtx: AudioContext;
  private readonly bufferSeconds: number;
  private node!: AudioWorkletNode;

  constructor(
    private sampleRate: number = 16000,
    bufferSeconds: number = 10,
  ) {
    this.audioCtx = new AudioContext({ sampleRate: this.sampleRate });
    this.bufferSeconds = bufferSeconds;
  }

  /** Internal helper to (re)create the worklet node & ring buffer */
  private async createNode() {
    // If first time, we need to register the processor
    if (!this.node) {
      await this.audioCtx.audioWorklet.addModule(new URL("./pcm-processor.js", import.meta.url).href);
    }

    // Disconnect old node (if any) and make a fresh one
    if (this.node) {
      this.node.disconnect();
    }
    this.node = new AudioWorkletNode(this.audioCtx, "pcm-processor", {
      processorOptions: {
        ringBufferLength: this.sampleRate * this.bufferSeconds,
      },
    });
    this.node.connect(this.audioCtx.destination);
  }

  /** Must be called once before using enqueue/play */
  async init(): Promise<void> {
    await this.createNode();
  }

  /** Feed the worklet a Float32Array of PCM samples */
  enqueue(chunk: Float32Array): void {
    this.node.port.postMessage(chunk);
  }

  /** Start playback */
  async play(): Promise<void> {
    if (this.audioCtx.state !== "running") {
      await this.audioCtx.resume();
    }
  }

  /** Pause playback (keeps buffer intact) */
  async pause(): Promise<void> {
    if (this.audioCtx.state === "running") {
      await this.audioCtx.suspend();
    }
  }

  /**
   * Fully stop + clear any buffered chunks.
   * Call this when you want to interrupt the current stream and start fresh.
   */
  async stop(): Promise<void> {
    // 1. Pause audio
    await this.pause();

    // 2. Recreate the worklet node (flushes its ring buffer)
    await this.createNode();
  }
}
