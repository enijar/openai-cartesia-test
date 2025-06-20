import { CartesiaClient } from "@cartesia/cartesia-js";

type TTSServiceOptions = {
  apiKey: string;
  shouldStop: () => boolean;
  audioChunks: Array<{ role: "user" | "assistant" | "model"; data: Buffer }>;
};

export class TTSService {
  private client: CartesiaClient;
  private socket: ReturnType<CartesiaClient["tts"]["websocket"]>;

  constructor(private config: TTSServiceOptions) {
    this.client = new CartesiaClient({ apiKey: this.config.apiKey });
    this.socket = this.client.tts.websocket({
      container: "raw",
      encoding: "pcm_s16le",
      sampleRate: 16000,
    });
  }

  async *speak(text: string, contextId: string, first: boolean) {
    const startTime = Date.now();
    const response = await this.socket.send({
      contextId,
      modelId: "sonic-2",
      voice: {
        mode: "id",
        id: "031851ba-cc34-422d-bfdb-cdbb7f4651ee",
      },
      transcript: text,
      continue: !first,
    });

    let firstChunk = true;
    for await (const message of response.events("message")) {
      if (this.config.shouldStop()) break;
      const json = JSON.parse(message);
      if (json.type === "chunk") {
        if (firstChunk) {
          firstChunk = false;
          console.log("tts first chunk:", Date.now() - startTime);
        }
        const buffer = Buffer.from(json.data, "base64");

        // record each assistant TTS chunk
        this.config.audioChunks.push({ role: "assistant", data: buffer });

        yield { type: "part", data: buffer } as const;
      }
    }
    console.log("tts:", Date.now() - startTime);
  }
}
