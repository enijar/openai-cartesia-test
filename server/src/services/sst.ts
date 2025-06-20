import { CartesiaClient } from "@cartesia/cartesia-js";

type STTServiceOptions = {
  apiKey: string;
  shouldStop: () => boolean;
  audioChunks: Array<{ role: "user" | "assistant" | "model"; data: Buffer }>;
};

export class STTService {
  private client: CartesiaClient;
  private socket: ReturnType<CartesiaClient["stt"]["websocket"]>;

  constructor(private config: STTServiceOptions) {
    this.client = new CartesiaClient({ apiKey: this.config.apiKey });
    this.socket = this.client.stt.websocket({
      model: "ink-whisper",
      language: "en",
      encoding: "pcm_s16le",
      sampleRate: 16000,
    });
  }

  async transcribe(buffer: Buffer): Promise<string> {
    this.config.audioChunks.push({ role: "user", data: buffer });

    return new Promise<string>(async (resolve) => {
      const parts: string[] = [];
      const startTime = Date.now();
      await this.socket.onMessage(async (message) => {
        switch (message.type) {
          case "transcript":
            parts.push(message.text ?? "");
            break;
          case "flush_done":
            await this.socket.done();
            break;
          case "done":
            console.log("stt:", Date.now() - startTime);
            resolve(parts.join("").trim());
            break;
        }
      });

      const chunkSize = 3200;
      for (let i = 0; i < buffer.length; i += chunkSize) {
        if (this.config.shouldStop()) break;
        const chunk = buffer.subarray(i, i + chunkSize);
        const arrayBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        await this.socket.send(arrayBuffer as ArrayBuffer);
      }
      await this.socket.finalize();
    });
  }

  async getAudioChunks(): Promise<Buffer[]> {
    return this.config.audioChunks.map((chunk) => chunk.data);
  }
}
